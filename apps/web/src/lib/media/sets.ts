"use client";

/**
 * Media Sets · `DATA-011`, `F-127`, `P2-MEDIA-005/006` (sprint 7).
 *
 * `GET /media/sets`, `POST /media/sets` (mínimo 5), `DELETE /media/sets/:id`.
 * El contador del modo `CREATING SET` —`<N> selected (need <M> more)`— sale de
 * {@link setProgress}, puro y testeado.
 */
import {
  MEDIA_SET_MIN_ASSETS,
  createMediaSetRequestSchema,
  mediaSetSchema,
  type CreateMediaSetRequest,
  type MediaSet,
} from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, apiSend } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";

export const MEDIA_SETS_PATH = "/media/sets";
export const mediaSetKeys = { all: () => ["media-sets"] as const };

export interface SetProgress {
  readonly selected: number;
  readonly missing: number;
  readonly enough: boolean;
}

/** `0 selected (need 5 more)` (PRD:1651). */
export function setProgress(selected: number, min = MEDIA_SET_MIN_ASSETS): SetProgress {
  const missing = Math.max(0, min - selected);
  return { selected, missing, enough: missing === 0 };
}

/** El `Save` del modo: nombre + mínimo alcanzado (PRD:1653). */
export function canSaveSet(name: string, selected: number): boolean {
  return name.trim().length > 0 && setProgress(selected).enough;
}

/** El cuerpo, validado con el mismo schema que la API. */
export function toCreateSetRequest(
  input: CreateMediaSetRequest,
): CreateMediaSetRequest | null {
  const parsed = createMediaSetRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function useMediaSets(): UseQueryResult<MediaSet[], ApiRequestError> {
  return useApiQuery<MediaSet[]>({
    queryKey: mediaSetKeys.all(),
    path: MEDIA_SETS_PATH,
    schema: z.array(mediaSetSchema),
    staleTime: 10_000,
  });
}

export function useCreateMediaSet(): UseMutationResult<
  MediaSet,
  ApiRequestError,
  CreateMediaSetRequest
> {
  const queryClient = useQueryClient();
  return useMutation<MediaSet, ApiRequestError, CreateMediaSetRequest>({
    mutationFn: (body) =>
      apiRequest<MediaSet>(MEDIA_SETS_PATH, {
        method: "POST",
        body,
        schema: mediaSetSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mediaSetKeys.all() });
    },
  });
}

export function useDeleteMediaSet(): UseMutationResult<void, ApiRequestError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (id) =>
      apiSend(`${MEDIA_SETS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mediaSetKeys.all() });
    },
  });
}
