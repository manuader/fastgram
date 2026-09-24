"use client";

/**
 * Lo que el editor lee y escribe · `PU-EDIT-003`.
 *
 * - `GET /content/:id` — estado, revisión, archivos, `lastEdit`
 *   (`useContentItem` de la Library, que ya hace el polling de ADR-014).
 * - `GET /content/:id/editable` — canvas, cajas y media vigente (`assets`).
 * - `PATCH /content/:id` y `POST /content/:id/regenerate` — ediciones.
 * - `GET /media?type=` y `GET /audio?for=` — los selectores de swap.
 *
 * Las claves cuelgan de `["content", id]` a propósito: invalidar la pieza
 * (lo que hace cualquier escritura sobre ella) invalida también su editable.
 */
import {
  audioTrackSchema,
  editableContentSchema,
  mediaSchema,
  type AudioLibrary,
  type AudioTrack,
  type EditableContent,
  type Media,
  type MediaType,
  type RegenerateContentRequest,
  type UpdateContentRequest,
} from "@fastgram/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiInfiniteQuery, useApiQuery, type CursorPages } from "../api/hooks";
import { newIdempotencyKey } from "../api/idempotency-key";
import { queryKeys } from "../api/keys";
import { libraryContentSchema, type LibraryContent } from "../library/content";

export const editorKeys = {
  editable: (contentId: string) => ["content", contentId, "editable"] as const,
  media: (type: MediaType) => ["media", "editor-picker", type] as const,
  audio: (library: AudioLibrary) => ["audio", library] as const,
};

const contentPath = (contentId: string): string =>
  `/content/${encodeURIComponent(contentId)}`;

/**
 * `GET /content/:id/editable`. Sin polling: la representación editable sólo
 * cambia cuando alguien edita, y eso lo dispara esta misma pantalla (que
 * invalida) o alguien más (que se detecta con el `409` de la revisión).
 */
export function useEditableContent(contentId: string, enabled = true) {
  return useApiQuery<EditableContent>({
    queryKey: editorKeys.editable(contentId),
    path: `${contentPath(contentId)}/editable`,
    schema: editableContentSchema,
    enabled,
    staleTime: 0,
  });
}

/** `PATCH /content/:id`. Una `Idempotency-Key` por intento de guardar. */
export function saveContentEdit(
  contentId: string,
  body: UpdateContentRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LibraryContent> {
  return apiRequest<LibraryContent>(contentPath(contentId), {
    method: "PATCH",
    body,
    idempotencyKey,
    schema: libraryContentSchema,
  });
}

export function regenerateContentText(
  contentId: string,
  body: RegenerateContentRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<LibraryContent> {
  return apiRequest<LibraryContent>(`${contentPath(contentId)}/regenerate`, {
    method: "POST",
    body,
    idempotencyKey,
    schema: libraryContentSchema,
  });
}

/**
 * Deja la pieza devuelta (ya en `BUILDING`, revisión nueva) en la caché, para
 * que el polling de `useContentItem` arranque sin esperar un refetch.
 */
function useWriteContent<TVars>(
  contentId: string,
  write: (vars: TVars) => Promise<LibraryContent>,
) {
  const queryClient = useQueryClient();
  return useMutation<LibraryContent, ApiRequestError, TVars>({
    mutationFn: write,
    onSuccess: (content) => {
      queryClient.setQueryData(queryKeys.contentItem(contentId), content);
      void queryClient.invalidateQueries({ queryKey: queryKeys.content() });
    },
  });
}

export function useSaveContentEdit(contentId: string) {
  return useWriteContent<UpdateContentRequest>(contentId, (body) =>
    saveContentEdit(contentId, body),
  );
}

export function useRegenerateText(contentId: string) {
  return useWriteContent<RegenerateContentRequest>(contentId, (body) =>
    regenerateContentText(contentId, body),
  );
}

/** Tamaño de página de los selectores: 4 columnas × 6 filas (FR-052, grid 4×N). */
export const PICKER_PAGE_SIZE = 24;

/** `GET /media?type=` para `Select Video` / `Swap image for slide N`. */
export function useMediaPicker(type: MediaType, enabled: boolean) {
  return useApiInfiniteQuery<Media>({
    queryKey: editorKeys.media(type),
    path: "/media",
    query: { type },
    itemSchema: mediaSchema,
    limit: PICKER_PAGE_SIZE,
    enabled,
  });
}

/** `GET /audio?for=` para `Select Audio` (FR-053). */
export function useAudioPicker(library: AudioLibrary, enabled: boolean) {
  return useApiInfiniteQuery<AudioTrack>({
    queryKey: editorKeys.audio(library),
    path: "/audio",
    query: { for: library },
    itemSchema: audioTrackSchema,
    limit: 100,
    enabled,
  });
}

/** Las páginas del cursor en una lista (el `flattenPages` de la Library es sólo de piezas). */
export function flattenItems<T>(data: CursorPages<T> | undefined): readonly T[] {
  return data === undefined ? [] : data.pages.flatMap((page) => page.items);
}
