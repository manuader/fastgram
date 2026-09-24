"use client";

/**
 * La cola de subida del Media Bank · `PU-MEDIA-001`, FR-100, §9.8.
 *
 * Cada archivo recorre los mismos tres pasos que el video custom del Studio
 * (`lib/studio/custom-video.ts`) —reserva → PUT firmado → finalización— y la
 * política de reintento es **la misma** (`policy.ts`): si cae el PUT se vuelve
 * a reservar (gratis); si cae la finalización se repite sólo el paso 3 con el
 * mismo `uploadId` y la misma `Idempotency-Key`.
 *
 * Lo que agrega esta cola sobre aquel flujo de un archivo:
 *
 * · **Varios a la vez, con tope de concurrencia.** `MAX_CONCURRENT_UPLOADS`
 *   PUTs en vuelo; el resto espera en `queued`. Sin tope, soltar 30 fotos abre
 *   30 conexiones contra el storage y el ancho de subida se reparte entre
 *   todas: ninguna termina hasta que terminan todas, y el usuario no puede
 *   empezar a categorizar nada.
 * · **El fallo de uno no frena a los demás.** Cada archivo es su propia
 *   máquina; un `failed` libera su lugar en la concurrencia y la cola sigue.
 * · **Categorías al terminar.** Al finalizar, cada asset queda con una
 *   sugerencia (`suggestCategories`) que el usuario confirma, cambia o
 *   aplica a toda la tanda del mismo tipo. Confirmar es `PATCH /media/:id`.
 *
 * Igual que `useCustomVideoUpload`, **no es un `useMutation`**: son tres
 * peticiones con estado compartido y dos puntos de reanudación, por archivo.
 *
 * ## Lo que no hace
 *
 * - No suelta una reserva cancelada: la API no ofrece cómo (ver
 *   `ABANDONED_UPLOAD_NOTE` en `custom-video.ts`). Caduca con la URL firmada.
 * - No sobrevive a una recarga: la cola vive en memoria. Un archivo a medio
 *   subir al recargar se pierde, igual que en cualquier `<input type=file>`.
 */
import {
  mediaSchema,
  mediaUploadReservationRequestSchema,
  uploadContentTypeSchema,
  uploadReservationSchema,
  UPLOAD_IMAGE_MAX_MB,
  UPLOAD_VIDEO_MAX_MB,
  type FinalizeMediaRequest,
  type Media,
  type MediaCategory,
  type MediaType,
  type MediaUploadReservationRequest,
  type UploadId,
  type UploadReservation,
} from "@fastgram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { apiRequest } from "../../api/client";
import type { ApiRequestError } from "../../api/errors";
import { newIdempotencyKey } from "../../api/idempotency-key";
import { queryKeys } from "../../api/keys";
import { suggestCategories, toggleCategory, type VideoDimensions } from "../categories";
import { MEDIA_PATH } from "../media";
import { patchMediaCategories } from "../mutations";
import {
  acceptFor,
  asApiError,
  checkUpload,
  contentTypeFrom,
  resumeFor,
  type FileCheck,
  type FileRejectionReason,
  type ResumePoint,
  type UploadCandidate,
  type UploadStep,
} from "./policy";
import { probeVideoDimensions } from "./probe";
import { isSignedUploadError, putSignedUpload } from "./transport";

/** §9.8 — la reserva del Media Bank. */
export const MEDIA_RESERVE_PATH = "/media/upload-url";

/** PUTs simultáneos. Decisión de esta tarea: ver la cabecera. */
export const MAX_CONCURRENT_UPLOADS = 3;

/** `image/jpeg`, `image/png`, `image/webp`, `video/mp4`, `video/quicktime`. */
export const MEDIA_UPLOAD_CONTENT_TYPES: readonly string[] =
  uploadContentTypeSchema.options.flatMap((schema) => schema.options);

export const MEDIA_UPLOAD_ACCEPT: string = acceptFor(MEDIA_UPLOAD_CONTENT_TYPES);

/** NFR-013, vía contrato. */
export const MEDIA_MAX_MB: Readonly<Record<MediaType, number>> = {
  image: UPLOAD_IMAGE_MAX_MB,
  video: UPLOAD_VIDEO_MAX_MB,
};

/** ¿Entra? Lo decide `mediaUploadReservationRequestSchema`, el mismo de la API. */
export function describeMediaUpload(
  file: UploadCandidate,
): FileCheck<MediaUploadReservationRequest> {
  return checkUpload(
    file,
    mediaUploadReservationRequestSchema,
    MEDIA_UPLOAD_CONTENT_TYPES,
  );
}

/**
 * El tipo de asset que va a ser, **antes** de subirlo. Sale del content type
 * declarado (o deducido por extensión); `null` si no es ninguno de los dos, y
 * entonces el archivo se rechaza igual.
 */
