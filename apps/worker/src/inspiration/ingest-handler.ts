/**
 * Leer una referencia de Inspiration — `F-041`, `P2-TREND-002`/`003`, `D-13`.
 *
 * ```
 *   [tx] la referencia: si no existe o ya no está `pending` → nada (reentrega)
 *   mkdtemp ─┬─ yt-dlp: JSON (sin login, sin bajar el video) + miniatura
 *            ├─ parseReferenceInfo (core): título, autor, caption, hashtags,
 *            │   métricas públicas, formato
 *            ├─ miniatura → storage de la marca (una copia nuestra: la del
 *            │   sitio vence o bloquea el hotlink)
 *            ├─ OCR (`services/vision`, si está) → texto en pantalla
 *            ├─ visión (tarea `vision`, si está) → etiquetas (+ texto si no hubo OCR)
 *            └─ [tx] `ready` con todo eso
 *   fallo: `download_failed` con intentos → relanza; si no → `failed` + código
 *   finally: rm -rf del temporal — siempre
 * ```
 *
 * ## Lo que nunca sale
 *
 * El stderr de `yt-dlp` y los mensajes del modelo de visión: la fila lleva un
 * `MediaImportFailureCode` y nada más. El OCR es de mejor esfuerzo: si falla,
 * la referencia queda `ready` sin texto en pantalla (se loguea el código).
 *
 * Transcripción no (`D-03`).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalObjectUrl } from "@fastgram/adapters";
import {
  INSPIRATION_INGEST_TIMEOUT_MS,
  INSPIRATION_THUMBNAIL_MAX_BYTES,
  checkImportUrl,
  onScreenLinesFromOcr,
  onScreenTextOf,
  parseInspirationIngestJob,
  parseReferenceInfo,
  type InspirationIngestJob,
} from "@fastgram/core";
import {
  applyOwnerReferenceIngest,
  findOwnerReference,
  withCompany,
  type Database,
  type OwnerReferenceIngestPatch,
  type Transaction,
} from "@fastgram/db";
import {
  PortError,
  type ClipTagger,
  type JobContext,
  type JobHandler,
  type MediaImportFailureCode,
  type Ocr,
  type Storage,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { ReferenceReader } from "./reference-reader.js";

export interface InspirationIngestDeps {
  readonly db: Database;
  readonly storage: Storage;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly reader: ReferenceReader;
  readonly vision: () => Promise<ClipTagger | null>;
  /** OCR de `services/vision`, si está configurado. Tiene prioridad para el texto. */
  readonly ocr?: Ocr | null;
  readonly timeoutMs?: number;
  readonly tempRoot?: string;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function createInspirationIngestHandler(
  deps: InspirationIngestDeps,
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

  async function apply(
    job: InspirationIngestJob,
    patch: OwnerReferenceIngestPatch,
  ): Promise<boolean> {
    return inCompany(job.companyId, (tx) =>
      applyOwnerReferenceIngest(
        tx,
        { companyId: job.companyId },
        job.inspirationItemId,
        patch,
      ),
    );
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseInspirationIngestJob(ctx.payload);
    if (!parsed.ok) {
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de inspiration inválido",
      );
      return;
    }
    const job = parsed.job;
    const log = {
      jobId: ctx.jobId,
      companyId: job.companyId,
      inspirationItemId: job.inspirationItemId,
      attempt: ctx.attempt,
    };

    const item = await inCompany(job.companyId, (tx) =>
      findOwnerReference(tx, { companyId: job.companyId }, job.inspirationItemId),
    );
    if (item === null) {
      deps.logger.info(log, "referencia inexistente (¿borrada?): se omite");
      return;
    }
    if (item.ingestState !== "pending") {
      deps.logger.info(
        { ...log, state: item.ingestState },
        "referencia ya leída: se omite",
      );
      return;
    }

    const fail = async (code: MediaImportFailureCode): Promise<void> => {
      await apply(job, { ingestState: "failed", ingestError: code });
      deps.logger.warn({ ...log, code }, "lectura de referencia fallida");
    };

    // Defensa en profundidad: la API ya lo validó, pero el payload vive en la cola.
    const url = checkImportUrl(job.url);
    if (!url.ok) {
      await fail("unsupported_url");
      return;
    }

    let dir: string | null = null;
    try {
      dir = await mkdtemp(path.join(deps.tempRoot ?? tmpdir(), "fastgram-inspiration-"));
      const outcome = await deps.reader.read({
        url: url.url,
        directory: dir,
        timeoutMs: deps.timeoutMs ?? INSPIRATION_INGEST_TIMEOUT_MS,
        maxThumbnailBytes: INSPIRATION_THUMBNAIL_MAX_BYTES,
      });
      if (!outcome.ok) {
        // `download_failed` puede ser la red: se reintenta si queda intento.
        if (outcome.code === "download_failed" && ctx.attempt < ctx.maxAttempts) {
          deps.logger.warn(log, "lectura fallida, se reintenta");
          throw new Error("download_failed");
        }
        await fail(outcome.code);
        return;
      }
      const meta = parseReferenceInfo(outcome.info);
      if (meta === null) {
        await fail("download_failed");
        return;
      }

      // ── Miniatura: una copia nuestra ──
      let thumbnailUrl: string | null = null;
      const thumb = outcome.thumbnail;
      const contentType = thumb === null ? undefined : CONTENT_TYPES[thumb.extension];
      if (thumb !== null && contentType !== undefined) {
        try {
          const stored = await deps.storage.put({
            key: `media/${job.companyId}/inspiration/${job.inspirationItemId}/thumb-${randomUUID()}.${thumb.extension}`,
            body: thumb.body,
            contentType,
          });
          thumbnailUrl = await canonicalObjectUrl(deps.storage, stored.key);
        } catch (error: unknown) {
          deps.logger.warn({ ...log, error }, "no se pudo guardar la miniatura");
        }
      }

      // ── Texto en pantalla y etiquetas (mejor esfuerzo, AI-016: degrada) ──
      let onScreenText: readonly string[] = [];
      let visionTags: readonly string[] = [];
      let ocrRan = false;
      const ocr = deps.ocr ?? null;
      if (thumb !== null && contentType !== undefined && ocr !== null) {
        try {
          const result = await ocr.recognizeImage({ bytes: thumb.body, contentType });
          onScreenText = onScreenLinesFromOcr(result.text);
          ocrRan = true;
        } catch (error: unknown) {
          deps.logger.warn(
            { ...log, code: error instanceof PortError ? error.code : "unknown" },
            "OCR de services/vision fallido; se intenta con el modelo de visión",
          );
        }
      }
      if (thumb !== null && contentType === "image/jpeg") {
        const vision = await deps.vision().catch(() => null);
        if (vision !== null) {
          try {
            const tags = await vision.tag([thumb.body]);
            if (!ocrRan) onScreenText = onScreenTextOf(tags);
            visionTags = tags.tags;
          } catch (error: unknown) {
            deps.logger.warn(
              { ...log, code: error instanceof PortError ? error.code : "unknown" },
              "OCR de la miniatura fallido; la referencia queda sin texto en pantalla",
            );
          }
        }
      }

      const stillThere = await apply(job, {
        ingestState: "ready",
        ingestError: null,
        title: meta.title,
        author: meta.author,
        caption: meta.caption,
        hashtags: meta.hashtags,
        format: meta.format,
        views: meta.views,
        likes: meta.likes,
        comments: meta.comments,
        durationSeconds: meta.durationSeconds,
        isSlideshow: meta.isSlideshow,
        slideCount: meta.slideCount,
        ...(thumbnailUrl === null ? {} : { thumbnailUrl }),
        textOverlays: onScreenText,
        addNiches: visionTags,
      });
      deps.logger.info(
        {
          ...log,
          format: meta.format,
          hasThumbnail: thumbnailUrl !== null,
          ocrLines: onScreenText.length,
          stillThere,
        },
        "referencia leída",
      );
    } catch (error: unknown) {
      if (ctx.attempt < ctx.maxAttempts) throw error;
      deps.logger.error(
        { ...log, error },
        "lectura de referencia fallida definitivamente",
      );
      await fail("download_failed");
    } finally {
      if (dir !== null) await rm(dir, { recursive: true, force: true });
    }
  };
}
