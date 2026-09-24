"use client";

/**
 * Escrituras sobre un asset existente del Media Bank · FR-100.
 *
 * · `PATCH /media/:id {categories}` — **reemplazo total** (PRD:1634): se manda
 *   el array entero, y vacío es válido (el asset sale de los pools de Blitz).
 * · `DELETE /media/:id` — `204`. FR-100 dice que se rechaza con
 *   `409 media_in_use` si el asset sigue referenciado; **la API de hoy no lo
 *   implementa** (ver la cabecera de `apps/api/src/routes/v1/media.ts`) y
 *   responde `204` siempre. La pantalla igual trata el `409`: el día que la
 *   ruta lo devuelva, el mensaje ya está.
 */
import { mediaSchema, type Media, type MediaCategory } from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { apiRequest, apiSend } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { queryKeys } from "../api/keys";
import { MEDIA_PATH } from "./media";

export function mediaItemPath(mediaId: string): string {
  return `${MEDIA_PATH}/${encodeURIComponent(mediaId)}`;
}

/** El PATCH, suelto: lo usa también la cola de subida, que no es un hook por asset. */
export function patchMediaCategories(
  mediaId: string,
  categories: readonly MediaCategory[],
): Promise<Media> {
  return apiRequest<Media>(mediaItemPath(mediaId), {
    method: "PATCH",
    body: { categories: [...categories] },
    schema: mediaSchema,
  });
}

export interface UpdateCategoriesInput {
  readonly mediaId: string;
  readonly categories: readonly MediaCategory[];
}

export function useUpdateMediaCategories(): UseMutationResult<
  Media,
  ApiRequestError,
  UpdateCategoriesInput
> {
  const queryClient = useQueryClient();
  return useMutation<Media, ApiRequestError, UpdateCategoriesInput>({
    mutationFn: ({ mediaId, categories }) => patchMediaCategories(mediaId, categories),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.media() });
    },
  });
}

export function useDeleteMedia(): UseMutationResult<void, ApiRequestError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, string>({
    // `apiSend` y no `apiRequest`: un `204` no tiene sobre `{data}`, y
    // `apiRequest` haría fallar todo borrado exitoso (ver `client.ts`).
    mutationFn: (mediaId) => apiSend(mediaItemPath(mediaId), { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.media() });
    },
  });
}
