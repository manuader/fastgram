/**
 * El handler de `media-normalization` — PRD §9.5 #7, `NFR-014`, `FR-100`,
 * `DATA-010`, `ERR-P11`.
 *
 * `FR-100` es literal: *«los videos quedan `processing` y se normalizan en
 * background (MOV→MP4, HDR→SDR, faststart) hasta `ready` o `failed`»*. El
 * estado consultable es `media.status`, que `GET /media` y `GET /media/:id` ya
 * devuelven. Hasta acá `POST /media` dejaba el video en `processing` y nadie
 * lo sacaba de ahí.
 *
 * ## La forma: leer corto, trabajar largo, escribir corto
 *
 * ```
 *   [tx 1]  leer la fila (scopeada por companyId)             ~ms
 *           probe → (normalize → put)                         hasta 600 s
 *   [tx 2]  UPDATE … WHERE status='processing' AND storageKey=<la leída>
 * ```
 *
 * Por qué la escritura es un `UPDATE` condicional y no un bloqueo está en
 * `packages/db/src/repositories/media-normalization.ts`.
 *
 * ## Idempotencia ante reentrega
 *
 * - Si la fila ya no está en `processing`, no se hace nada: otra entrega
 *   terminó (`ready`) o se rindió (`failed`).
 * - El archivo normalizado se sube a una clave **única por ejecución**
 *   (`randomUUID`). Con una clave determinista, dos entregas solapadas
 *   escribirían el mismo objeto, y la que pierde la carrera del `UPDATE`
 *   **borraría el archivo de la que ganó** al descartar el suyo: la fila
 *   quedaría `ready` apuntando a nada. El precio de la clave única es un
 *   huérfano si el proceso muere entre el `put` y el `UPDATE`.
 *
 * ## Lo que este handler NO hace, porque el PRD no lo dice
 *
 * - **No borra el original.** Tras transcodificar, `storageKey`/`r2Url`
 *   apuntan al MP4 y el MOV queda en el bucket sin fila que lo referencie.
 *   Ni `FR-100` ni `DATA-010` ni §9.11 dicen si el original se conserva; borrar
 *   es irreversible y no se inventa.
 * - **No persiste el motivo del fallo.** `DATA-010` no tiene campo para eso: el
 *   código estable ({@link NormalizationFailureCode}) va al log.
 * - **No renombra `filename`** (`clip.mov` sigue diciendo `.mov`): es el nombre
 *   que eligió el usuario y el PRD no dice que cambie.
 * - **No normaliza el video custom** de `POST /content/custom/video`: esa
 *   pieza no crea fila en `media`; la normaliza su propio build con la misma
 *   función (`normalize-video.ts`, rama `custom` de `content/build-handler.ts`).
 *
 * ## HDR sin `zscale` (sprint 7, `0029`)
 *
 * Un video HDR que el servicio no puede pasar a SDR queda `ready` con el
 * original y `normalization = 'hdr_kept_original'` (ver `normalize-video.ts`).
 * Antes terminaba `failed` después de tres reintentos inútiles.
 */

import { randomUUID } from "node:crypto";

import { canonicalObjectUrl } from "@fastgram/adapters";
import { BYTES_PER_MB } from "@fastgram/contracts";
import {
  mediaNormalizationStore,
  withCompany,
  type MediaNormalizationOutcome,
  type Database,
  type MediaRow,
  type Transaction,
} from "@fastgram/db";
import {
  PortError,
  type Clock,
  type JobContext,
  type JobHandler,
  type MediaProbe,
  type MediaRenderer,
  type Storage,
  type StorageKey,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { normalizeVideo, videoNormalizationReasons } from "./normalize-video.js";
import { workspaceMediaAuthorization } from "../content/media-authorization.js";

/** `NFR-014`: «MOV→MP4». El único destino que el PRD nombra. */
export const NORMALIZED_CONTENT_TYPE = "video/mp4";

/**
 * El payload del job.
 *
 * **Está escrito dos veces**: acá y en `apps/api/src/routes/v1/media.ts`, que
 * lo produce. Su lugar es `@fastgram/core` junto a `parseContentBuildJob`, y no
 * está ahí porque `core` no era de esta tarea. Son dos campos; el invariante
 * que protege de la trampa 19 —el nombre de la cola— sí sale de `JOB_QUEUES`.
 */
export interface MediaNormalizationJob {
  readonly companyId: string;
  readonly mediaId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMediaNormalizationJob(
  payload: unknown,
): { ok: true; job: MediaNormalizationJob } | { ok: false; reason: string } {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "el payload no es un objeto" };
  }
  const { companyId, mediaId } = payload as Record<string, unknown>;
  // Se valida la forma de uuid y no sólo que sea string: la columna es `uuid`,
  // y un string cualquiera haría que Postgres lanzara `invalid input syntax`
  // —un error que se reintentaría tres veces como si fuera de infraestructura.
  if (typeof companyId !== "string" || !UUID.test(companyId)) {
    return { ok: false, reason: "companyId ausente o no es un uuid" };
  }
  if (typeof mediaId !== "string" || !UUID.test(mediaId)) {
    return { ok: false, reason: "mediaId ausente o no es un uuid" };
  }
  return { ok: true, job: { companyId, mediaId } };
}

