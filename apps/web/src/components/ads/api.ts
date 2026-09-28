"use client";

/**
 * Ads (Meta) — sprint 9 (R), `D-21`. Hooks sobre `/ads/*` (lista de rutas en
 * `packages/contracts/src/resources/ads.ts`). La marca es la de la cookie.
 *
 * Vive con los componentes (`components/ads`) y no en `lib/` porque ése es el
 * directorio de este módulo en el sprint.
 */
import {
  activationPreviewSchema,
  adCampaignDetailSchema,
  adCampaignSummarySchema,
  adConnectionOptionsSchema,
  adConnectionSchema,
  adsAuthorizeResponseSchema,
  adsDashboardSchema,
  adsSyncResultSchema,
  type ActivationPreview,
  type ActivationPreviewRequest,
  type AdCampaignDetail,
  type AdCampaignSummary,
  type AdConnection,
  type AdConnectionOptions,
  type AdsDashboard,
  type AdsSyncResult,
  type CreateAdCampaignRequest,
  type SelectAdAccountRequest,
  type UpdateAdBudgetRequest,
} from "@fastgram/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, apiSend } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";

export const adsKeys = {
  all: ["ads"] as const,
  connection: () => ["ads", "connection"] as const,
  options: () => ["ads", "options"] as const,
  campaigns: () => ["ads", "campaigns"] as const,
  campaign: (id: string) => ["ads", "campaign", id] as const,
  dashboard: (days: number) => ["ads", "dashboard", days] as const,
};

const campaignPath = (id: string, rest = "") =>
  `/ads/campaigns/${encodeURIComponent(id)}${rest}`;

/** El motivo estable de un rechazo (`details.reason`), si lo hay. */
export function reasonOf(error: unknown): string | null {
  const details = (error as ApiRequestError | null)?.details;
  const r = details?.["reason"];
  return typeof r === "string" ? r : null;
}

export function useAdsConnection(): UseQueryResult<AdConnection, ApiRequestError> {
  return useQuery<AdConnection, ApiRequestError>({
    queryKey: adsKeys.connection(),
    queryFn: ({ signal }) =>
      apiRequest("/ads/connection", { signal, schema: adConnectionSchema }),
  });
}

export function useAdConnectionOptions(
  enabled: boolean,
): UseQueryResult<AdConnectionOptions, ApiRequestError> {
  return useQuery<AdConnectionOptions, ApiRequestError>({
    queryKey: adsKeys.options(),
    enabled,
    queryFn: ({ signal }) =>
      apiRequest("/ads/connection/options", {
        signal,
        schema: adConnectionOptionsSchema,
      }),
  });
}

/** Pide la URL de Facebook Login y navega. */
export function useStartAdsLogin(): UseMutationResult<string, ApiRequestError, void> {
  return useMutation<string, ApiRequestError, void>({
    mutationFn: async () => {
      const out = await apiRequest("/ads/connection/authorize", {
        schema: adsAuthorizeResponseSchema,
      });
      return out.url;
    },
    onSuccess: (url) => {
      window.location.assign(url);
    },
  });
}

function useInvalidateAds() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: adsKeys.all });
}

export function useSelectAdAccount(): UseMutationResult<
  AdConnection,
  ApiRequestError,
  SelectAdAccountRequest
> {
  const invalidate = useInvalidateAds();
  return useMutation<AdConnection, ApiRequestError, SelectAdAccountRequest>({
    mutationFn: (body) =>
      apiRequest("/ads/connection", { method: "PUT", body, schema: adConnectionSchema }),
    onSuccess: () => invalidate(),
  });
}

export function useConnectAdsDemo(): UseMutationResult<
  AdConnection,
  ApiRequestError,
  void
> {
  const invalidate = useInvalidateAds();
  return useMutation<AdConnection, ApiRequestError, void>({
    mutationFn: () =>
      apiRequest("/ads/connection/demo", { method: "POST", schema: adConnectionSchema }),
    onSuccess: () => invalidate(),
  });
}

