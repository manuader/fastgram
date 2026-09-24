"use client";

/**
 * Hooks de los formatos generativos — sprint 7 (agente G), `P4-FORMAT-001`.
 *
 * Viven con el componente (y no en `lib/`) porque son sólo de él. Las claves
 * cuelgan de `["ai-studio", …]`: cambiar de marca las invalida con el resto.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  formatRunEstimateSchema,
  formatRunSchema,
  generativeFormatsViewSchema,
  type FormatRun,
  type FormatRunEstimate,
  type FormatRunRequest,
  type GenerativeFormatsView,
} from "@fastgram/contracts";

import { apiRequest } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";
import { budgetKeys } from "@/lib/models/budget";

export const formatKeys = {
  view: () => ["ai-studio", "formats"] as const,
  estimate: (format: string, body: FormatRunRequest) =>
    ["ai-studio", "formats", format, "estimate", body] as const,
  run: (id: string) => ["ai-studio", "format-runs", id] as const,
};

/** Mientras la corrida no termina, se vuelve a pedir: el clip tarda minutos. */
export const RUN_POLL_MS = 4_000;

export function isRunInFlight(run: Pick<FormatRun, "status">): boolean {
  return (
    run.status === "queued" || run.status === "generating" || run.status === "building"
  );
}

export function useGenerativeFormats(): UseQueryResult<
  GenerativeFormatsView,
  ApiRequestError
> {
  return useApiQuery<GenerativeFormatsView>({
    queryKey: formatKeys.view(),
    path: "/ai-studio/formats",
    schema: generativeFormatsViewSchema,
  });
}

export function useFormatEstimate(
  format: string,
  body: FormatRunRequest | null,
): UseQueryResult<FormatRunEstimate, ApiRequestError> {
  return useQuery<FormatRunEstimate, ApiRequestError>({
    queryKey:
      body === null
        ? ["ai-studio", "formats", format, "estimate", "none"]
        : formatKeys.estimate(format, body),
    queryFn: ({ signal }) =>
      apiRequest<FormatRunEstimate>(
        `/ai-studio/formats/${encodeURIComponent(format)}/estimate`,
        { method: "POST", body, signal, schema: formatRunEstimateSchema },
      ),
    enabled: body !== null,
    staleTime: 60_000,
    retry: false,
  });
}

export function useStartFormatRun(
  format: string,
): UseMutationResult<FormatRun, ApiRequestError, FormatRunRequest> {
  const queryClient = useQueryClient();
  return useMutation<FormatRun, ApiRequestError, FormatRunRequest>({
    mutationFn: (body) =>
      apiRequest<FormatRun>(`/ai-studio/formats/${encodeURIComponent(format)}/runs`, {
        method: "POST",
        body,
        schema: formatRunSchema,
      }),
    onSuccess: (run) => {
      queryClient.setQueryData(formatKeys.run(run.id), run);
      void queryClient.invalidateQueries({ queryKey: formatKeys.view() });
      void queryClient.invalidateQueries({ queryKey: budgetKeys.summary() });
    },
  });
}

export function useFormatRun(
  id: string | null,
): UseQueryResult<FormatRun, ApiRequestError> {
  return useApiQuery<FormatRun>({
    queryKey: formatKeys.run(id ?? "none"),
    path: `/ai-studio/format-runs/${encodeURIComponent(id ?? "none")}`,
    schema: formatRunSchema,
    enabled: id !== null,
    refetchInterval: (q) =>
      q.state.data !== undefined && isRunInFlight(q.state.data) ? RUN_POLL_MS : false,
  });
}