/**
 * ¿Hace falta transcodificar? Las tres condiciones de `NFR-014`, una por una.
 *
 * `MediaProbe.contentType` es lo que el motor **midió**, no lo que declaró el
 * cliente: un MOV subido como `video/mp4` se detecta acá (`services/render`
 * lo distingue por el `major_brand`, `ffmpeg/probe.ts`).
 */
export function normalizationReasons(probe: MediaProbe): readonly string[] {
  return videoNormalizationReasons(probe);
}

/**
 * Códigos estables del fallo. Van al log —`DATA-010` no tiene dónde
 * persistirlos— y **nunca** el mensaje crudo del proveedor como código.
 */
export type NormalizationFailureCode =
  /** `ERR-P11`: el archivo no se pudo leer. Reintentar no lo arregla. */
  | "media_unreadable"
  /** El motor no respondió a tiempo o no tiene capacidad. Transitorio. */
  | "renderer_unavailable"
  /** El motor rechazó la autorización. Es configuración, no el archivo. */
  | "renderer_rejected"
  /** El motor devolvió algo que no cumple el puerto. */
  | "renderer_contract_violation"
  /** Cualquier otro error del puerto: storage, conflicto, etc. */
  | "normalization_failed"
  /** No es un `PortError`: bug nuestro o caída de la base. */
  | "internal_error";

export interface NormalizationFailure {
  readonly code: NormalizationFailureCode;
  readonly retryable: boolean;
  readonly cause: unknown;
}

/** Traduce cualquier error a un código estable y decide si vale otro intento. */
export function classifyNormalizationError(error: unknown): NormalizationFailure {
  if (error instanceof PortError) {
    switch (error.code) {
      case "bad_request":
      case "not_found":
        return { code: "media_unreadable", retryable: false, cause: error };
      case "provider_unavailable":
      case "timeout":
      case "rate_limited":
        return { code: "renderer_unavailable", retryable: true, cause: error };
      case "forbidden":
      case "unauthorized":
        return { code: "renderer_rejected", retryable: false, cause: error };
      case "provider_contract_violation":
        return { code: "renderer_contract_violation", retryable: false, cause: error };
      default:
        return { code: "normalization_failed", retryable: false, cause: error };
    }
  }
  // Mismo criterio que `content-build`: lo que no es del puerto suele ser una
  // caída de infraestructura, y un bug determinista termina igual en `failed`
  // al último intento.
  return { code: "internal_error", retryable: true, cause: error };
}

export interface MediaNormalizationDeps {
  readonly db: Database;
  readonly renderer: MediaRenderer;
  readonly storage: Storage;
  readonly clock: Clock;
  /** Ver `ContentBuildDeps.appRole`: sin él, un superusuario saltea RLS. */
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
}

/**
 * Prefijo de las subidas del Media Bank. Es el que usa `POST /media/upload-url`
 * y el que `workspaceMediaAuthorization` ya autoriza: el archivo normalizado
 * tiene que caer bajo él, o el próximo build que lo use fallaría con
 * `fuera_del_grant`.
 */
const MEDIA_PREFIX = "media";

/** `videoDurationSec` es entero en `DATA-010`; el probe da segundos con decimales. */
function wholeSeconds(seconds: number | undefined): number | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds);
}

type Outcome =
  | { readonly kind: "skip"; readonly why: string }
  | { readonly kind: "work"; readonly row: MediaRow };

