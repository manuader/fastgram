"use client";

/**
 * Hooks de Settings → Models sobre el cliente de la API — `PU-MODEL-002`.
 *
 * Las claves de caché viven acá y no en `lib/api/keys.ts` porque ese archivo
 * es compartido y otro agente lo está tocando en este sprint; cuelgan todas de
 * `["models"]` para que invalidar el prefijo alcance.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import {
  modelConnectionTestSchema,
  modelTaskConfigSchema,
  modelsOverviewSchema,
  providerModelsSchema,
  type ModelConnectionTest,
  type ModelProvider,
  type ModelTask,
  type ModelTaskConfig,
  type ModelsOverview,
  type ProviderModels,
  type TestModelConnectionRequest,
  type UpdateModelTaskRequest,
} from "@fastgram/contracts";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";

export const MODELS_PATH = "/models";

export const modelsKeys = {
  all: () => ["models"] as const,
  overview: () => ["models", "overview"] as const,
  providerModels: (provider: ModelProvider, baseUrl: string, task: ModelTask) =>
    ["models", "provider", provider, baseUrl, task] as const,
};

export function useModelsOverview(): UseQueryResult<ModelsOverview, ApiRequestError> {
  return useApiQuery<ModelsOverview>({
    queryKey: modelsKeys.overview(),
    path: MODELS_PATH,
    schema: modelsOverviewSchema,
  });
}

/**
 * `PUT /models/:task`. Invalida el resumen entero y no sólo la tarea: guardar
 * `text` cambia lo que muestra `judgment` cuando hereda.
 */
export function useSaveModelTask(
  task: ModelTask,
): UseMutationResult<ModelTaskConfig, ApiRequestError, UpdateModelTaskRequest> {
  const queryClient = useQueryClient();
  return useMutation<ModelTaskConfig, ApiRequestError, UpdateModelTaskRequest>({
    mutationFn: (body) =>
      apiRequest<ModelTaskConfig>(`${MODELS_PATH}/${task}`, {
        method: "PUT",
        body,
        schema: modelTaskConfigSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: modelsKeys.overview() }),
  });
}

/** `POST /models/test`. Lleva la key escrita (si hay) en el cuerpo, nunca en la URL. */
export function useTestModelConnection(): UseMutationResult<
  ModelConnectionTest,
  ApiRequestError,
  TestModelConnectionRequest
> {
  return useMutation<ModelConnectionTest, ApiRequestError, TestModelConnectionRequest>({
    mutationFn: (body) =>
      apiRequest<ModelConnectionTest>(`${MODELS_PATH}/test`, {
        method: "POST",
        body,
        schema: modelConnectionTestSchema,
      }),
  });
}

/**
 * `GET /models/providers/:provider/models` con la key **guardada** de `task`
 * (el servidor la usa sólo si la base URL es del mismo origen). A demanda:
 * `enabled` lo prende el botón «Load models».
 */
export function useProviderModels(args: {
  readonly provider: ModelProvider | "";
  readonly baseUrl: string;
  readonly task: ModelTask;
  readonly enabled: boolean;
}): UseQueryResult<ProviderModels, ApiRequestError> {
  const { provider, baseUrl, task, enabled } = args;
  return useQuery<ProviderModels, ApiRequestError>({
    queryKey:
      provider === ""
        ? ["models", "provider", "none"]
        : modelsKeys.providerModels(provider, baseUrl, task),
    queryFn: ({ signal }) =>
      apiRequest<ProviderModels>(`${MODELS_PATH}/providers/${provider}/models`, {
        signal,
        query: { baseUrl: baseUrl.trim() === "" ? undefined : baseUrl.trim(), task },
        schema: providerModelsSchema,
      }),
    enabled: enabled && provider !== "",
    // La lista del proveedor cambia poco; volver a pedirla en cada foco es ruido.
    staleTime: 60_000,
    retry: false,
  });
}
