"use client";

/**
 * Importar por link — `POST /media/import`, `GET /media/import/:id`,
 * `GET /media/meta` (`PU-MEME-001`, `PU-MEME-002`, `PU-MEME-003`, D-12).
 *
 * El import es asíncrono: el `POST` devuelve `202` con un `importId` y el
 * estado se consulta por polling cada {@link IMPORT_POLL_INTERVAL_MS} hasta que
 * termina (bajada, recorte de fondo y etiquetas incluidos). Cuando aparece la
 * fila en el Media Bank se invalida el listado, que ya tiene su propio polling
 * mientras el video esté `processing`.
 */
import {
  mediaImportSchema,
  mediaMetaListSchema,
  type MediaImport,
  type MediaImportRequest,
  type MediaMetaView,
} from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";
import { newIdempotencyKey } from "../api/idempotency-key";
import { queryKeys } from "../api/keys";
import type { CopyKey } from "../i18n/t";

export const MEDIA_IMPORT_PATH = "/media/import";
/** Una bajada corta termina en segundos: 2 s se siente vivo sin martillar la API. */
export const IMPORT_POLL_INTERVAL_MS = 2_000;

/** ¿Queda algo por esperar? El recorte y el etiquetado siguen después de `imported`. */
export function isImportSettled(status: MediaImport | undefined): boolean {
  if (status === undefined) return false;
  if (status.state === "failed") return true;
  if (status.state !== "imported") return false;
  return status.background !== "pending" && status.tagging !== "pending";
}

export const IMPORT_ERROR_COPY: Readonly<
  Record<NonNullable<MediaImport["error"]>, CopyKey>
> = {
  unsupported_url: "mediaImport.error.unsupportedUrl",
  too_long: "mediaImport.error.tooLong",
  too_large: "mediaImport.error.tooLarge",
  download_failed: "mediaImport.error.downloadFailed",
};

export const IMPORT_BACKGROUND_COPY: Readonly<
  Partial<Record<NonNullable<MediaImport["background"]>, CopyKey>>
> = {
  pending: "mediaImport.background.pending",
  green_screen: "mediaImport.background.greenScreen",
  removed: "mediaImport.background.removed",
  needs_background_removal: "mediaImport.background.needs",
  failed: "mediaImport.background.failed",
};

export const IMPORT_TAGGING_COPY: Readonly<
  Partial<Record<NonNullable<MediaImport["tagging"]>, CopyKey>>
> = {
  pending: "mediaImport.tagging.pending",
  skipped: "mediaImport.tagging.skipped",
  failed: "mediaImport.tagging.failed",
};

/** El copy del estado principal del import. */
export function importStateCopy(status: MediaImport): CopyKey {
  switch (status.state) {
    case "queued":
      return "mediaImport.state.queued";
    case "downloading":
      return "mediaImport.state.downloading";
    case "failed":
      return IMPORT_ERROR_COPY[status.error ?? "download_failed"];
    case "imported":
      if (status.kind === "audio") return "mediaImport.state.audioDone";
      return status.mediaStatus === "processing"
        ? "mediaImport.state.processing"
        : "mediaImport.state.done";
  }
}

export function useStartMediaImport(): UseMutationResult<
  MediaImport,
  ApiRequestError,
  MediaImportRequest
> {
  return useMutation<MediaImport, ApiRequestError, MediaImportRequest>({
    mutationFn: (body) =>
      apiRequest<MediaImport>(MEDIA_IMPORT_PATH, {
        method: "POST",
        body,
        idempotencyKey: newIdempotencyKey(),
        schema: mediaImportSchema,
      }),
  });
}

/**
 * Estado de un import, con polling hasta que se asienta. Cuando aparece la
 * fila (o el recorte), invalida el listado del Media Bank.
 */
export function useMediaImportStatus(
  importId: string | null,
): UseQueryResult<MediaImport, ApiRequestError> {
  const queryClient = useQueryClient();
  const query = useApiQuery<MediaImport>({
    queryKey: ["media", "import", importId ?? ""],
    path: `${MEDIA_IMPORT_PATH}/${encodeURIComponent(importId ?? "")}`,
    schema: mediaImportSchema,
    enabled: importId !== null,
    staleTime: 0,
    refetchInterval: (q) =>
      isImportSettled(q.state.data) ? false : IMPORT_POLL_INTERVAL_MS,
  });
  // Cuando aparece una fila nueva (el original o el recorte) o cambian sus
  // etiquetas, el listado y la metadata de las tarjetas se refrescan.
  const data = query.data;
  const signature =
    data === undefined
      ? ""
      : [data.mediaId, data.cutoutMediaId, data.background, data.tagging].join("|");
  useEffect(() => {
    if (signature === "" || signature.startsWith("|")) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.media() });
    void queryClient.invalidateQueries({ queryKey: ["media", "meta"] });
  }, [signature, queryClient]);
  return query;
}

/**
 * Metadata de los clips importados (etiquetas, origen) para las tarjetas.
 * Una sola petición por página de la grid; los que no tienen metadata no
 * vuelven.
 */
export function useMediaMeta(
  mediaIds: readonly string[],
): ReadonlyMap<string, MediaMetaView> {
  const ids = [...mediaIds].sort().slice(0, 100);
  const query = useApiQuery<MediaMetaView[]>({
    queryKey: ["media", "meta", ids.join(",")],
    path: "/media/meta",
    query: { ids: ids.join(",") },
    schema: mediaMetaListSchema,
    enabled: ids.length > 0,
    staleTime: 30_000,
  });
  const map = new Map<string, MediaMetaView>();
  for (const meta of query.data ?? []) map.set(meta.mediaId, meta);
  return map;
}
