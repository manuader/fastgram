"use client";

/**
 * Subida de un video propio como contenido · `F-083` (PRD:525), `FR-070`
 * (PRD:1463), §9.8 (PRD:2347).
 *
 * ## Son tres pasos, no uno, y cada uno falla distinto
 *
 *   1. `POST /content/custom/video/upload-url` → `{uploadId, uploadUrl,
 *      method, headers, expiresAt}`. Es **free** en la tabla de facturación
 *      (PRD:2285): repetirla no cuesta nada.
 *   2. `PUT` directo a `uploadUrl` con los headers de la reserva. No pasa por
 *      la API: ver `upload-transport.ts`.
 *   3. `POST /content/custom/video` con `{uploadId}` → la pieza, que nace en
 *      `BUILDING`. Es **usage** (PRD:2286): consume un content save.
 *
 * Que el paso 1 sea gratis y el 3 se cobre es lo que decide cómo se reintenta,
 * y es la decisión central de este módulo:
 *
 * · si falla el **PUT**, se reintenta desde la reserva — una reserva nueva no
 *   cuesta nada y la vieja ya no sirve de mucho;
 * · si falla la **finalización**, se reintenta **sólo el paso 3**, con el mismo
 *   `uploadId` y la **misma `Idempotency-Key`**. Volver a subir 50 MB porque
 *   una petición JSON de 40 bytes se cortó es exactamente el desperdicio que
 *   este flujo existe para evitar; y sin la key, una finalización que el
 *   servidor sí procesó y cuya respuesta se perdió se cobraría **dos veces**
 *   (`NFR-004`, PRD:2954 — la ruta acepta la key aunque no la exija).
 * · salvo que el fallo sea `410 gone`: ahí la reserva caducó y repetir el paso
 *   3 da otro `410`. Eso sí se empieza de cero.
 *
 * ## El límite de 50 MB sale del contrato, no de un número escrito acá
 *
 * `videoUploadReservationRequestSchema` es **el mismo schema** que valida el
 * body en `apps/api/src/routes/v1/content.ts`. Comprobar el archivo con él
 * —en vez de con un `if (size > 50 * 1024 * 1024)`— ata las tres reglas a la
 * vez: el techo (`UPLOAD_VIDEO_MAX_MB`), el enum de content types
 * (`video/mp4`, `video/quicktime`) y la coherencia extensión↔tipo de §9.8. Un
 * límite de cliente que **no coincida** con el del servidor es peor que no
 * tener ninguno: promete que un archivo entra y el servidor lo rechaza, o
 * rechaza uno que habría entrado. Acá no pueden discrepar porque es una sola
 * definición.
 *
 * Y comprobarlo en el cliente no lo vuelve redundante: sin el chequeo, subir
 * 200 MB para que el paso 1 los rechace tira 200 MB de subida del usuario —
 * salvo que ni siquiera lleguen a salir, porque el rechazo ocurre en el paso 1,
 * **antes** del PUT. Lo que ahorra el chequeo local no son bytes sino la
 * espera y una petición: el usuario ve el motivo al instante y con su número
 * ("son 62,4 MB, el tope es 50"), que es lo que el `400` con `issues` de Zod no
 * le puede decir en su idioma.
 *
 * ## Lo que este módulo NO hace
 *
 * - **No sube imágenes**, aunque la tarjeta del formato diga "Upload your own
 *   video or image" (PRD:536). El único endpoint de finalización de contenido
 *   custom es `/content/custom/video` y su reserva sólo acepta los dos content
 *   types de video. Una imagen no tiene por dónde entrar como *contenido*: lo
 *   que hay es `POST /media`, que es el Media Bank y es otra cosa.
 * - **No limpia** una reserva abandonada. Ver `ABANDONED_UPLOAD_NOTE`.
 */
import {
  contentSchema,
  mbToBytes,
  uploadReservationSchema,
  UPLOAD_VIDEO_MAX_MB,
  videoContentTypeSchema,
  videoUploadReservationRequestSchema,
  type Content,
  type UploadReservation,
  type VideoUploadReservationRequest,
} from "@fastgram/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import { newIdempotencyKey } from "../api/idempotency-key";
import type { ApiRequestError } from "../api/errors";
import { queryKeys } from "../api/keys";
import {
  acceptFor,
  asApiError,
  checkUpload,
  contentTypeFrom,
  extensionsFor,
  resumeFor,
  type FileCheck as SharedFileCheck,
  type FileRejectionReason,
  type ResumePoint,
  type UploadCandidate,
  type UploadStep,
} from "../media/upload/policy";
import { putSignedUpload, isSignedUploadError } from "./upload-transport";

// La política (deducir el tipo, traducir el issue de Zod, desde dónde se
// retoma) vive en `lib/media/upload/policy.ts` desde `PU-MEDIA-001`, porque la
// comparte el Media Bank. Se re-exporta con los nombres de siempre.
export { resumeFor, sizeInMb } from "../media/upload/policy";
export type {
  FileRejectionReason,
  ResumePoint,
  UploadCandidate,
  UploadStep,
} from "../media/upload/policy";

