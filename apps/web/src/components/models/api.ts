"use client";

/**
 * Hooks de la biblioteca de modelos — sprint 8 (agente K).
 *
 * Las rutas son **del dueño** (`/character-models…`): la API ignora la marca
 * activa, y las que actúan sobre una marca llevan `brandId` en el cuerpo o la
 * query. Por eso las claves no dependen de la marca activa.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  characterModelListSchema,
  characterModelSchema,
  characterModelSetupSchema,
  influencerGenerationListSchema,
  influencerGenerationSchema,
  influencerImageEstimateSchema,
  mediaSchema,
  type CharacterModel,
  type CharacterModelSetup,
  type CharacterUgcAnimateRequest,
  type CharacterUgcImageRequest,
  type CharacterUgcPieceRequest,
  type CreateCharacterModelRequest,
  type InfluencerGeneration,
  type InfluencerImageEstimate,
  type Media,
  type UpdateCharacterModelRequest,
} from "@fastgram/contracts";
import { z } from "zod";

import { apiRequest, apiSend } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";
import { newIdempotencyKey } from "@/lib/api/idempotency-key";
import { budgetKeys } from "@/lib/models/budget";

export const MODELS_PATH = "/character-models";
export const MODEL_TRAINING_POLL_MS = 5_000;
export const UGC_POLL_MS = 4_000;

export const modelKeys = {
  all: () => ["character-models"] as const,
  list: () => ["character-models", "list"] as const,
  setup: () => ["character-models", "setup"] as const,
  one: (id: string) => ["character-models", id] as const,
  ugc: (id: string, brandId: string) => ["character-models", id, "ugc", brandId] as const,
  brandMedia: (brandId: string) => ["character-models", "brand-media", brandId] as const,
  estimate: (id: string, body: CharacterUgcImageRequest) =>
    ["character-models", id, "ugc-estimate", body] as const,
  animateEstimate: (id: string, body: CharacterUgcAnimateRequest) =>
    ["character-models", id, "animate-estimate", body] as const,
};

const path = (id: string, rest = ""): string =>
  `${MODELS_PATH}/${encodeURIComponent(id)}${rest}`;

export function isTraining(model: Pick<CharacterModel, "status">): boolean {
  return model.status === "training";
}

export function useCharacterModels(): UseQueryResult<CharacterModel[], ApiRequestError> {
  return useApiQuery<CharacterModel[]>({
    queryKey: modelKeys.list(),
    path: MODELS_PATH,
    schema: characterModelListSchema,
    refetchInterval: (q) =>
      q.state.data?.some(isTraining) === true ? MODEL_TRAINING_POLL_MS : false,
  });
}

export function useCharacterModel(
  id: string,
): UseQueryResult<CharacterModel, ApiRequestError> {
  return useApiQuery<CharacterModel>({
    queryKey: modelKeys.one(id),
    path: path(id),
    schema: characterModelSchema,
    refetchInterval: (q) =>
      q.state.data !== undefined && isTraining(q.state.data)
        ? MODEL_TRAINING_POLL_MS
        : false,
  });
}

export function useCharacterModelSetup(): UseQueryResult<
  CharacterModelSetup,
  ApiRequestError
> {
  return useApiQuery<CharacterModelSetup>({
    queryKey: modelKeys.setup(),
    path: `${MODELS_PATH}/setup`,
    schema: characterModelSetupSchema,
  });
}

function useSetModel() {
  const queryClient = useQueryClient();
  return (model: CharacterModel) => {
    queryClient.setQueryData(modelKeys.one(model.id), model);
    void queryClient.invalidateQueries({ queryKey: modelKeys.list() });
    // La fila del modelo en cada marca cambió (nombre, activa…).
    void queryClient.invalidateQueries({ queryKey: ["influencers"] });
  };
}

export function useImportModel(): UseMutationResult<
  CharacterModel,
  ApiRequestError,
  { readonly body: CreateCharacterModelRequest; readonly idempotencyKey: string }
> {
  const setModel = useSetModel();
  return useMutation<
    CharacterModel,
    ApiRequestError,
    { readonly body: CreateCharacterModelRequest; readonly idempotencyKey: string }
  >({
    mutationFn: ({ body, idempotencyKey }) =>
      apiRequest<CharacterModel>(MODELS_PATH, {
        method: "POST",
        body,
        idempotencyKey,
        schema: characterModelSchema,
      }),
    onSuccess: setModel,
  });
}

export function useUpdateModel(
  id: string,
): UseMutationResult<CharacterModel, ApiRequestError, UpdateCharacterModelRequest> {
  const setModel = useSetModel();
  return useMutation<CharacterModel, ApiRequestError, UpdateCharacterModelRequest>({
    mutationFn: (body) =>
      apiRequest<CharacterModel>(path(id), {
        method: "PATCH",
        body,
        schema: characterModelSchema,
      }),
    onSuccess: setModel,
  });
}

export function useSetModelBrands(
  id: string,
): UseMutationResult<CharacterModel, ApiRequestError, readonly string[]> {
  const setModel = useSetModel();
  return useMutation<CharacterModel, ApiRequestError, readonly string[]>({
    mutationFn: (brandIds) =>
      apiRequest<CharacterModel>(path(id, "/brands"), {
        method: "PUT",
        body: { brandIds: [...brandIds] },
        schema: characterModelSchema,
      }),
    onSuccess: setModel,
  });
}

export function useDeleteModel(
  id: string,
): UseMutationResult<void, ApiRequestError, void> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, void>({
    mutationFn: async () => {
      await apiSend(path(id), { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: modelKeys.one(id) });
      void queryClient.invalidateQueries({ queryKey: modelKeys.list() });
      void queryClient.invalidateQueries({ queryKey: ["influencers"] });
    },
  });
}

/** Imágenes listas del Media Bank de una marca del dueño (no la activa). */
export function useBrandImages(
  brandId: string | null,
): UseQueryResult<Media[], ApiRequestError> {
  return useApiQuery<Media[]>({
    queryKey: modelKeys.brandMedia(brandId ?? "none"),
    path: `${MODELS_PATH}/brands/${encodeURIComponent(brandId ?? "none")}/media`,
    query: { limit: 60 },
    schema: z.array(mediaSchema),
    enabled: brandId !== null,
  });
}

