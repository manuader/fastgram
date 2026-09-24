"use client";

/**
 * Hooks de Settings → Connections — `PU-PUB-002`, `P3-OAUTH-008`. Por marca:
 * el proxy manda `X-Fastgram-Workspace` con la marca activa, así que todo
 * esto es de la marca que está elegida en el switcher.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import {
  authorizeConnectionResponseSchema,
  connectionAccountSchema,
  facebookPageSelectionSchema,
  type AuthorizeConnectionResponse,
  type ConnectionAccount,
  type FacebookPageSelection,
  type OAuthPlatformId,
} from "@fastgram/contracts";
import { apiRequest, apiSend } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";

export const connectionsKeys = {
  all: () => ["connection-accounts"] as const,
  selection: (platform: string, id: string) =>
    ["connection-accounts", "selection", platform, id] as const,
};

export function useConnectionAccounts(): UseQueryResult<
  ConnectionAccount[],
  ApiRequestError
> {
  return useApiQuery<ConnectionAccount[]>({
    queryKey: connectionsKeys.all(),
    path: "/connections/accounts",
    schema: z.array(connectionAccountSchema),
  });
}

/** Pide la URL de la plataforma y lleva el navegador ahí. */
export function useStartConnection(): UseMutationResult<
  AuthorizeConnectionResponse,
  ApiRequestError,
  OAuthPlatformId
> {
  return useMutation<AuthorizeConnectionResponse, ApiRequestError, OAuthPlatformId>({
    mutationFn: (platform) =>
      apiRequest<AuthorizeConnectionResponse>(`/connections/${platform}/authorize`, {
        schema: authorizeConnectionResponseSchema,
      }),
    onSuccess: (res) => {
      window.location.assign(res.url);
    },
  });
}

export function useDisconnect(): UseMutationResult<void, ApiRequestError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (id) => apiSend(`/connections/accounts/${id}`, { method: "DELETE" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: connectionsKeys.all() }),
  });
}

export function useRefreshConnection(): UseMutationResult<
  ConnectionAccount,
  ApiRequestError,
  string
> {
  const queryClient = useQueryClient();
  return useMutation<ConnectionAccount, ApiRequestError, string>({
    mutationFn: (id) =>
      apiRequest<ConnectionAccount>(`/connections/accounts/${id}/refresh`, {
        method: "POST",
        schema: connectionAccountSchema,
      }),
    // También en error: un 409 `connection_expired` cambió el estado de la fila.
    onSettled: () => queryClient.invalidateQueries({ queryKey: connectionsKeys.all() }),
  });
}

/** Redes con elección de cuenta tras el login (`/connections/:platform/pages`). */
export type PickerPlatform = "facebook" | "linkedin";

export function useFacebookPageSelection(
  selectionId: string | null,
  platform: PickerPlatform = "facebook",
): UseQueryResult<FacebookPageSelection, ApiRequestError> {
  return useApiQuery<FacebookPageSelection>({
    queryKey: connectionsKeys.selection(platform, selectionId ?? "none"),
    path: `/connections/${platform}/pages/${selectionId ?? "none"}`,
    schema: facebookPageSelectionSchema,
    enabled: selectionId !== null,
  });
}

export function useSelectFacebookPage(
  platform: PickerPlatform = "facebook",
): UseMutationResult<
  ConnectionAccount,
  ApiRequestError,
  { selectionId: string; pageId: string }
> {
  const queryClient = useQueryClient();
  return useMutation<
    ConnectionAccount,
    ApiRequestError,
    { selectionId: string; pageId: string }
  >({
    mutationFn: (body) =>
      apiRequest<ConnectionAccount>(`/connections/${platform}/pages`, {
        method: "POST",
        body,
        schema: connectionAccountSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectionsKeys.all() }),
  });
}
