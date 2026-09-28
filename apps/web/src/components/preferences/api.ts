"use client";

/**
 * Hooks de «What Blitz learned» sobre el cliente de la API — sprint 9 (Q),
 * `PU-S9-011`. Las claves cuelgan de `["preferences"]` y viven acá y no en
 * `lib/api/keys.ts` (compartido) por lo mismo que `lib/models/api.ts`.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import {
  preferencesViewSchema,
  type PreferencesView,
  type ResetPreferencesRequest,
  type UpdateOwnerPreferenceSettingsRequest,
  type UpdatePreferenceSettingsRequest,
} from "@fastgram/contracts";
import { apiRequest } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";

export type PreferenceScope = "brand" | "owner";

export const PREFERENCES_PATH = "/preferences";
export const OWNER_PREFERENCES_PATH = "/preferences/owner";

export const preferencesKeys = {
  all: () => ["preferences"] as const,
  view: (scope: PreferenceScope) => ["preferences", scope] as const,
};

const pathOf = (scope: PreferenceScope): string =>
  scope === "brand" ? PREFERENCES_PATH : OWNER_PREFERENCES_PATH;

export function usePreferencesView(
  scope: PreferenceScope,
): UseQueryResult<PreferencesView, ApiRequestError> {
  return useApiQuery<PreferencesView>({
    queryKey: preferencesKeys.view(scope),
    path: pathOf(scope),
    schema: preferencesViewSchema,
  });
}

/**
 * `PATCH /preferences` o `/preferences/owner`. Invalida las dos vistas: el
 * default del dueño cambia lo que hereda la marca, y al revés.
 */
export function useUpdatePreferenceSettings(
  scope: PreferenceScope,
): UseMutationResult<
  PreferencesView,
  ApiRequestError,
  UpdatePreferenceSettingsRequest | UpdateOwnerPreferenceSettingsRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      apiRequest<PreferencesView>(pathOf(scope), {
        method: "PATCH",
        body,
        schema: preferencesViewSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: preferencesKeys.all() }),
  });
}

/** `POST /preferences/reset` con `confirm: true` (la confirmación la pide el diálogo). */
export function useResetPreferences(): UseMutationResult<
  PreferencesView,
  ApiRequestError,
  ResetPreferencesRequest["scope"]
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scope) =>
      apiRequest<PreferencesView>(`${PREFERENCES_PATH}/reset`, {
        method: "POST",
        body: { scope, confirm: true } satisfies ResetPreferencesRequest,
        schema: preferencesViewSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: preferencesKeys.all() }),
  });
}
