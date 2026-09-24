"use client";

/**
 * Hooks de influencers sobre el cliente de la API — `PU-LATER-004`.
 *
 * Las claves cuelgan de `["influencers"]` (`queryKeys`) y llevan la marca
 * activa implícita: el cliente manda `X-Fastgram-Workspace`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  influencerGenerationListSchema,
  influencerGenerationSchema,
  influencerImageEstimateSchema,
  influencerSchema,
  influencerSetupSchema,
  type InfluencerGeneration,
  type InfluencerImageEstimate,
  type InfluencerImageRequest,
  type InfluencerSetup,
} from "@fastgram/contracts";
import { z } from "zod";

import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";
import { queryKeys } from "../api/keys";
import { budgetKeys } from "../models/budget";
import {
  generationsRefetchInterval,
  influencersRefetchInterval,
  isInFlight,
  toCreateRequest,
  TRAINING_POLL_MS,
  type InfluencerView,
  type WizardForm,
} from "./form";

export const INFLUENCERS_PATH = "/influencers";

/** La portada puede faltar en filas del camino viejo (imagen base). */
const influencerViewSchema = influencerSchema.partial({ baseImageUrl: true });

export const influencerKeys = {
  list: () => queryKeys.influencers(),
  one: (id: string) => queryKeys.influencer(id),
  setup: () => ["influencers", "setup"] as const,
  generations: (id: string) => ["influencers", id, "generations"] as const,
  estimate: (id: string, req: InfluencerImageRequest) =>
    ["influencers", id, "estimate", req] as const,
};

export function useInfluencers(): UseQueryResult<InfluencerView[], ApiRequestError> {
  return useApiQuery<InfluencerView[]>({
    queryKey: influencerKeys.list(),
    path: INFLUENCERS_PATH,
    query: { limit: 100 },
    schema: z.array(influencerViewSchema),
    refetchInterval: (q) => influencersRefetchInterval(q.state.data),
  });
}

export function useInfluencer(
  id: string,
): UseQueryResult<InfluencerView, ApiRequestError> {
  return useApiQuery<InfluencerView>({
    queryKey: influencerKeys.one(id),
    path: `${INFLUENCERS_PATH}/${encodeURIComponent(id)}`,
    schema: influencerViewSchema,
    refetchInterval: (q) =>
      q.state.data !== undefined && isInFlight(q.state.data) ? TRAINING_POLL_MS : false,
  });
}

export function useInfluencerSetup(): UseQueryResult<InfluencerSetup, ApiRequestError> {
  return useApiQuery<InfluencerSetup>({
    queryKey: influencerKeys.setup(),
    path: `${INFLUENCERS_PATH}/setup`,
    schema: influencerSetupSchema,
  });
}

export function useCreateInfluencer(): UseMutationResult<
  InfluencerView,
  ApiRequestError,
  { readonly form: WizardForm; readonly idempotencyKey: string }
> {
  const queryClient = useQueryClient();
  return useMutation<
    InfluencerView,
    ApiRequestError,
    { readonly form: WizardForm; readonly idempotencyKey: string }
  >({
    mutationFn: ({ form, idempotencyKey }) =>
      apiRequest<InfluencerView>(INFLUENCERS_PATH, {
        method: "POST",
        body: toCreateRequest(form),
        idempotencyKey,
        schema: influencerViewSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: influencerKeys.list() });
    },
  });
}

export function useInfluencerGenerations(
  id: string,
  enabled: boolean,
): UseQueryResult<InfluencerGeneration[], ApiRequestError> {
  return useApiQuery<InfluencerGeneration[]>({
    queryKey: influencerKeys.generations(id),
    path: `${INFLUENCERS_PATH}/${encodeURIComponent(id)}/generations`,
    schema: influencerGenerationListSchema,
    enabled,
    refetchInterval: (q) => generationsRefetchInterval(q.state.data),
  });
}

export function useImageEstimate(
  id: string,
  request: InfluencerImageRequest | null,
): UseQueryResult<InfluencerImageEstimate, ApiRequestError> {
  return useQuery<InfluencerImageEstimate, ApiRequestError>({
    queryKey:
      request === null
        ? ["influencers", id, "estimate", "none"]
        : influencerKeys.estimate(id, request),
    queryFn: ({ signal }) =>
      apiRequest<InfluencerImageEstimate>(
        `${INFLUENCERS_PATH}/${encodeURIComponent(id)}/images/estimate`,
        { method: "POST", body: request, signal, schema: influencerImageEstimateSchema },
      ),
    enabled: request !== null,
    staleTime: 60_000,
    retry: false,
  });
}

export function useGenerateImages(
  id: string,
): UseMutationResult<InfluencerGeneration, ApiRequestError, InfluencerImageRequest> {
  const queryClient = useQueryClient();
  return useMutation<InfluencerGeneration, ApiRequestError, InfluencerImageRequest>({
    mutationFn: (body) =>
      apiRequest<InfluencerGeneration>(
        `${INFLUENCERS_PATH}/${encodeURIComponent(id)}/images`,
        { method: "POST", body, schema: influencerGenerationSchema },
      ),
    onSuccess: (created) => {
      queryClient.setQueryData<InfluencerGeneration[]>(
        influencerKeys.generations(id),
        (old) => [created, ...(old ?? []).filter((g) => g.id !== created.id)],
      );
      void queryClient.invalidateQueries({ queryKey: influencerKeys.generations(id) });
      void queryClient.invalidateQueries({ queryKey: influencerKeys.setup() });
      void queryClient.invalidateQueries({ queryKey: budgetKeys.summary() });
    },
  });
}