export function useDisconnectAds(): UseMutationResult<void, ApiRequestError, void> {
  const invalidate = useInvalidateAds();
  return useMutation<void, ApiRequestError, void>({
    mutationFn: () => apiSend("/ads/connection", { method: "DELETE" }),
    onSuccess: () => invalidate(),
  });
}

export function useAdCampaigns(
  enabled = true,
): UseQueryResult<AdCampaignSummary[], ApiRequestError> {
  return useQuery<AdCampaignSummary[], ApiRequestError>({
    queryKey: adsKeys.campaigns(),
    enabled,
    queryFn: ({ signal }) =>
      apiRequest("/ads/campaigns", { signal, schema: z.array(adCampaignSummarySchema) }),
  });
}

export function useAdCampaign(
  id: string,
): UseQueryResult<AdCampaignDetail, ApiRequestError> {
  return useQuery<AdCampaignDetail, ApiRequestError>({
    queryKey: adsKeys.campaign(id),
    queryFn: ({ signal }) =>
      apiRequest(campaignPath(id), { signal, schema: adCampaignDetailSchema }),
  });
}

export function useCreateAdCampaign(): UseMutationResult<
  AdCampaignDetail,
  ApiRequestError,
  CreateAdCampaignRequest
> {
  const invalidate = useInvalidateAds();
  return useMutation<AdCampaignDetail, ApiRequestError, CreateAdCampaignRequest>({
    mutationFn: (body) =>
      apiRequest("/ads/campaigns", {
        method: "POST",
        body,
        schema: adCampaignDetailSchema,
      }),
    onSuccess: () => invalidate(),
  });
}

export function useActivationPreview(
  id: string,
): UseMutationResult<ActivationPreview, ApiRequestError, ActivationPreviewRequest> {
  return useMutation<ActivationPreview, ApiRequestError, ActivationPreviewRequest>({
    mutationFn: (body) =>
      apiRequest(campaignPath(id, "/activation-preview"), {
        method: "POST",
        body,
        schema: activationPreviewSchema,
      }),
  });
}

export function useActivateCampaign(
  id: string,
): UseMutationResult<AdCampaignDetail, ApiRequestError, string> {
  const invalidate = useInvalidateAds();
  return useMutation<AdCampaignDetail, ApiRequestError, string>({
    mutationFn: (confirmationToken) =>
      apiRequest(campaignPath(id, "/activate"), {
        method: "POST",
        body: { confirmationToken },
        schema: adCampaignDetailSchema,
      }),
    onSuccess: () => invalidate(),
  });
}

export function usePauseCampaign(
  id: string,
): UseMutationResult<AdCampaignDetail, ApiRequestError, void> {
  const invalidate = useInvalidateAds();
  return useMutation<AdCampaignDetail, ApiRequestError, void>({
    mutationFn: () =>
      apiRequest(campaignPath(id, "/pause"), {
        method: "POST",
        schema: adCampaignDetailSchema,
      }),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateAdBudget(
  id: string,
): UseMutationResult<AdCampaignDetail, ApiRequestError, UpdateAdBudgetRequest> {
  const invalidate = useInvalidateAds();
  return useMutation<AdCampaignDetail, ApiRequestError, UpdateAdBudgetRequest>({
    mutationFn: (body) =>
      apiRequest(campaignPath(id, "/budget"), {
        method: "PATCH",
        body,
        schema: adCampaignDetailSchema,
      }),
    onSuccess: () => invalidate(),
  });
}

export function useSyncAds(): UseMutationResult<AdsSyncResult, ApiRequestError, void> {
  const invalidate = useInvalidateAds();
  return useMutation<AdsSyncResult, ApiRequestError, void>({
    mutationFn: () =>
      apiRequest("/ads/sync", { method: "POST", schema: adsSyncResultSchema }),
    onSuccess: () => invalidate(),
  });
}

export function useAdsDashboard(
  days: 7 | 30 | 90,
): UseQueryResult<AdsDashboard, ApiRequestError> {
  return useQuery<AdsDashboard, ApiRequestError>({
    queryKey: adsKeys.dashboard(days),
    queryFn: ({ signal }) =>
      apiRequest("/ads/dashboard", {
        signal,
        query: { days: String(days) },
        schema: adsDashboardSchema,
      }),
  });
}
