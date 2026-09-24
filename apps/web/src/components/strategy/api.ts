"use client";

/**
 * `GET/PUT /strategy` — `PU-BRAND-002`. La marca es la de la cookie (el proxy
 * la convierte en `X-Fastgram-Workspace`), así que la clave no la lleva: al
 * cambiar de marca el shell resetea todo lo que no es de la lista de marcas.
 */
import {
  strategySchema,
  type Strategy,
  type UpdateStrategyRequest,
} from "@fastgram/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";

export const STRATEGY_PATH = "strategy";
export const strategyKeys = { current: () => ["strategy"] as const };

export function useStrategy() {
  return useApiQuery<Strategy>({
    queryKey: strategyKeys.current(),
    path: STRATEGY_PATH,
    schema: strategySchema,
  });
}

export function useSaveStrategy() {
  const queryClient = useQueryClient();
  return useMutation<Strategy, ApiRequestError, UpdateStrategyRequest>({
    mutationFn: (body) =>
      apiRequest<Strategy>(STRATEGY_PATH, {
        method: "PUT",
        body,
        schema: strategySchema,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(strategyKeys.current(), saved);
      // La zona de la marca puede haber cambiado: el calendario dibuja con ella.
      void queryClient.invalidateQueries({ queryKey: ["posts", "calendar"] });
    },
  });
}
