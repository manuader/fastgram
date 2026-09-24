/**
 * El handler de `audio-extract` — "Extract from a video" de Library → Audio
 * (sprint 7, segunda tanda, agente H; pendiente del agente B).
 *
 * ```
 *   leer estado (terminal → no hacer nada)
 *   estado = extracting
 *   [tx] el video: vivo, de esta marca, `video`  (si no → media_not_found)
 *   duración guardada > tope → too_long (sin bajar nada)
 *   mkdtemp ─┬─ bajar el objeto del storage (con tope de bytes)
 *            ├─ medir con ffprobe: ¿tiene audio? duración real
 *            ├─ FFmpeg: sólo la primera pista de audio → AAC 128k en .m4a
 *            ├─ subir bajo `audio/{companyId}/extracted/` (lo que el build autoriza)
 *            └─ [tx] pista `extracted`, idempotente por `import_id = extractionId`
 *   estado = done (trackId)
 *   finally: rm -rf del temporal — **siempre**
 * ```
 *
 * ## Tope de duración
 *
 * `AUDIO_EXTRACT_MAX_SECONDS` (300 s, `packages/core/src/jobs/audio-extract.ts`):
 * un video más largo se **rechaza** con `too_long`, no se recorta en
 * silencio. FFmpeg lleva además `-t` con el tope como red por si la duración
 * guardada mintió.
 *
 * ## Lo que nunca sale
 *
 * El stderr de FFmpeg: el estado lleva un código estable
 * (`AUDIO_EXTRACTION_ERRORS`) y el log, sólo el código de salida.
 */
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalObjectUrl } from "@fastgram/adapters";
import { BYTES_PER_MB, brandAudioKeyPrefix } from "@fastgram/contracts";
import {
  AUDIO_EXTRACT_MAX_SECONDS,
  AUDIO_EXTRACT_MAX_VIDEO_BYTES,
  audioExtractionStatusKey,
  extractedAudioTitle,
  parseAudioExtractJob,
  parseAudioExtractionStatus,
  type AudioExtractionErrorCode,
  type AudioExtractionStatus,
  type AudioExtractJob,
} from "@fastgram/core";
import {
  brandAudioRepository,
  mediaRepository,
  withCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";
import type { Clock, JobContext, JobHandler, Storage } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { readJsonObject } from "../media-import/status-store.js";

/** Lo que el handler necesita de FFmpeg. El real está en `./ffmpeg.ts`. */
export interface AudioExtractor {
  /** Duración (s) y si el archivo tiene al menos una pista de audio. */
  probe(
    filePath: string,
  ): Promise<{ readonly durationSeconds: number | null; readonly hasAudio: boolean }>;
  /**
   * Escribe en `output` la primera pista de audio de `input` (AAC en .m4a),
   * cortada a `maxSeconds`. `false` si FFmpeg falló.
   */
  extract(input: string, output: string, maxSeconds: number): Promise<boolean>;
}

export interface AudioExtractDeps {
  readonly db: Database;
  readonly storage: Storage;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly extractor: AudioExtractor;
  readonly maxSeconds?: number;
  readonly maxVideoBytes?: number;
  /** Dónde crear el temporal. Default `os.tmpdir()`. */
  readonly tempRoot?: string;
}

/** El tipo y la extensión de lo que escribe `extract`. Está en `BRAND_AUDIO_CONTENT_TYPES`. */
export const EXTRACTED_AUDIO_CONTENT_TYPE = "audio/mp4";
const EXTRACTED_AUDIO_EXTENSION = "m4a";

class ExtractionFailure extends Error {
  constructor(readonly code: AudioExtractionErrorCode) {
    super(code);
  }
}

export async function readExtractionStatus(
  storage: Storage,
  companyId: string,
  extractionId: string,
): Promise<AudioExtractionStatus | null> {
  return parseAudioExtractionStatus(
    await readJsonObject(storage, audioExtractionStatusKey(companyId, extractionId)),
  );
}

async function writeExtractionStatus(
  storage: Storage,
  companyId: string,
  status: AudioExtractionStatus,
): Promise<void> {
  await storage.put({
    key: audioExtractionStatusKey(companyId, status.id),
    body: new TextEncoder().encode(JSON.stringify(status)),
    contentType: "application/json",
    cacheControl: "no-store",
  });
}

/** Baja un objeto del storage a un archivo, cortando si pasa `maxBytes`. */
async function downloadTo(
  storage: Storage,
  key: string,
  file: string,
  maxBytes: number,
): Promise<void> {
  const stream = await storage.get(key);
  const handle = await open(file, "w");
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new ExtractionFailure("too_large");
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
}

export function createAudioExtractHandler(deps: AudioExtractDeps): JobHandler<unknown> {
  const maxSeconds = deps.maxSeconds ?? AUDIO_EXTRACT_MAX_SECONDS;
  const maxVideoBytes = deps.maxVideoBytes ?? AUDIO_EXTRACT_MAX_VIDEO_BYTES;

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

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseAudioExtractJob(ctx.payload);
    if (!parsed.ok) {
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de audio-extract inválido",
      );
      return;
    }
    const job: AudioExtractJob = parsed.job;
    const log = {
      jobId: ctx.jobId,
      extractionId: job.extractionId,
      attempt: ctx.attempt,
    };

    const previous = await readExtractionStatus(
      deps.storage,
      job.companyId,
      job.extractionId,
    );
    if (previous !== null && (previous.state === "done" || previous.state === "failed")) {
      deps.logger.info(
        { ...log, state: previous.state },
        "extracción ya terminada: se omite",
      );
      return;
    }

    let status: AudioExtractionStatus = {
      ...(previous ?? {
        id: job.extractionId,
        mediaId: job.mediaId,
        state: "queued" as const,
      }),
      state: "extracting",
      jobId: ctx.jobId,
      updatedAt: deps.clock.nowMs(),
    };
    await writeExtractionStatus(deps.storage, job.companyId, status);

    const save = async (patch: Partial<AudioExtractionStatus>): Promise<void> => {
      status = { ...status, ...patch, updatedAt: deps.clock.nowMs() };
      await writeExtractionStatus(deps.storage, job.companyId, status);
    };

    let dir: string | null = null;
    try {
      const media = await inCompany(job.companyId, (tx) =>
        mediaRepository.findById(tx, { companyId: job.companyId }, job.mediaId),
      );
      if (media === null || media.mediaType !== "video") {
        throw new ExtractionFailure("media_not_found");
      }
      if (media.videoDurationSec !== null && media.videoDurationSec > maxSeconds + 1) {
        throw new ExtractionFailure("too_long");
      }

      dir = await mkdtemp(path.join(deps.tempRoot ?? tmpdir(), "fastgram-audio-"));
      const input = path.join(dir, "input");
      const output = path.join(dir, `audio.${EXTRACTED_AUDIO_EXTENSION}`);
      await downloadTo(deps.storage, media.storageKey, input, maxVideoBytes);

      const probe = await deps.extractor.probe(input);
      if (!probe.hasAudio) throw new ExtractionFailure("no_audio");
      if (probe.durationSeconds !== null && probe.durationSeconds > maxSeconds + 1) {
        throw new ExtractionFailure("too_long");
      }
      if (!(await deps.extractor.extract(input, output, maxSeconds))) {
        throw new ExtractionFailure("extract_failed");
      }
      const measured = await deps.extractor.probe(output);
      const body = await readFile(output);

      const stored = await deps.storage.put({
        key: `${brandAudioKeyPrefix(job.companyId)}/extracted/${job.extractionId}.${EXTRACTED_AUDIO_EXTENSION}`,
        body,
        contentType: EXTRACTED_AUDIO_CONTENT_TYPE,
      });
      const url = await canonicalObjectUrl(deps.storage, stored.key);
      const { row } = await inCompany(job.companyId, (tx) =>
        brandAudioRepository.createFromImport(
          tx,
          { companyId: job.companyId },
          {
            importId: job.extractionId,
            title: job.title ?? extractedAudioTitle(media.filename),
            origin: "extracted",
            storageKey: stored.key,
            url,
            contentType: EXTRACTED_AUDIO_CONTENT_TYPE,
            sizeMb: body.byteLength / BYTES_PER_MB,
            durationSec: measured.durationSeconds ?? probe.durationSeconds,
          },
        ),
      );
      await save({ state: "done", trackId: row.id });
      deps.logger.info({ ...log, trackId: row.id }, "audio extraído");
    } catch (error: unknown) {
      if (error instanceof ExtractionFailure) {
        await save({ state: "failed", error: error.code });
        deps.logger.warn({ ...log, code: error.code }, "extracción de audio fallida");
        return;
      }
      // Storage, base, disco: puede ser transitorio. Con intentos, la cola
      // reintenta; en el último, el estado lo dice.
      if (ctx.attempt < ctx.maxAttempts) {
        deps.logger.warn(
          { ...log, error: error instanceof Error ? error.message : String(error) },
          "extracción de audio interrumpida, se reintenta",
        );
        throw error;
      }
      await save({ state: "failed", error: "extract_failed" });
      deps.logger.error(
        { ...log, error: error instanceof Error ? error.message : String(error) },
        "extracción de audio fallida definitivamente",
      );
    } finally {
      if (dir !== null) await rm(dir, { recursive: true, force: true });
    }
  };
}
