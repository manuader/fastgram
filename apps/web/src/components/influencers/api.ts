"use client";

/**
 * Hooks del sprint 7 (agente G) para influencers: Configuration, templates,
 * imagen base por texto y video del personaje. Viven con los componentes que
 * los usan; los de siempre siguen en `@/lib/influencers/api`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  generationEstimateSchema,
  generationSchema,
  influencerConfigViewSchema,
  influencerGenerationSchema,
  influencerImageEstimateSchema,
  influencerSchema,
  influencerTemplatesViewSchema,
  type CreateInfluencerRequest,
  type Generation,
  type GenerationEstimate,
  type InfluencerBaseImageRequest,
  type InfluencerConfigView,
  type InfluencerGeneration,
  type InfluencerImageEstimate,
  type InfluencerTemplate,
  type InfluencerTemplatesView,
  type InfluencerVideoRequest,
  type UpdateInfluencerConfigRequest,
} from "@fastgram/contracts";

import { apiRequest } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";
import { influencerKeys, INFLUENCERS_PATH } from "@/lib/influencers/api";
import type { InfluencerView } from "@/lib/influencers/form";
import { budgetKeys } from "@/lib/models/budget";

const influencerViewSchema = influencerSchema.partial({ baseImageUrl: true });

export const studioKeys = {
  templates: () => ["influencers", "templates"] as const,
  config: (id: string) => ["influencers", id, "config"] as const,
  baseEstimate: (body: InfluencerBaseImageRequest) =>
    ["influencers", "base-image", "estimate", body] as const,
  baseGeneration: (id: string) => ["ai-studio", "generations", id] as const,
  videoEstimate: (id: string, body: InfluencerVideoRequest) =>
    ["influencers", id, "videos", "estimate", body] as const,
};

const path = (id: string, rest = ""): string =>
  `${INFLUENCERS_PATH}/${encodeURIComponent(id)}${rest}`;

/* ── Templates ── */

export function useInfluencerTemplates(): UseQueryResult<
  InfluencerTemplatesView,
  ApiRequestError
> {
  return useApiQuery<InfluencerTemplatesView>({
    queryKey: studioKeys.templates(),
    path: `${INFLUENCERS_PATH}/templates`,
    schema: influencerTemplatesViewSchema,
  });
}

export function useSaveTemplates(): UseMutationResult<
  InfluencerTemplatesView,
  ApiRequestError,
  readonly InfluencerTemplate[] | null
> {
  const queryClient = useQueryClient();
  return useMutation<
    InfluencerTemplatesView,
    ApiRequestError,
    readonly InfluencerTemplate[] | null
  >({
    mutationFn: (templates) =>
      apiRequest<InfluencerTemplatesView>(`${INFLUENCERS_PATH}/templates`, {
        method: "PUT",
        body: { templates: templates === null ? null : [...templates] },
        schema: influencerTemplatesViewSchema,
      }),
    onSuccess: (view) => {
      queryClient.setQueryData(studioKeys.templates(), view);
    },
  });
}

/* ── Configuration ── */

export function useInfluencerConfig(
  id: string,
): UseQueryResult<InfluencerConfigView, ApiRequestError> {
  return useApiQuery<InfluencerConfigView>({
    queryKey: studioKeys.config(id),
    path: path(id, "/config"),
    schema: influencerConfigViewSchema,
  });
}

export function useSaveInfluencerConfig(
  id: string,
): UseMutationResult<
  InfluencerConfigView,
  ApiRequestError,
  UpdateInfluencerConfigRequest
> {
  const queryClient = useQueryClient();
  return useMutation<
    InfluencerConfigView,
    ApiRequestError,
    UpdateInfluencerConfigRequest
  >({
    mutationFn: (body) =>
      apiRequest<InfluencerConfigView>(path(id, "/config"), {
        method: "PUT",
        body,
        schema: influencerConfigViewSchema,
      }),
    onSuccess: (view) => {
      queryClient.setQueryData(studioKeys.config(id), view);
    },
  });
}

/* ── Imagen base por texto ── */

