"use client";

/**
 * El tope mensual de generación — `PU-MODEL-005`. Lo usan Settings → Models
 * (editarlo) y AI Studio (mostrar cuánto queda).
 *
 * Las claves cuelgan de `["models"]`: invalidar el prefijo alcanza a todo lo
 * de modelos, y AI Studio también invalida el presupuesto al generar.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import {
  budgetSummarySchema,
  type BudgetSummary,
  type UpdateBudgetRequest,
} from "@fastgram/contracts";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";

export const BUDGET_PATH = "/models/budget";

export const budgetKeys = {
  summary: () => ["models", "budget"] as const,
};

export function useBudget(): UseQueryResult<BudgetSummary, ApiRequestError> {
  return useApiQuery<BudgetSummary>({
    queryKey: budgetKeys.summary(),
    path: BUDGET_PATH,
    schema: budgetSummarySchema,
  });
}

export function useSaveBudget(): UseMutationResult<
  BudgetSummary,
  ApiRequestError,
  UpdateBudgetRequest
> {
  const queryClient = useQueryClient();
  return useMutation<BudgetSummary, ApiRequestError, UpdateBudgetRequest>({
    mutationFn: (body) =>
      apiRequest<BudgetSummary>(BUDGET_PATH, {
        method: "PUT",
        body,
        schema: budgetSummarySchema,
      }),
    onSuccess: (summary) => {
      queryClient.setQueryData(budgetKeys.summary(), summary);
      // AI Studio muestra el mismo presupuesto dentro de sus opciones.
      void queryClient.invalidateQueries({ queryKey: ["ai-studio", "options"] });
    },
  });
}

/** `$1,234.50`; con centavos de centavo si el monto es chico (`$0.0031`). */
export function formatUsd(value: number): string {
  const small = value > 0 && value < 0.01;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(value);
}

/** Qué fracción del tope está usada (cobrado + en vuelo), entre 0 y 1. */
export function budgetUsedFraction(summary: BudgetSummary): number {
  if (summary.budgetUsd <= 0) return 1;
  return Math.min(1, (summary.chargedUsd + summary.reservedUsd) / summary.budgetUsd);
}

/** Texto del input → monto, o `null` si no es un monto en dólares válido. */
export function parseBudgetInput(raw: string): number | null {
  const value = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n <= 100_000 ? n : null;
}
