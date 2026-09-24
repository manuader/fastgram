"use client";

/**
 * Los datos de `/analytics` · `P3-ANALYT-001/002`, `PU-AUTO-004`.
 *
 * | Qué                              | De dónde                                 | Alcance            |
 * |----------------------------------|------------------------------------------|--------------------|
 * | totales, desglose, top posts     | `GET /analytics/summary?days&brands`     | activa o todas     |
 * | pesos, auto-tune e historial     | `GET /analytics/mix`                     | marca activa       |
 * | prender/apagar el auto-tune      | `PUT /analytics/mix/autotune`            | marca activa       |
 * | sincronizar ya                   | `POST /analytics/sync`                   | marca activa       |
 *
 * Las claves cuelgan de `["analytics", …]`: cambiar de marca las resetea
 * (`WorkspaceProvider`), y un toggle del auto-tune sólo invalida lo suyo.
 */
import {
  analyticsMixSchema,
  analyticsSummarySchema,
  analyticsSyncResponseSchema,
  mixAutotuneSchema,
  type AnalyticsMix,
  type AnalyticsSummary,
  type AnalyticsSyncResponse,
  type MixAutotune,
} from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";

export type AnalyticsScope = "current" | "all";

export const analyticsKeys = {
  summary: (days: number, scope: AnalyticsScope) =>
    ["analytics", "summary", days, scope] as const,
  mix: () => ["analytics", "mix"] as const,
};

export const ANALYTICS_SUMMARY_PATH = "analytics/summary";
export const ANALYTICS_MIX_PATH = "analytics/mix";
export const ANALYTICS_AUTOTUNE_PATH = "analytics/mix/autotune";
export const ANALYTICS_SYNC_PATH = "analytics/sync";

/** Cada 5 min: el sync corre cada hora, más seguido no trae nada nuevo. */
export const ANALYTICS_REFRESH_MS = 5 * 60_000;

export function useAnalyticsSummary(
  days: number,
  scope: AnalyticsScope,
): UseQueryResult<AnalyticsSummary, ApiRequestError> {
  return useApiQuery<AnalyticsSummary>({
    queryKey: analyticsKeys.summary(days, scope),
    path: ANALYTICS_SUMMARY_PATH,
    query: { days, brands: scope },
    schema: analyticsSummarySchema,
    refetchInterval: ANALYTICS_REFRESH_MS,
  });
}

export function useAnalyticsMix(): UseQueryResult<AnalyticsMix, ApiRequestError> {
  return useApiQuery<AnalyticsMix>({
    queryKey: analyticsKeys.mix(),
    path: ANALYTICS_MIX_PATH,
    schema: analyticsMixSchema,
  });
}

export function useSetAutotune(): UseMutationResult<
  MixAutotune,
  ApiRequestError,
  boolean
> {
  const queryClient = useQueryClient();
  return useMutation<MixAutotune, ApiRequestError, boolean>({
    mutationFn: (enabled) =>
      apiRequest<MixAutotune>(ANALYTICS_AUTOTUNE_PATH, {
        method: "PUT",
        body: { enabled },
        schema: mixAutotuneSchema,
      }),
    onSuccess: (autotune) => {
      queryClient.setQueryData<AnalyticsMix>(analyticsKeys.mix(), (current) =>
        current === undefined ? current : { ...current, autotune },
      );
      void queryClient.invalidateQueries({ queryKey: analyticsKeys.mix() });
    },
  });
}

export function useRequestSync(): UseMutationResult<
  AnalyticsSyncResponse,
  ApiRequestError,
  void
> {
  return useMutation<AnalyticsSyncResponse, ApiRequestError, void>({
    mutationFn: () =>
      apiRequest<AnalyticsSyncResponse>(ANALYTICS_SYNC_PATH, {
        method: "POST",
        schema: analyticsSyncResponseSchema,
      }),
  });
}