export function useBaseImageEstimate(
  body: InfluencerBaseImageRequest | null,
): UseQueryResult<GenerationEstimate, ApiRequestError> {
  return useQuery<GenerationEstimate, ApiRequestError>({
    queryKey:
      body === null
        ? ["influencers", "base-image", "estimate", "none"]
        : studioKeys.baseEstimate(body),
    queryFn: ({ signal }) =>
      apiRequest<GenerationEstimate>(`${INFLUENCERS_PATH}/base-image/estimate`, {
        method: "POST",
        body,
        signal,
        schema: generationEstimateSchema,
      }),
    enabled: body !== null,
    staleTime: 60_000,
    retry: false,
  });
}

export function useGenerateBaseImage(): UseMutationResult<
  Generation,
  ApiRequestError,
  InfluencerBaseImageRequest
> {
  const queryClient = useQueryClient();
  return useMutation<Generation, ApiRequestError, InfluencerBaseImageRequest>({
    mutationFn: (body) =>
      apiRequest<Generation>(`${INFLUENCERS_PATH}/base-image`, {
        method: "POST",
        body,
        schema: generationSchema,
      }),
    onSuccess: (g) => {
      queryClient.setQueryData(studioKeys.baseGeneration(g.id), g);
      void queryClient.invalidateQueries({ queryKey: budgetKeys.summary() });
    },
  });
}

export const BASE_POLL_MS = 3_000;

/** La generación de la base (es una de AI Studio), hasta que termina. */
export function useBaseGeneration(
  id: string | null,
): UseQueryResult<Generation, ApiRequestError> {
  return useApiQuery<Generation>({
    queryKey: studioKeys.baseGeneration(id ?? "none"),
    path: `/ai-studio/generations/${encodeURIComponent(id ?? "none")}`,
    schema: generationSchema,
    enabled: id !== null,
    refetchInterval: (q) =>
      q.state.data !== undefined &&
      (q.state.data.status === "queued" || q.state.data.status === "generating")
        ? BASE_POLL_MS
        : false,
  });
}

/** `POST /influencers` con el cuerpo ya armado (fotos, base generada, regenerar). */
export function useCreateInfluencerFrom(): UseMutationResult<
  InfluencerView,
  ApiRequestError,
  { readonly body: CreateInfluencerRequest; readonly idempotencyKey: string }
> {
  const queryClient = useQueryClient();
  return useMutation<
    InfluencerView,
    ApiRequestError,
    { readonly body: CreateInfluencerRequest; readonly idempotencyKey: string }
  >({
    mutationFn: ({ body, idempotencyKey }) =>
      apiRequest<InfluencerView>(INFLUENCERS_PATH, {
        method: "POST",
        body,
        idempotencyKey,
        schema: influencerViewSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: influencerKeys.list() });
    },
  });
}

/* ── Video del personaje ── */

export function useVideoEstimate(
  id: string,
  body: InfluencerVideoRequest | null,
): UseQueryResult<InfluencerImageEstimate, ApiRequestError> {
  return useQuery<InfluencerImageEstimate, ApiRequestError>({
    queryKey:
      body === null
        ? ["influencers", id, "videos", "estimate", "none"]
        : studioKeys.videoEstimate(id, body),
    queryFn: ({ signal }) =>
      apiRequest<InfluencerImageEstimate>(path(id, "/videos/estimate"), {
        method: "POST",
        body,
        signal,
        schema: influencerImageEstimateSchema,
      }),
    enabled: body !== null,
    staleTime: 60_000,
    retry: false,
  });
}

export function useGenerateVideo(
  id: string,
): UseMutationResult<InfluencerGeneration, ApiRequestError, InfluencerVideoRequest> {
  const queryClient = useQueryClient();
  return useMutation<InfluencerGeneration, ApiRequestError, InfluencerVideoRequest>({
    mutationFn: (body) =>
      apiRequest<InfluencerGeneration>(path(id, "/videos"), {
        method: "POST",
        body,
        schema: influencerGenerationSchema,
      }),
    onSuccess: (created) => {
      queryClient.setQueryData<InfluencerGeneration[]>(
        influencerKeys.generations(id),
        (old) => [created, ...(old ?? []).filter((g) => g.id !== created.id)],
      );
      void queryClient.invalidateQueries({ queryKey: influencerKeys.generations(id) });
      void queryClient.invalidateQueries({ queryKey: budgetKeys.summary() });
    },
  });
}