/** §9.8 — la reserva. `free` en la tabla de facturación (PRD:2285). */
export const CUSTOM_VIDEO_RESERVE_PATH = "/content/custom/video/upload-url";
/** §9.8 — la finalización. `usage`: consume un content save (PRD:2286). */
export const CUSTOM_VIDEO_PATH = "/content/custom/video";

/** El id del formato del hub que abre esta pantalla (PRD:536). */
export const CUSTOM_FORMAT_ID = "custom";

/** NFR-013 (PRD:2963), vía contrato. Nunca un `50` escrito a mano. */
export const CUSTOM_VIDEO_MAX_MB = UPLOAD_VIDEO_MAX_MB;
export const CUSTOM_VIDEO_MAX_BYTES = mbToBytes(UPLOAD_VIDEO_MAX_MB);

/** `["video/mp4", "video/quicktime"]`, del enum de §9.8. */
export const CUSTOM_VIDEO_CONTENT_TYPES: readonly string[] =
  videoContentTypeSchema.options;

/** `[".mp4", ".mov"]` — las extensiones que el contrato ata a esos tipos. */
export const CUSTOM_VIDEO_EXTENSIONS: readonly string[] = extensionsFor(
  CUSTOM_VIDEO_CONTENT_TYPES,
);

/** El `accept` del `<input type="file">`: ver `acceptFor`. */
export const CUSTOM_VIDEO_ACCEPT: string = acceptFor(CUSTOM_VIDEO_CONTENT_TYPES);

export type FileCheck = SharedFileCheck<VideoUploadReservationRequest>;

/** El content type que se va a **declarar** en la reserva: ver `contentTypeFrom`. */
export function contentTypeFor(file: UploadCandidate): string {
  return contentTypeFrom(file, CUSTOM_VIDEO_CONTENT_TYPES);
}

/**
 * ¿Entra este archivo? Lo decide `videoUploadReservationRequestSchema`, el
 * mismo schema que valida el body en `apps/api/src/routes/v1/content.ts`.
 */
export function describeUpload(file: UploadCandidate): FileCheck {
  return checkUpload(
    file,
    videoUploadReservationRequestSchema,
    CUSTOM_VIDEO_CONTENT_TYPES,
  );
}

/**
 * **Hueco conocido, y no se inventa la salida.**
 *
 * Una reserva que nadie finaliza deja una fila `reserved` en
 * `upload_reservations`, y si el PUT sí entró, además un objeto en el bucket
 * que no cuelga de ninguna pieza. La API **no ofrece nada** para soltarla: no
 * hay `DELETE /content/custom/video/upload-url/:id`, `canFinalize` sólo la
 * caduca por tiempo (la reserva vive lo que la URL firmada, 3600 s), y no hay
 * ningún barrido en `apps/worker` que borre las expiradas ni los objetos
 * huérfanos.
 *
 * Lo que sí se puede hacer desde acá es **no empeorarlo**: no se reserva hasta
 * que el archivo pasó la política, así que un archivo rechazado no deja rastro.
 * Lo demás es trabajo de servidor y queda reportado.
 */
export const ABANDONED_UPLOAD_NOTE =
  "A cancelled upload leaves a reservation that only expires with its signed URL; nothing here can release it.";

export interface UploadFileSummary {
  readonly name: string;
  readonly sizeBytes: number;
}

export type CustomVideoPhase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "rejected";
      readonly reason: FileRejectionReason;
      readonly file: UploadFileSummary;
    }
  | { readonly kind: "reserving"; readonly file: UploadFileSummary }
  | {
      readonly kind: "uploading";
      readonly file: UploadFileSummary;
      readonly percent: number | null;
    }
  | { readonly kind: "finalizing"; readonly file: UploadFileSummary }
  | {
      readonly kind: "failed";
      readonly file: UploadFileSummary;
      readonly step: UploadStep;
      readonly resume: ResumePoint;
      /** `null` cuando el que falló fue el PUT: ahí no hay error del contrato. */
      readonly error: ApiRequestError | null;
    }
  | { readonly kind: "done"; readonly content: Content };

const BUSY_KINDS: ReadonlySet<CustomVideoPhase["kind"]> = new Set([
  "reserving",
  "uploading",
  "finalizing",
]);

export function isBusy(phase: CustomVideoPhase): boolean {
  return BUSY_KINDS.has(phase.kind);
}

export interface CustomVideoUploadController {
  readonly phase: CustomVideoPhase;
  readonly busy: boolean;
  /** Empieza de cero con el archivo elegido. */
  readonly start: (file: File) => void;
  /** Retoma el último fallo por donde corresponda. */
  readonly retry: () => void;
  /** Corta el PUT en curso y vuelve al estado inicial. */
  readonly cancel: () => void;
  /** Vuelve al estado inicial tras un éxito o un rechazo. */
  readonly reset: () => void;
}

