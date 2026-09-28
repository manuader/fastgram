"use client";

/**
 * `GET/POST /reels/plan` — sprint 9 (U), `PU-S9-014`: el plan de reels de la
 * semana de la marca activa y el pedido de «Plan this week's reels now».
 */
import {
  reelPlanRequestedSchema,
  reelPlanViewSchema,
  type ReelPlanView,
} from "@fastgram/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";

export const REEL_PLAN_PATH = "reels/plan";
export const reelPlanKeys = { current: () => ["reels", "plan"] as const };

/**
 * Mientras se está armando un plan (un pedido reciente, o ítems sin idea
 * todavía), se vuelve a preguntar cada 10 s: armar 7 reels con un modelo local
 * lleva minutos.
 */
export const REEL_PLAN_POLL_MS = 10_000;

export function useReelPlan(polling: boolean) {
  return useApiQuery<ReelPlanView>({
    queryKey: reelPlanKeys.current(),
    path: REEL_PLAN_PATH,
    schema: reelPlanViewSchema,
    refetchInterval: polling ? REEL_PLAN_POLL_MS : false,
  });
}

export function useRequestReelPlan() {
  const queryClient = useQueryClient();
  return useMutation<{ requested: true }, ApiRequestError, void>({
    mutationFn: () =>
      apiRequest<{ requested: true }>(REEL_PLAN_PATH, {
        method: "POST",
        body: {},
        schema: reelPlanRequestedSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: reelPlanKeys.current() });
    },
  });
}