export function mediaTypeOfCandidate(file: UploadCandidate): MediaType | null {
  const contentType = contentTypeFrom(file, MEDIA_UPLOAD_CONTENT_TYPES);
  if (!MEDIA_UPLOAD_CONTENT_TYPES.includes(contentType)) return null;
  return contentType.startsWith("image/") ? "image" : "video";
}

export type UploadPhase =
  | "queued"
  | "reserving"
  | "uploading"
  | "finalizing"
  | "done"
  | "failed"
  | "rejected"
  | "cancelled";

/**
 * Las categorías de un asset recién subido.
 *
 * · `editing` — con la sugerencia puesta, esperando que el usuario confirme.
 * · `saving` / `saved` / `failed` — el `PATCH`.
 * · `skipped` — el usuario eligió no categorizar ahora: el asset queda con
 *   `[]` (fuera de los pools de Blitz, FR-100) y se edita desde su tarjeta.
 */
export type CategoriesState = "editing" | "saving" | "saved" | "failed" | "skipped";

export interface UploadItem {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  /** `null` sólo en un archivo rechazado que no es imagen ni video. */
  readonly mediaType: MediaType | null;
  readonly phase: UploadPhase;
  /** `null` = el navegador todavía no sabe el total. */
  readonly percent: number | null;
  readonly step: UploadStep | null;
  readonly resume: ResumePoint | null;
  /** `null` cuando falló el PUT: responde el storage, no la API v1. */
  readonly error: ApiRequestError | null;
  readonly rejection: FileRejectionReason | null;
  readonly media: Media | null;
  readonly categories: readonly MediaCategory[];
  readonly categoriesState: CategoriesState;
  readonly categoriesError: ApiRequestError | null;
}

const BUSY: ReadonlySet<UploadPhase> = new Set([
  "queued",
  "reserving",
  "uploading",
  "finalizing",
]);
const FINISHED: ReadonlySet<UploadPhase> = new Set(["done", "rejected", "cancelled"]);

export function isBusyItem(item: UploadItem): boolean {
  return BUSY.has(item.phase);
}

/**
 * ¿Le falta algo al usuario en esta fila? Un asset subido pero sin confirmar
 * sus categorías todavía pide atención; uno guardado u omitido, no.
 */
export function needsAttention(item: UploadItem): boolean {
  if (item.phase === "failed") return true;
  if (item.phase !== "done") return false;
  return item.categoriesState === "editing" || item.categoriesState === "failed";
}

/** Una fila que ya no tiene nada que hacer y se puede sacar de la cola. */
export function isSettled(item: UploadItem): boolean {
  return (
    FINISHED.has(item.phase) && !needsAttention(item) && item.categoriesState !== "saving"
  );
}

/**
 * Los assets de la tanda que recibirían un "Apply to all" desde `source`:
 * mismo tipo (las categorías son válidas por tipo), ya subidos y todavía sin
 * confirmar. El propio `source` va incluido.
 */
export function applyToAllTargets(
  items: readonly UploadItem[],
  source: UploadItem,
): readonly UploadItem[] {
  return items.filter(
    (item) =>
      item.mediaType === source.mediaType &&
      item.phase === "done" &&
      item.media !== null &&
      (item.categoriesState === "editing" || item.categoriesState === "failed"),
  );
}

type Action =
  | { readonly type: "add"; readonly items: readonly UploadItem[] }
  | { readonly type: "patch"; readonly id: string; readonly patch: Partial<UploadItem> }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "clearSettled" };

export function uploadQueueReducer(
  state: readonly UploadItem[],
  action: Action,
): readonly UploadItem[] {
  switch (action.type) {
    case "add":
      return [...state, ...action.items];
    case "patch":
      return state.map((item) =>
        item.id === action.id ? { ...item, ...action.patch } : item,
      );
    case "remove":
      return state.filter((item) => item.id !== action.id);
    case "clearSettled":
      return state.filter((item) => !isSettled(item));
  }
}

/** Lo que no se dibuja: el archivo y lo necesario para retomar. */
interface Runtime {
  readonly file: File;
  uploadId: UploadId | null;
  idempotencyKey: string | null;
  abort: AbortController | null;
  from: ResumePoint;
  readonly dimensions: Promise<VideoDimensions | null>;
}

export interface MediaUploadQueue {
  readonly items: readonly UploadItem[];
  readonly add: (files: Iterable<File>) => void;
  readonly retry: (id: string) => void;
  readonly cancel: (id: string) => void;
  readonly dismiss: (id: string) => void;
  readonly clearSettled: () => void;
  readonly toggleCategory: (id: string, category: MediaCategory) => void;
  readonly confirmCategories: (id: string) => void;
  readonly skipCategories: (id: string) => void;
  /** Aplica las categorías de `id` a toda la tanda del mismo tipo, y las guarda. */
  readonly applyToAll: (id: string) => void;
}