export function createMediaNormalizationHandler(
  deps: MediaNormalizationDeps,
): JobHandler<unknown> {
  const inCompany = <T>(
    companyId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  async function read(job: MediaNormalizationJob): Promise<Outcome> {
    const row = await inCompany(job.companyId, (tx) =>
      mediaNormalizationStore.findMediaToNormalize(
        tx,
        { companyId: job.companyId },
        job.mediaId,
      ),
    );
    // Inexistente, ajeno o borrado: los tres se ven igual a propósito.
    if (row === null) return { kind: "skip", why: "el asset no existe o fue borrado" };
    if (row.status !== "processing") {
      return { kind: "skip", why: `el asset ya está en ${row.status}` };
    }
    if (row.mediaType !== "video") {
      // Inalcanzable por la API —las imágenes nacen `ready`—, pero una imagen
      // no se manda a `normalize`, que sólo sabe producir `video/mp4`.
      return { kind: "skip", why: "el asset no es un video" };
    }
    return { kind: "work", row };
  }

  async function discard(key: StorageKey | null): Promise<void> {
    if (key === null) return;
    try {
      await deps.storage.delete(key);
    } catch (error: unknown) {
      deps.logger.warn({ key, error }, "no se pudo borrar un normalizado huérfano");
    }
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseMediaNormalizationJob(ctx.payload);
    if (!parsed.ok) {
      // No se relanza: el mismo payload roto fallaría igual en cada intento.
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de media-normalization inválido",
      );
      return;
    }
    const job = parsed.job;
    const base = { jobId: ctx.jobId, mediaId: job.mediaId, attempt: ctx.attempt };

    const outcome = await read(job);
    if (outcome.kind === "skip") {
      deps.logger.info({ ...base, why: outcome.why }, "normalización omitida");
      return;
    }
    const row = outcome.row;

    let uploaded: StorageKey | null = null;
    let failure: NormalizationFailure | null = null;
    let reasons: readonly string[] = [];
    let patch: {
      storageKey: string;
      r2Url: string;
      sizeMb: number;
      videoDurationSec: number | null;
      normalization: MediaNormalizationOutcome;
    } | null = null;

    try {
      // La URL se deriva de la clave con la misma función que la produjo en la
      // API, en vez de confiar en `r2Url` persistida: si un día hay un CDN
      // delante, la persistida deja de coincidir con los prefijos del grant.
      const sourceUrl = await canonicalObjectUrl(deps.storage, row.storageKey);
      const auth = await workspaceMediaAuthorization(deps.storage, {
        companyId: job.companyId,
        objectPrefix: MEDIA_PREFIX,
        urls: [sourceUrl],
      });

      const result = await normalizeVideo(deps.renderer, sourceUrl, auth);
      reasons =
        result.kind === "normalized"
          ? result.reasons
          : videoNormalizationReasons(result.probe);

      if (result.kind !== "normalized") {
        // Ya es un MP4 SDR con el `moov` adelante, o es HDR y el servicio no
        // puede pasarlo a SDR (`normalize-video.ts`): se conserva el archivo.
        // Igual pasa por el `UPDATE`, que es lo que lo saca de `processing`,
        // le pone la duración que midió el probe y deja la marca (`0029`).
        patch = {
          storageKey: row.storageKey,
          r2Url: row.r2Url,
          sizeMb: row.sizeMb,
          videoDurationSec: wholeSeconds(result.probe.durationSeconds),
          normalization: result.kind,
        };
      } else {
        const normalized = result.media;
        const key = `${MEDIA_PREFIX}/${job.companyId}/normalized/${job.mediaId}/${randomUUID()}.mp4`;
        const stored = await deps.storage.put({
          key,
          body: normalized.body,
          contentType: normalized.contentType,
        });
        uploaded = stored.key;
        patch = {
          storageKey: stored.key,
          r2Url: await canonicalObjectUrl(deps.storage, stored.key),
          // El tamaño del objeto que quedó en el bucket, que es el que la fila
          // describe ahora — no el del original.
          sizeMb: stored.sizeBytes / BYTES_PER_MB,
          videoDurationSec: wholeSeconds(
            normalized.durationSeconds ?? result.probe.durationSeconds,
          ),
          normalization: "normalized",
        };
      }
    } catch (error: unknown) {
      failure = classifyNormalizationError(error);
    }

    if (failure === null && patch !== null) {
      const now = new Date(deps.clock.nowMs());
      const written = await inCompany(job.companyId, (tx) =>
        mediaNormalizationStore.completeMediaNormalization(
          tx,
          { companyId: job.companyId },
          job.mediaId,
          { ...patch, expectedStorageKey: row.storageKey, now },
        ),
      );
      if (written !== null) {
        deps.logger.info({ ...base, reasons }, "media normalizada");
        return;
      }
      // Se borró mientras trabajábamos, u otra entrega completó antes.
      await discard(uploaded);
      deps.logger.info(
        base,
        "resultado descartado: el asset cambió durante la normalización",
      );
      return;
    }

    await discard(uploaded);
    const f = failure ?? {
      code: "internal_error" as const,
      retryable: false,
      cause: new Error("normalización sin resultado"),
    };

    const ultimoIntento = ctx.attempt >= ctx.maxAttempts;
    if (f.retryable && !ultimoIntento) {
      deps.logger.warn(
        { ...base, maxAttempts: ctx.maxAttempts, code: f.code },
        "normalización fallida, se reintenta",
      );
      // Relanzar es lo que hace que la cola reintente con su backoff; el asset
      // sigue en `processing`, que es verdad: todavía puede terminar bien.
      throw f.cause instanceof Error ? f.cause : new Error(f.code);
    }

    const now = new Date(deps.clock.nowMs());
    const marcado = await inCompany(job.companyId, (tx) =>
      mediaNormalizationStore.failMediaNormalization(
        tx,
        { companyId: job.companyId },
        job.mediaId,
        now,
      ),
    );
    deps.logger.error(
      { ...base, code: f.code, marcado, error: f.cause },
      "normalización fallida definitivamente",
    );
  };
}
