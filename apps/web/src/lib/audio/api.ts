"use client";

/**
 * La biblioteca de audio de la marca · sprint 7 (`/audio/library`, migración
 * `0025`).
 *
 * La usan dos pantallas: el modal `Select Audio` del editor (FR-053) y el panel
 * de audio de la Library (`BrandAudioPanel`). Las dos cuelgan de la misma
 * clave, así que subir, renombrar o borrar en una refresca la otra.
 *
 * La subida es la de §9.8 en tres pasos, igual que el Media Bank: reserva →
 * PUT directo al storage (`putSignedUpload`) → finalización. Sin cola ni
 * reintentos por archivo: es un archivo por vez, chico (≤ 20 MB).
 */
import {
  BRAND_AUDIO_CONTENT_TYPES,
  BRAND_AUDIO_MAX_MB,
  BYTES_PER_MB,
  brandAudioContentTypeSchema,
  brandAudioTrackSchema,
  brandAudioUploadRequestSchema,
  uploadReservationSchema,
  type BrandAudioTrack,
  type BrandAudioUploadRequest,
  type UploadReservation,
} from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { apiRequest, apiSend } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiInfiniteQuery } from "../api/hooks";
import { putSignedUpload, type UploadProgress } from "../media/upload/transport";

export const AUDIO_LIBRARY_PATH = "/audio/library";

export const audioLibraryKeys = {
  all: () => ["audio-library"] as const,
  list: (q: string) => ["audio-library", "list", q] as const,
};

/** Página del listado: la biblioteca de una marca son decenas de pistas. */
export const AUDIO_PAGE_SIZE = 50;

/** `GET /audio/library?q=`. `q` vacío = todas. */
export function useBrandAudio(q: string, enabled = true) {
  const term = q.trim();
  return useApiInfiniteQuery<BrandAudioTrack>({
    queryKey: audioLibraryKeys.list(term),
    path: AUDIO_LIBRARY_PATH,
    ...(term === "" ? {} : { query: { q: term } }),
    itemSchema: brandAudioTrackSchema,
    limit: AUDIO_PAGE_SIZE,
    enabled,
  });
}

/** El `accept` del `<input type=file>`: tipos y extensiones. */
export const AUDIO_ACCEPT = [
  ...brandAudioContentTypeSchema.options,
  ...new Set(Object.values(BRAND_AUDIO_CONTENT_TYPES).flat()),
].join(",");

export type AudioFileRejection = "empty" | "too_large" | "unsupported_type";

/**
 * El cuerpo de la reserva para este archivo, o por qué no entra. El tipo se
 * deduce de la extensión si el navegador no lo dio (pasa con `.m4a`).
 */
export function audioReservationFor(file: {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}):
  | { readonly ok: true; readonly body: BrandAudioUploadRequest }
  | { readonly ok: false; readonly reason: AudioFileRejection } {
  if (file.size <= 0) return { ok: false, reason: "empty" };
  if (file.size > BRAND_AUDIO_MAX_MB * BYTES_PER_MB) {
    return { ok: false, reason: "too_large" };
  }
  const lower = file.name.toLowerCase();
  const declared = brandAudioContentTypeSchema.safeParse(file.type);
  const fromExtension = brandAudioContentTypeSchema.options.find((type) =>
    (BRAND_AUDIO_CONTENT_TYPES[type] ?? []).some((ext) => lower.endsWith(ext)),
  );
  // El declarado sólo vale si la extensión le corresponde: el servidor exige
  // las dos cosas, y un `.wav` con `audio/mpeg` sería un 400 igual.
  const contentType =
    declared.success &&
    (BRAND_AUDIO_CONTENT_TYPES[declared.data] ?? []).some((ext) => lower.endsWith(ext))
      ? declared.data
      : fromExtension;
  if (contentType === undefined) return { ok: false, reason: "unsupported_type" };
  const parsed = brandAudioUploadRequestSchema.safeParse({
    filename: file.name,
    contentType,
    sizeBytes: file.size,
  });
  if (!parsed.success) return { ok: false, reason: "unsupported_type" };
  return { ok: true, body: parsed.data };
}

export interface UploadAudioInput {
  readonly file: File;
  readonly onProgress?: UploadProgress;
  readonly signal?: AbortSignal;
}

/** Reserva → PUT → finalización. Lanza `ApiRequestError` o `SignedUploadError`. */
export async function uploadBrandAudio(
  input: UploadAudioInput,
): Promise<BrandAudioTrack> {
  const check = audioReservationFor(input.file);
  if (!check.ok) throw new Error(check.reason);
  const reservation = await apiRequest<UploadReservation>(
    `${AUDIO_LIBRARY_PATH}/upload-url`,
    { method: "POST", body: check.body, schema: uploadReservationSchema },
  );
  await putSignedUpload({
    url: reservation.uploadUrl,
    method: reservation.method,
    headers: reservation.headers,
    body: input.file,
    onProgress: input.onProgress,
    signal: input.signal,
  });
  return apiRequest<BrandAudioTrack>(AUDIO_LIBRARY_PATH, {
    method: "POST",
    body: { uploadId: reservation.uploadId },
    schema: brandAudioTrackSchema,
  });
}

export function useUploadBrandAudio(): UseMutationResult<
  BrandAudioTrack,
  Error,
  UploadAudioInput
> {
  const queryClient = useQueryClient();
  return useMutation<BrandAudioTrack, Error, UploadAudioInput>({
    mutationFn: uploadBrandAudio,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: audioLibraryKeys.all() });
    },
  });
}

const trackPath = (id: string): string =>
  `${AUDIO_LIBRARY_PATH}/${encodeURIComponent(id)}`;

export interface UpdateAudioInput {
  readonly id: string;
  readonly title?: string;
  readonly autoUse?: boolean;
}

export function useUpdateBrandAudio(): UseMutationResult<
  BrandAudioTrack,
  ApiRequestError,
  UpdateAudioInput
> {
  const queryClient = useQueryClient();
  return useMutation<BrandAudioTrack, ApiRequestError, UpdateAudioInput>({
    mutationFn: ({ id, ...patch }) =>
      apiRequest<BrandAudioTrack>(trackPath(id), {
        method: "PATCH",
        body: patch,
        schema: brandAudioTrackSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: audioLibraryKeys.all() });
    },
  });
}

export function useDeleteBrandAudio(): UseMutationResult<void, ApiRequestError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, string>({
    // `apiSend`: un `204` no trae sobre `{data}`.
    mutationFn: (id) => apiSend(trackPath(id), { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: audioLibraryKeys.all() });
    },
  });
}

/** `m:ss`, o `null` si la pista no trae duración (una subida). */
export function formatDuration(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m)}:${String(s).padStart(2, "0")}`;
}
