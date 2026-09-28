"use client";

/**
 * API del editor de reels (sprint 9, `PU-S9-010`). Vive con el editor y no en
 * `lib/editor/` porque este sprint el dueño de `components/editor/**` es el
 * agente de reels y `lib/` no.
 */
import {
  editableReelSchema,
  reelPreviewResponseSchema,
  type EditableReel,
  type ReelFromPromptRequest,
  type ReelPreviewResponse,
  type ReelSpec,
  type UpdateReelRequest,
} from "@fastgram/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";
import { newIdempotencyKey } from "@/lib/api/idempotency-key";
import { queryKeys } from "@/lib/api/keys";
import { libraryContentSchema, type LibraryContent } from "@/lib/library/content";

export const reelKeys = {
  editable: (contentId: string) => ["content", contentId, "reel"] as const,
  preview: (spec: ReelSpec) => ["reels", "preview", JSON.stringify(spec)] as const,
};

const reelPath = (contentId: string): string =>
  `/content/${encodeURIComponent(contentId)}/reel`;

export function useEditableReel(contentId: string, enabled = true) {
  return useApiQuery<EditableReel>({
    queryKey: reelKeys.editable(contentId),
    path: reelPath(contentId),
    schema: editableReelSchema,
    enabled,
    staleTime: 0,
  });
}

export function useSaveReel(contentId: string) {
  const queryClient = useQueryClient();
  return useMutation<LibraryContent, ApiRequestError, UpdateReelRequest>({
    mutationFn: (body) =>
      apiRequest<LibraryContent>(reelPath(contentId), {
        method: "PUT",
        body,
        idempotencyKey: newIdempotencyKey(),
        schema: libraryContentSchema,
      }),
    onSuccess: (content) => {
      queryClient.setQueryData(queryKeys.contentItem(contentId), content);
      void queryClient.invalidateQueries({ queryKey: queryKeys.content() });
    },
  });
}

/**
 * La composición del spec en edición. Se pide con el spec **ya estable** (el
 * editor la pide con un retardo después del último cambio): cada pedido baja
 * la media en el servicio de render y recorta el croma (cacheado).
 */
export function useReelPreview(spec: ReelSpec | null) {
  return useQuery<ReelPreviewResponse, ApiRequestError>({
    queryKey: spec === null ? ["reels", "preview", "none"] : reelKeys.preview(spec),
    queryFn: () =>
      apiRequest<ReelPreviewResponse>("/reels/preview", {
        method: "POST",
        body: { reel: spec },
        schema: reelPreviewResponseSchema,
      }),
    enabled: spec !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** «Create from prompt» con formato reel. */
export function useCreateReelFromPrompt() {
  const queryClient = useQueryClient();
  return useMutation<
    LibraryContent,
    ApiRequestError,
    ReelFromPromptRequest & { readonly idempotencyKey: string }
  >({
    mutationFn: ({ idempotencyKey, ...body }) =>
      apiRequest<LibraryContent>("/reels/from-prompt", {
        method: "POST",
        body,
        idempotencyKey,
        schema: libraryContentSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.content() });
    },
  });
}
