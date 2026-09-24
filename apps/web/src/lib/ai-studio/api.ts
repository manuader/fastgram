"use client";

/**
 * Hooks de AI Studio sobre el cliente de la API — `PU-LATER-005`.
 *
 * Las claves cuelgan de `["ai-studio"]` y llevan la marca activa implícita:
 * el cliente manda `X-Fastgram-Workspace`, y cambiar de marca invalida todo
 * (lo hace `WorkspaceProvider`).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  aiStudioOptionsSchema,
  generationEstimateSchema,
  generationListSchema,
  generationSchema,
  type AiStudioOptions,
  type Generation,
  type GenerationEstimate,
  type GenerationRequest,
} from "@fastgram/contracts";

import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";
import { budgetKeys } from "../models/budget";
import { galleryRefetchInterval } from "./form";

export const AI_STUDIO_PATH = "/ai-studio";

export const aiStudioKeys = {
  all: () => ["ai-studio"] as const,
  options: () => ["ai-studio", "options"] as const,
  generations: () => ["ai-studio", "generations"] as const,
  estimate: (request: GenerationRequest) => ["ai-studio", "estimate", request] as const,
};

export function useAiStudioOptions(): UseQueryResult<AiStudioOptions, ApiRequestError> {
  return useApiQuery<AiStudioOptions>({
    queryKey: aiStudioKeys.options(),
    path: `${AI_STUDIO_PATH}/options`,
    schema: aiStudioOptionsSchema,
  });
}

/** La galería. Se vuelve a pedir sola mientras algo está en cola o generando. */
export function useGenerations(): UseQueryResult<Generation[], ApiRequestError> {
  return useApiQuery<Generation[]>({
    queryKey: aiStudioKeys.generations(),
    path: `${AI_STUDIO_PATH}/generations`,
    schema: generationListSchema,
    refetchInterval: (query) => galleryRefetchInterval(query.state.data),
  });
}

/**
 * El costo estimado de `request`, o nada si todavía no hay pedido válido.
 * Cacheado por pedido: volver a una combinación ya vista no vuelve a
 * preguntarle al proveedor.
 */
export function useEstimate(
  request: GenerationRequest | null,
): UseQueryResult<GenerationEstimate, ApiRequestError> {
  return useQuery<GenerationEstimate, ApiRequestError>({
    queryKey:
      request === null
        ? ["ai-studio", "estimate", "none"]
        : aiStudioKeys.estimate(request),
    queryFn: ({ signal }) =>
      apiRequest<GenerationEstimate>(`${AI_STUDIO_PATH}/estimate`, {
        method: "POST",
        body: request,
        signal,
        schema: generationEstimateSchema,
      }),
    enabled: request !== null,
    staleTime: 60_000,
    retry: false,
  });
}

export function useCreateGeneration(): UseMutationResult<
  Generation,
  ApiRequestError,
  GenerationRequest
> {
  const queryClient = useQueryClient();
  return useMutation<Generation, ApiRequestError, GenerationRequest>({
    mutationFn: (body) =>
      apiRequest<Generation>(`${AI_STUDIO_PATH}/generations`, {
        method: "POST",
        body,
        schema: generationSchema,
      }),
    onSuccess: (created) => {
      queryClient.setQueryData<Generation[]>(aiStudioKeys.generations(), (old) => [
        created,
        ...(old ?? []).filter((g) => g.id !== created.id),
      ]);
      // Las opciones traen el presupuesto; la estimación no se invalida: volver
      // a preguntarle al proveedor por el mismo pedido no cambia nada.
      void queryClient.invalidateQueries({ queryKey: aiStudioKeys.options() });
      void queryClient.invalidateQueries({ queryKey: aiStudioKeys.generations() });
      void queryClient.invalidateQueries({ queryKey: budgetKeys.summary() });
    },
  });
}