/**
 * La máquina de los tres pasos.
 *
 * **No es un `useMutation`** y la ausencia es deliberada: TanStack modela *una*
 * petición con un resultado, y esto son tres peticiones con un estado
 * compartido (`uploadId`, la key de idempotencia, el porcentaje) y dos puntos
 * de reanudación distintos. Con tres mutaciones encadenadas el estado vive
 * igual fuera de ellas y encima se reparte en tres sitios. Lo que sí se usa del
 * `QueryClient` es lo único que hace falta: invalidar el listado de contenido
 * cuando la pieza ya existe.
 */
export function useCustomVideoUpload(): CustomVideoUploadController {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<CustomVideoPhase>({ kind: "idle" });

  const fileRef = useRef<File | null>(null);
  const uploadIdRef = useRef<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // Desmontar con el PUT en vuelo: se corta. Dejarlo correr no serviría a
      // nadie —no queda quién finalice— y seguiría ocupando la subida.
      abortRef.current?.abort();
    };
  }, []);

  const put = useCallback((next: CustomVideoPhase) => {
    if (aliveRef.current) setPhase(next);
  }, []);

  const run = useCallback(
    async (file: File, from: ResumePoint): Promise<void> => {
      const summary: UploadFileSummary = { name: file.name, sizeBytes: file.size };

      if (from === "restart") {
        const check = describeUpload(file);
        if (!check.ok) {
          put({ kind: "rejected", reason: check.reason, file: summary });
          return;
        }

        put({ kind: "reserving", file: summary });
        let reservation: UploadReservation;
        try {
          reservation = await apiRequest<UploadReservation>(CUSTOM_VIDEO_RESERVE_PATH, {
            method: "POST",
            body: check.body,
            schema: uploadReservationSchema,
          });
        } catch (cause) {
          const error = asApiError(cause);
          put({
            kind: "failed",
            file: summary,
            step: "reserve",
            resume: resumeFor("reserve", error),
            error,
          });
          return;
        }

        uploadIdRef.current = reservation.uploadId;
        // Una key por reserva: dos subidas distintas del mismo archivo son dos
        // piezas, y compartir la key haría que la segunda devolviera la
        // primera.
        idempotencyKeyRef.current = newIdempotencyKey();

        const controller = new AbortController();
        abortRef.current = controller;
        put({ kind: "uploading", file: summary, percent: 0 });

        try {
          await putSignedUpload({
            url: reservation.uploadUrl,
            method: reservation.method,
            headers: reservation.headers,
            body: file,
            signal: controller.signal,
            onProgress: (percent) => {
              put({ kind: "uploading", file: summary, percent });
            },
          });
        } catch (cause) {
          abortRef.current = null;
          if (isSignedUploadError(cause) && cause.aborted) {
            put({ kind: "idle" });
            return;
          }
          // Sin `error`: lo que respondió es el storage, no la API v1. La
          // pantalla pone copy propia en vez de traducir un código inventado.
          put({
            kind: "failed",
            file: summary,
            step: "transfer",
            resume: "restart",
            error: null,
          });
          return;
        }
        abortRef.current = null;
      }

      const uploadId = uploadIdRef.current;
      if (uploadId === null) {
        // Inalcanzable por la UI —no hay botón que finalice sin reserva— pero
        // es el estado que haría `POST /content/custom/video` sin `uploadId`.
        put({
          kind: "failed",
          file: summary,
          step: "transfer",
          resume: "restart",
          error: null,
        });
        return;
      }

      put({ kind: "finalizing", file: summary });
      try {
        const content = await apiRequest<Content>(CUSTOM_VIDEO_PATH, {
          method: "POST",
          body: { uploadId },
          schema: contentSchema,
          ...(idempotencyKeyRef.current === null
            ? {}
            : { idempotencyKey: idempotencyKeyRef.current }),
        });
        put({ kind: "done", content });
        // La pieza ya existe y el listado tiene `staleTime` de 30 s: sin esto,
        // ir a la Library dentro de ese medio minuto la enseña sin ella.
        void queryClient.invalidateQueries({ queryKey: queryKeys.content() });
      } catch (cause) {
        const error = asApiError(cause);
        put({
          kind: "failed",
          file: summary,
          step: "finalize",
          resume: resumeFor("finalize", error),
          error,
        });
      }
    },
    [put, queryClient],
  );

  const start = useCallback(
    (file: File) => {
      fileRef.current = file;
      uploadIdRef.current = null;
      idempotencyKeyRef.current = null;
      void run(file, "restart");
    },
    [run],
  );

  const retry = useCallback(() => {
    const file = fileRef.current;
    if (file === null) return;
    const from: ResumePoint = phase.kind === "failed" ? phase.resume : "restart";
    // `none` no tiene botón en pantalla; si llegara igual, no se hace nada.
    if (from === "none") return;
    if (from === "restart") {
      uploadIdRef.current = null;
      idempotencyKeyRef.current = null;
    }
    void run(file, from);
  }, [phase, run]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    fileRef.current = null;
    uploadIdRef.current = null;
    idempotencyKeyRef.current = null;
    setPhase({ kind: "idle" });
  }, []);

  return { phase, busy: isBusy(phase), start, retry, cancel, reset };
}
