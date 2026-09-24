"use client";

/**
 * Hooks de Settings → Integrations — `PU-PUB-002`. Mismo criterio que
 * `lib/models/api.ts`: las claves de caché viven acá (cuelgan de
 * `["integrations"]`) porque `lib/api/keys.ts` es compartido.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import {
  integrationAppSchema,
  integrationsOverviewSchema,
  type IntegrationApp,
  type IntegrationsOverview,
  type OAuthPlatformId,
  type UpdateIntegrationRequest,
} from "@fastgram/contracts";
import { apiRequest, apiSend } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";

export const INTEGRATIONS_PATH = "/integrations";

export const integrationsKeys = {
  all: () => ["integrations"] as const,
};

export function useIntegrations(): UseQueryResult<IntegrationsOverview, ApiRequestError> {
  return useApiQuery<IntegrationsOverview>({
    queryKey: integrationsKeys.all(),
    path: INTEGRATIONS_PATH,
    schema: integrationsOverviewSchema,
  });
}

/** `PUT /integrations/:platform`. El secret viaja en el cuerpo, nunca en la URL. */
export function useSaveIntegration(
  platform: OAuthPlatformId,
): UseMutationResult<IntegrationApp, ApiRequestError, UpdateIntegrationRequest> {
  const queryClient = useQueryClient();
  return useMutation<IntegrationApp, ApiRequestError, UpdateIntegrationRequest>({
    mutationFn: (body) =>
      apiRequest<IntegrationApp>(`${INTEGRATIONS_PATH}/${platform}`, {
        method: "PUT",
        body,
        schema: integrationAppSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: integrationsKeys.all() }),
  });
}

export function useRemoveIntegration(
  platform: OAuthPlatformId,
): UseMutationResult<void, ApiRequestError, void> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, void>({
    mutationFn: () => apiSend(`${INTEGRATIONS_PATH}/${platform}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: integrationsKeys.all() }),
  });
}