export interface UseMediaUploadQueueOptions {
  /** Inyectable para tests; por defecto mide el video en el navegador. */
  readonly probe?: (file: File) => Promise<VideoDimensions | null>;
}

function baseItem(id: string, file: File): UploadItem {
  return {
    id,
    name: file.name,
    sizeBytes: file.size,
    mediaType: mediaTypeOfCandidate(file),
    phase: "queued",
    percent: null,
    step: null,
    resume: null,
    error: null,
    rejection: null,
    media: null,
    categories: [],
    categoriesState: "editing",
    categoriesError: null,
  };
}

function isAbort(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (isSignedUploadError(cause) && cause.aborted)
  );
}

export function useMediaUploadQueue(
  options: UseMediaUploadQueueOptions = {},
): MediaUploadQueue {
  const probe = options.probe ?? probeVideoDimensions;
  const queryClient = useQueryClient();
  const [items, dispatch] = useReducer(uploadQueueReducer, []);

  const itemsRef = useRef<readonly UploadItem[]>(items);
  const runtimeRef = useRef(new Map<string, Runtime>());
  const waitingRef = useRef<string[]>([]);
  const activeRef = useRef(0);
  const counterRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    aliveRef.current = true;
    const runtimes = runtimeRef.current;
    return () => {
      aliveRef.current = false;
      // Desmontar con PUTs en vuelo: se cortan. No queda quién finalice.
      for (const runtime of runtimes.values()) runtime.abort?.abort();
    };
  }, []);

  const patch = useCallback((id: string, next: Partial<UploadItem>) => {
    if (aliveRef.current) dispatch({ type: "patch", id, patch: next });
  }, []);

  const invalidateList = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.media() });
  }, [queryClient]);

  const run = useCallback(
    async (id: string): Promise<void> => {
      const runtime = runtimeRef.current.get(id);
      if (runtime === undefined) return;
      const { file } = runtime;

      if (runtime.from === "restart") {
        const check = describeMediaUpload(file);
        if (!check.ok) {
          patch(id, { phase: "rejected", rejection: check.reason });
          return;
        }

        const controller = new AbortController();
        runtime.abort = controller;
        patch(id, {
          phase: "reserving",
          percent: null,
          error: null,
          step: null,
          resume: null,
        });

        let reservation: UploadReservation;
        try {
          reservation = await apiRequest<UploadReservation>(MEDIA_RESERVE_PATH, {
            method: "POST",
            body: check.body,
            schema: uploadReservationSchema,
            signal: controller.signal,
          });
        } catch (cause) {
          runtime.abort = null;
          if (isAbort(cause)) {
            patch(id, { phase: "cancelled" });
            return;
          }
          const error = asApiError(cause);
          patch(id, {
            phase: "failed",
            step: "reserve",
            resume: resumeFor("reserve", error),
            error,
          });
          return;
        }

        runtime.uploadId = reservation.uploadId;
        // Una key por reserva: dos subidas del mismo archivo son dos assets.
        runtime.idempotencyKey = newIdempotencyKey();
        patch(id, { phase: "uploading", percent: 0 });

        try {
          await putSignedUpload({
            url: reservation.uploadUrl,
            method: reservation.method,
            // `content-length` viene firmado pero el navegador no deja ponerlo:
            // lo filtra `transport.ts` y lo calcula el navegador del `Blob`.
            headers: reservation.headers,
            body: file,
            signal: controller.signal,
            onProgress: (percent) => {
              patch(id, { percent });
            },
          });
        } catch (cause) {
          runtime.abort = null;
          if (isAbort(cause)) {
            patch(id, { phase: "cancelled" });
            return;
          }
          patch(id, {
            phase: "failed",
            step: "transfer",
            resume: "restart",
            error: null,
          });
          return;
        }
        runtime.abort = null;
      }

      const uploadId = runtime.uploadId;
      if (uploadId === null) {
        patch(id, { phase: "failed", step: "transfer", resume: "restart", error: null });
        return;
      }

      patch(id, { phase: "finalizing", error: null });
      let media: Media;
      try {
        media = await apiRequest<Media>(MEDIA_PATH, {
          method: "POST",
          body: { uploadId } satisfies FinalizeMediaRequest,
          schema: mediaSchema,
          ...(runtime.idempotencyKey === null
            ? {}
            : { idempotencyKey: runtime.idempotencyKey }),
        });
      } catch (cause) {
        const error = asApiError(cause);
        patch(id, {
          phase: "failed",
          step: "finalize",
          resume: resumeFor("finalize", error),
          error,
        });
        return;
      }

      // El asset ya existe: la grid lo tiene que ver aunque el usuario no
      // confirme nunca las categorías.
      invalidateList();
      const dimensions = media.mediaType === "video" ? await runtime.dimensions : null;
      patch(id, {
        phase: "done",
        percent: 100,
        media,
        categories: suggestCategories(media.mediaType, dimensions),
        categoriesState: "editing",
      });
    },
    [invalidateList, patch],
  );

  const pump = useCallback(() => {
    while (activeRef.current < MAX_CONCURRENT_UPLOADS && waitingRef.current.length > 0) {
      const id = waitingRef.current.shift();
      if (id === undefined) break;
      activeRef.current += 1;
      void run(id).finally(() => {
        activeRef.current -= 1;
        if (aliveRef.current) pump();
      });
    }
  }, [run]);

  const add = useCallback(
    (files: Iterable<File>) => {
      const fresh: UploadItem[] = [];
      for (const file of files) {
        counterRef.current += 1;
        const id = `upload-${String(counterRef.current)}`;
        const item = baseItem(id, file);
        const check = describeMediaUpload(file);
        if (!check.ok) {
          // Rechazado antes de reservar: no deja rastro en el servidor.
          fresh.push({ ...item, phase: "rejected", rejection: check.reason });
          continue;
        }
        runtimeRef.current.set(id, {
          file,
          uploadId: null,
          idempotencyKey: null,
          abort: null,
          from: "restart",
          // Se mide mientras sube: cuando termine, la sugerencia ya está.
          dimensions: item.mediaType === "video" ? probe(file) : Promise.resolve(null),
        });
        fresh.push(item);
        waitingRef.current.push(id);
      }
      if (fresh.length === 0) return;
      dispatch({ type: "add", items: fresh });
      pump();
    },
    [probe, pump],
  );

  const retry = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      const runtime = runtimeRef.current.get(id);
      if (item === undefined || runtime === undefined) return;
      const from: ResumePoint =
        item.phase === "failed" && item.resume !== null ? item.resume : "restart";
      if (from === "none") return;
      if (from === "restart") {
        runtime.uploadId = null;
        runtime.idempotencyKey = null;
      }
      runtime.from = from;
      patch(id, { phase: "queued", percent: null, error: null });
      waitingRef.current.push(id);
      pump();
    },
    [patch, pump],
  );

  const cancel = useCallback(
    (id: string) => {
      const waiting = waitingRef.current.indexOf(id);
      if (waiting >= 0) {
        waitingRef.current.splice(waiting, 1);
        patch(id, { phase: "cancelled" });
        return;
      }
      // Reserva o PUT en vuelo: el abort lo resuelve `run`. La finalización no
      // se corta: el servidor puede haber creado el asset igual.
      runtimeRef.current.get(id)?.abort?.abort();
    },
    [patch],
  );

  const dismiss = useCallback((id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (item !== undefined && isBusyItem(item)) return;
    runtimeRef.current.delete(id);
    dispatch({ type: "remove", id });
  }, []);

  const clearSettled = useCallback(() => {
    for (const item of itemsRef.current) {
      if (isSettled(item)) runtimeRef.current.delete(item.id);
    }
    dispatch({ type: "clearSettled" });
  }, []);

  const toggle = useCallback(
    (id: string, category: MediaCategory) => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (item?.media == null) return;
      const next = toggleCategory(item.media.mediaType, item.categories, category);
      // Actualiza la ref ya: dos toques seguidos antes del render no se pisan.
      itemsRef.current = itemsRef.current.map((candidate) =>
        candidate.id === id ? { ...candidate, categories: next } : candidate,
      );
      patch(id, { categories: next });
    },
    [patch],
  );

  const save = useCallback(
    async (id: string, categories: readonly MediaCategory[]): Promise<void> => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (item?.media == null) return;
      patch(id, { categories, categoriesState: "saving", categoriesError: null });
      try {
        const media = await patchMediaCategories(item.media.mediaId, categories);
        patch(id, { media, categories: media.categories, categoriesState: "saved" });
      } catch (cause) {
        patch(id, { categoriesState: "failed", categoriesError: asApiError(cause) });
      }
    },
    [patch],
  );

  const confirmCategories = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (item === undefined) return;
      void save(id, item.categories).then(invalidateList);
    },
    [invalidateList, save],
  );

  const applyToAll = useCallback(
    (id: string) => {
      const source = itemsRef.current.find((candidate) => candidate.id === id);
      if (source === undefined) return;
      const targets = applyToAllTargets(itemsRef.current, source);
      void Promise.all(targets.map((target) => save(target.id, source.categories))).then(
        invalidateList,
      );
    },
    [invalidateList, save],
  );

  const skipCategories = useCallback(
    (id: string) => {
      patch(id, { categoriesState: "skipped" });
    },
    [patch],
  );

  return {
    items,
    add,
    retry,
    cancel,
    dismiss,
    clearSettled,
    toggleCategory: toggle,
    confirmCategories,
    skipCategories,
    applyToAll,
  };
}
