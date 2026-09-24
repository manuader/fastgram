"use client";

/**
 * Hooks de los formatos con voz y del character swap — sprint 8 (agente L),
 * `P4-FORMAT-002`, `P4-INFL-011`. Contrato:
 * `packages/contracts/src/resources/speaking.ts`.
 *
 * Las claves cuelgan de `["ai-studio", …]`: cambiar de marca las invalida con
 * el resto.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  speakingOptionsSchema,
  speakingRunListSchema,
  speakingRunSchema,
  speakingScriptSchema,
  voiceRunEstimateSchema,
  type SpeakingOptions,
  type SpeakingRun,
  type SpeakingRunRequest,
  type SpeakingScript,
  type SpeakingScriptRequest,
  type SwapRunRequest,
  type VoiceRunEstimate,
} from "@fastgram/contracts";

import { apiRequest } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";
import { budgetKeys } from "@/lib/models/budget";

export const speakingKeys = {
  options: () => ["ai-studio", "speaking", "options"] as const,
  estimate: (target: string, body: unknown) =>
    ["ai-studio", "speaking", target, "estimate", body] as const,
  run: (id: string) => ["ai-studio", "speaking-runs", id] as const,
  runs: (characterModelId: string | null) =>
    ["ai-studio", "speaking-runs", "list", characterModelId ?? "all"] as const,
};

/** Mientras la corrida no termina, se vuelve a pedir: voz + video tardan minutos. */
export const SPEAKING_POLL_MS = 5_000;

export function isSpeakingRunInFlight(run: Pick<SpeakingRun, "stage">): boolean {
  return (
    run.stage === "queued" ||
    run.stage === "voice" ||
    run.stage === "video" ||
    run.stage === "building"
  );
}

export function useSpeakingOptions(): UseQueryResult<SpeakingOptions, ApiRequestError> {
  return useApiQuery<SpeakingOptions>({
    queryKey: speakingKeys.options(),
    path: "/ai-studio/speaking/options",
    schema: speakingOptionsSchema,
  });
}

/** `target` = el id del formato con voz, o `"swap"`. */
function estimatePath(target: string): string {
  return target === "swap"
    ? "/ai-studio/swap/estimate"
    : `/ai-studio/speaking/${encodeURIComponent(target)}/estimate`;
}

function runsPath(target: string, source?: "studio" | "influencer"): string {
  const base =
    target === "swap"
      ? "/ai-studio/swap/runs"
      : `/ai-studio/speaking/${encodeURIComponent(target)}/runs`;
  return source === "influencer" ? `${base}?source=influencer` : base;
}

export function useVoiceEstimate(
  target: string,
  body: SpeakingRunRequest | SwapRunRequest | null,
): UseQueryResult<VoiceRunEstimate, ApiRequestError> {
  return useQuery<VoiceRunEstimate, ApiRequestError>({
    queryKey:
      body === null
        ? ["ai-studio", "speaking", target, "estimate", "none"]
        : speakingKeys.estimate(target, body),
    queryFn: ({ signal }) =>
      apiRequest<VoiceRunEstimate>(estimatePath(target), {
        method: "POST",
        body,
        signal,
        schema: voiceRunEstimateSchema,
      }),
    enabled: body !== null,
    staleTime: 60_000,
    retry: false,
  });
}

export function useStartVoiceRun(
  target: string,
  source: "studio" | "influencer" = "studio",
): UseMutationResult<SpeakingRun, ApiRequestError, SpeakingRunRequest | SwapRunRequest> {
  const queryClient = useQueryClient();
  return useMutation<SpeakingRun, ApiRequestError, SpeakingRunRequest | SwapRunRequest>({
    mutationFn: (body) =>
      apiRequest<SpeakingRun>(runsPath(target, source), {
        method: "POST",
        body,
        schema: speakingRunSchema,
      }),
    onSuccess: (run) => {
      queryClient.setQueryData(speakingKeys.run(run.id), run);
      void queryClient.invalidateQueries({ queryKey: ["ai-studio", "speaking-runs"] });
      void queryClient.invalidateQueries({ queryKey: budgetKeys.summary() });
    },
  });
}

export function useGenerateScript(
  formatId: string,
): UseMutationResult<SpeakingScript, ApiRequestError, SpeakingScriptRequest> {
  return useMutation<SpeakingScript, ApiRequestError, SpeakingScriptRequest>({
    mutationFn: (body) =>
      apiRequest<SpeakingScript>(
        `/ai-studio/speaking/${encodeURIComponent(formatId)}/script`,
        { method: "POST", body, schema: speakingScriptSchema },
      ),
  });
}

export function useSpeakingRun(
  id: string | null,
): UseQueryResult<SpeakingRun, ApiRequestError> {
  return useApiQuery<SpeakingRun>({
    queryKey: speakingKeys.run(id ?? "none"),
    path: `/ai-studio/speaking-runs/${encodeURIComponent(id ?? "none")}`,
    schema: speakingRunSchema,
    enabled: id !== null,
    refetchInterval: (q) =>
      q.state.data !== undefined && isSpeakingRunInFlight(q.state.data)
        ? SPEAKING_POLL_MS
        : false,
  });
}

export function useSpeakingRuns(
  characterModelId: string | null,
): UseQueryResult<readonly SpeakingRun[], ApiRequestError> {
  return useApiQuery<readonly SpeakingRun[]>({
    queryKey: speakingKeys.runs(characterModelId),
    path: "/ai-studio/speaking-runs",
    query: {
      limit: 20,
      ...(characterModelId === null ? {} : { characterModelId }),
    },
    schema: speakingRunListSchema,
    refetchInterval: (q) =>
      q.state.data?.some(isSpeakingRunInFlight) === true ? SPEAKING_POLL_MS : false,
  });
}