/* ── UGC ── */

export function useModelUgc(
  id: string,
  brandId: string | null,
): UseQueryResult<InfluencerGeneration[], ApiRequestError> {
  return useApiQuery<InfluencerGeneration[]>({
    queryKey: modelKeys.ugc(id, brandId ?? "none"),
    path: path(id, "/ugc"),
    query: { brandId: brandId ?? "" },
    schema: influencerGenerationListSchema,
    enabled: brandId !== null,
    refetchInterval: (q) =>
      q.state.data?.some((g) => g.status === "queued" || g.status === "generating") ===
      true
        ? UGC_POLL_MS
        : false,
  });
}

export function useUgcEstimate(
  id: string,
  body: CharacterUgcImageRequest | null,
): UseQueryResult<InfluencerImageEstimate, ApiRequestError> {
  return useQuery<InfluencerImageEstimate, ApiRequestError>({
    queryKey:
      body === null
        ? ["character-models", id, "ugc-estimate", "none"]
        : modelKeys.estimate(id, body),
    queryFn: ({ signal }) =>
      apiRequest<InfluencerImageEstimate>(path(id, "/ugc/estimate"), {
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

function useUgcStarted(id: string) {
  const queryClient = useQueryClient();
  return (created: InfluencerGeneration, brandId: string) => {
    queryClient.setQueryData<InfluencerGeneration[]>(
      modelKeys.ugc(id, brandId),
      (old) => [created, ...(old ?? []).filter((g) => g.id !== created.id)],
    );
    void queryClient.invalidateQueries({ queryKey: modelKeys.ugc(id, brandId) });
    void queryClient.invalidateQueries({ queryKey: budgetKeys.summary() });
  };
}

export function useGenerateUgc(
  id: string,
): UseMutationResult<InfluencerGeneration, ApiRequestError, CharacterUgcImageRequest> {
  const started = useUgcStarted(id);
  return useMutation<InfluencerGeneration, ApiRequestError, CharacterUgcImageRequest>({
    mutationFn: (body) =>
      apiRequest<InfluencerGeneration>(path(id, "/ugc"), {
        method: "POST",
        body,
        schema: influencerGenerationSchema,
      }),
    onSuccess: (created, body) => {
      started(created, body.brandId);
    },
  });
}

export function useAnimateEstimate(
  id: string,
  body: CharacterUgcAnimateRequest | null,
): UseQueryResult<InfluencerImageEstimate, ApiRequestError> {
  return useQuery<InfluencerImageEstimate, ApiRequestError>({
    queryKey:
      body === null
        ? ["character-models", id, "animate-estimate", "none"]
        : modelKeys.animateEstimate(id, body),
    queryFn: ({ signal }) =>
      apiRequest<InfluencerImageEstimate>(path(id, "/ugc/animate/estimate"), {
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

export function useAnimateUgc(
  id: string,
): UseMutationResult<InfluencerGeneration, ApiRequestError, CharacterUgcAnimateRequest> {
  const started = useUgcStarted(id);
  return useMutation<InfluencerGeneration, ApiRequestError, CharacterUgcAnimateRequest>({
    mutationFn: (body) =>
      apiRequest<InfluencerGeneration>(path(id, "/ugc/animate"), {
        method: "POST",
        body,
        schema: influencerGenerationSchema,
      }),
    onSuccess: (created, body) => {
      started(created, body.brandId);
    },
  });
}

/** La pieza en la Library de la marca. La key se fija por intento (un reintento no duplica). */
export function useCreateUgcPiece(
  id: string,
): UseMutationResult<
  unknown,
  ApiRequestError,
  { readonly body: CharacterUgcPieceRequest; readonly idempotencyKey?: string }
> {
  return useMutation<
    unknown,
    ApiRequestError,
    { readonly body: CharacterUgcPieceRequest; readonly idempotencyKey?: string }
  >({
    mutationFn: ({ body, idempotencyKey }) =>
      apiRequest<unknown>(path(id, "/ugc/piece"), {
        method: "POST",
        body,
        idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
      }),
  });
}
