"use client";

/**
 * Etiquetas del Media Bank · `P2-MEDIA-007` (sprint 7, migración `0029`).
 *
 * `GET /media/tags` da las etiquetas en uso con su cuenta (chips de filtro);
 * `PATCH /media/:id {tags}` las reemplaza enteras, como las categorías.
 */
import { mediaSchema, type Media } from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";
import { queryKeys } from "../api/keys";
import { mediaItemPath } from "./mutations";

export interface MediaTagCount {
  readonly tag: string;
  readonly count: number;
}

const tagCountsSchema = z.array(
  z.object({ tag: z.string(), count: z.number().int().nonnegative() }).strict(),
);

export const mediaTagKeys = { all: () => ["media-tags"] as const };

export function useMediaTags(): UseQueryResult<MediaTagCount[], ApiRequestError> {
  return useApiQuery<MediaTagCount[]>({
    queryKey: mediaTagKeys.all(),
    path: "/media/tags",
    schema: tagCountsSchema,
    staleTime: 30_000,
  });
}

/** `"Cats, cats , dog"` → `["cats", "dog"]`: la misma normalización que la API. */
export function parseTagInput(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim().toLowerCase();
    if (tag.length > 0 && tag.length <= 40 && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 30);
}

export function useUpdateMediaTags(): UseMutationResult<
  Media,
  ApiRequestError,
  { readonly mediaId: string; readonly tags: readonly string[] }
> {
  const queryClient = useQueryClient();
  return useMutation<
    Media,
    ApiRequestError,
    { readonly mediaId: string; readonly tags: readonly string[] }
  >({
    mutationFn: ({ mediaId, tags }) =>
      apiRequest<Media>(mediaItemPath(mediaId), {
        method: "PATCH",
        body: { tags: [...tags] },
        schema: mediaSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.media() });
      void queryClient.invalidateQueries({ queryKey: mediaTagKeys.all() });
    },
  });
}
