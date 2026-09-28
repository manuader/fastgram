/**
 * El handler de `library-import` — sprint 9 (agente N), `PU-S9-005/006`, D-19.
 *
 * ```
 *   fila (processing; si no, no hacer nada: idempotente)
 *   mkdtemp ─┬─ origen: subida (storage `library/uploads/…`) | fuente (https, host de la fuente, tope de bytes)
 *            ├─ ffprobe → tipo, duración, alfa         (too_long / unsupported_media)
 *            ├─ normalizar (FFmpeg local, ver media-tools.ts)
 *            ├─ croma medido del borde → keyQuality
 *            ├─ audio audible (volumedetect)
 *            ├─ cuadros → modelo `vision` (si hay) → propuesta acotada al vocabulario
 *            ├─ JSON → validar contra el contrato      (invalid_metadata / nsfw_rejected)
 *            ├─ subir `library/{id}/asset.*` y `preview.jpg`
 *            └─ fila `ready`
 *   finally: rm -rf del temporal — siempre
 * ```
 *
 * ## Fallos
 *
 * Un fallo del archivo (muy largo, formato raro, FFmpeg no pudo) deja la fila
 * `failed` con un código estable y **no** reintenta: daría lo mismo. Una
 * bajada que falla por la red se reintenta si queda intento. El etiquetado es
 * de mejor esfuerzo: si el modelo falla, el asset entra sin etiquetas
 * (`needsReview`).
 *
 * Nunca sale el stderr de FFmpeg, ni la respuesta del proveedor, ni la URL
 * con query (la de Pixabay llevaría la key; acá sólo llegan URLs de archivo).
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { canonicalObjectUrl, type FfmpegClipInspector } from "@fastgram/adapters";
import {
  BYTES_PER_MB,
  libraryLicenseSchema,
  type LibraryAssetKind,
  type LibraryFailureCode,
  type LibraryLicense,
} from "@fastgram/contracts";
import {
  LIBRARY_DOWNLOAD_MAX_BYTES,
  LIBRARY_KEY_MIN_SHARE,
  LIBRARY_MAX_DURATION_SEC,
  LIBRARY_TAGGING_FRAMES,
  LIBRARY_TAGGING_FRAME_MAX_SIDE,
  buildLibrarySearchText,
  isAllowedDownloadUrl,
  libraryObjectKey,
  libraryPreviewKey,
  measureChromaKey,
  parseLibraryImportJob,
  type ChromaMeasurement,
  type LibraryImportJob,
  type LibrarySource,
  type LibraryTagProposal,
} from "@fastgram/core";
import {
  libraryAssetRepository,
  type Database,
  type LibraryAssetRow,
} from "@fastgram/db";
import type { Clock, JobContext, JobHandler, RgbSample, Storage } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { buildLibraryMetadata, decideKind, validateLibraryMetadata } from "./metadata.js";
import { MediaToolError, type MediaTools, type ProbedMedia } from "./media-tools.js";
import type { LibraryTaggerProvider } from "./tagger.js";

/** El User-Agent que pide la política de Wikimedia (descriptivo, sin datos del dueño). */
export const LIBRARY_USER_AGENT =
  "FastGram/1.0 (self-hosted content tool; library import)";

export type LibraryFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface LibraryImportDeps {
  readonly db: Database;
  readonly storage: Storage;
  readonly clock: Clock;
  readonly logger: BuildLogger;
  readonly tools: MediaTools;
  /** El inspector de `media-import` (cuadros y borde de un video). */
  readonly inspector: Pick<FfmpegClipInspector, "frames" | "borderSamples">;
  readonly tagger: LibraryTaggerProvider;
  readonly fetch?: LibraryFetch;
  readonly userAgent?: string;
  readonly maxBytes?: number;
  /** Tope de ancho de banda por fuente (tests). Default {@link LIBRARY_SOURCE_BYTES_PER_SECOND}. */
  readonly bytesPerSecond?: Readonly<Partial<Record<LibrarySource, number>>>;
  /** Tope de la bajada entera. Default 5 min. */
  readonly downloadTimeoutMs?: number;
  readonly tempRoot?: string;
}

export interface LibraryImportRun {
  readonly jobId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type LibraryImportOutcome =
  | { readonly kind: "skipped"; readonly why: string }
  | { readonly kind: "ready"; readonly row: LibraryAssetRow; readonly tagged: boolean }
  | { readonly kind: "failed"; readonly code: LibraryFailureCode };

class ImportFailure extends Error {
  constructor(readonly code: LibraryFailureCode) {
    super(code);
  }
}

/** Una falla de red que vale la pena reintentar. */
class RetryableDownload extends Error {}

/**
 * Tope de ancho de banda por fuente, en bytes por segundo. La política de
 * bots de Wikimedia (https://wikitech.wikimedia.org/wiki/Robot_policy) pide
 * concurrencia ≤ 2 y ≤ 25 Mbps medidos en ventanas de 10 s, y respetar el
 * `Retry-After` de un 429. Se aprendió en la corrida real del 2026-09-28: diez
 * bajadas seguidas a toda velocidad (una de 67 MB en ~10 s) y
 * `upload.wikimedia.org` pasó a contestar 429 con `Retry-After: 600`.
 * 3 MB/s = 24 Mbps. La cola ya corre de a uno (concurrencia 1).
 */
export const LIBRARY_SOURCE_BYTES_PER_SECOND: Readonly<
  Partial<Record<LibrarySource, number>>
> = { wikimedia: 3_000_000 };

/** Deja pasar los bytes sin superar `bytesPerSecond` en promedio desde el inicio. */
function throttle(bytesPerSecond: number): Transform {
  const started = Date.now();
  let sent = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sent += chunk.byteLength;
      const due = (sent / bytesPerSecond) * 1000 - (Date.now() - started);
      if (due <= 0) callback(null, chunk);
      else setTimeout(() => callback(null, chunk), due);
    },
  });
}

async function downloadTo(
  deps: LibraryImportDeps,
  job: LibraryImportJob & { origin: { kind: "remote" } },
  file: string,
): Promise<void> {
  const { origin } = job;
  if (!isAllowedDownloadUrl(origin.source, origin.downloadUrl)) {
    throw new ImportFailure("download_failed");
  }
  const maxBytes = deps.maxBytes ?? LIBRARY_DOWNLOAD_MAX_BYTES;
  const doFetch: LibraryFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.downloadTimeoutMs ?? 300_000);
  try {
    let response: Response;
    try {
      response = await doFetch(origin.downloadUrl, {
        headers: { "user-agent": deps.userAgent ?? LIBRARY_USER_AGENT },
        signal: controller.signal,
        // Una redirección a otro host no se sigue a ciegas: se revisa abajo.
        redirect: "follow",
      });
    } catch {
      throw new RetryableDownload("network");
    }
    if (response.url !== "" && !isAllowedDownloadUrl(origin.source, response.url)) {
      throw new ImportFailure("download_failed");
    }
    // 429: se respeta el `Retry-After` no insistiendo; el asset queda
    // `source_rate_limited` y volver a importarlo lo reintenta.
    if (response.status === 429) throw new ImportFailure("source_rate_limited");
    if (response.status >= 500) throw new RetryableDownload("server");
    if (!response.ok || response.body === null)
      throw new ImportFailure("download_failed");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes)
      throw new ImportFailure("too_large");

    let seen = 0;
    const source = Readable.fromWeb(response.body as WebReadableStream);
    source.on("data", (chunk: Buffer) => {
      seen += chunk.byteLength;
      if (seen > maxBytes) source.destroy(new ImportFailure("too_large"));
    });
    try {
      const rate =
        deps.bytesPerSecond?.[origin.source] ??
        LIBRARY_SOURCE_BYTES_PER_SECOND[origin.source];
      await (rate === undefined
        ? pipeline(source, createWriteStream(file))
        : pipeline(source, throttle(rate), createWriteStream(file)));
    } catch (error: unknown) {
      if (error instanceof ImportFailure) throw error;
      throw new RetryableDownload("stream");
    }
  } finally {
    clearTimeout(timer);
  }
}

async function copyFromStorage(
  storage: Storage,
  key: string,
  file: string,
): Promise<void> {
  const stream = await storage.get(key);
  await pipeline(Readable.from(stream), createWriteStream(file));
}

export type LibraryImportRunner = (
  job: LibraryImportJob,
  run: LibraryImportRun,
) => Promise<LibraryImportOutcome>;

export function createLibraryImportRunner(deps: LibraryImportDeps): LibraryImportRunner {
  async function fail(
    assetId: string,
    code: LibraryFailureCode,
  ): Promise<LibraryImportOutcome> {
    await libraryAssetRepository.update(deps.db, assetId, {
      status: "failed",
      failureCode: code,
    });
    return { kind: "failed", code };
  }

  async function measureChroma(
    file: string,
    probed: ProbedMedia,
  ): Promise<ChromaMeasurement> {
    if (probed.mediaType === "audio" || probed.hasAlpha) {
      return { type: "none", keyQuality: null, keyColor: null };
    }
    let samples: readonly RgbSample[] = [];
    try {
      samples =
        probed.mediaType === "image"
          ? await deps.tools.imageBorderSamples(file)
          : await deps.inspector.borderSamples(file, 5);
    } catch (error: unknown) {
      deps.logger.warn({ error }, "no se pudo medir el croma: queda sin medir");
    }
    return measureChromaKey(samples);
  }

  async function propose(
    file: string,
    probed: ProbedMedia,
    log: Record<string, unknown>,
  ): Promise<LibraryTagProposal | null> {
    if (probed.mediaType === "audio") return null;
    const tagger = await deps.tagger();
    if (tagger === null) return null;
    try {
      const frames =
        probed.mediaType === "image"
          ? [await readFile(file)]
          : await deps.inspector.frames(
              file,
              LIBRARY_TAGGING_FRAMES,
              LIBRARY_TAGGING_FRAME_MAX_SIDE,
            );
      if (frames.length === 0) return null;
      return await tagger.tag(frames);
    } catch (error: unknown) {
      deps.logger.warn(
        {
          ...log,
          model: tagger.model,
          error: error instanceof Error ? error.message : "unknown",
        },
        "etiquetado de la biblioteca fallido: entra sin etiquetas",
      );
      return null;
    }
  }

  return async function runLibraryImport(job, ctx) {
    const log = { jobId: ctx.jobId, assetId: job.assetId, attempt: ctx.attempt };
    const row = await libraryAssetRepository.findById(deps.db, job.assetId);
    if (row === null) return { kind: "skipped", why: "no_row" };
    if (row.status !== "processing")
      return { kind: "skipped", why: `status_${row.status}` };

    const license = libraryLicenseSchema.safeParse(row.license);
    if (!license.success) {
      // No debería pasar (la API valida al crear): sin licencia válida no entra.
      deps.logger.error(log, "fila de la biblioteca con licencia inválida");
      return fail(job.assetId, "invalid_metadata");
    }

    let dir: string | null = null;
    try {
      dir = await mkdtemp(path.join(deps.tempRoot ?? tmpdir(), "fastgram-library-"));
      const original = path.join(dir, "original");
      if (job.origin.kind === "remote") {
        await downloadTo(deps, { ...job, origin: job.origin }, original);
      } else {
        await copyFromStorage(deps.storage, job.origin.storageKey, original);
      }

      let probed = await deps.tools.probe(original);
      // Alfa declarado ≠ alfa real (ver `alphaBorderShare`): sin borde
      // transparente, se trata como un video opaco (se transcodifica y se le
      // mide el croma).
      let alphaShare: number | null = null;
      if (probed.hasAlpha) {
        alphaShare = await deps.tools.alphaBorderShare(original, probed);
        if (alphaShare < LIBRARY_KEY_MIN_SHARE) probed = { ...probed, hasAlpha: false };
      }
      if (
        probed.durationSec !== null &&
        probed.durationSec > LIBRARY_MAX_DURATION_SEC + 1
      ) {
        throw new ImportFailure("too_long");
      }
      const normalized = await deps.tools.normalize(original, probed, dir);
      if (normalized.sizeBytes > (deps.maxBytes ?? LIBRARY_DOWNLOAD_MAX_BYTES)) {
        throw new ImportFailure("too_large");
      }
      // Lo que se guarda es lo normalizado: se mide eso (el 4K ya es 1080p).
      const final = normalized.transcoded
        ? await deps.tools.probe(normalized.path)
        : probed;
      const finalProbe: ProbedMedia = { ...final, hasAlpha: probed.hasAlpha };

      const measured = await measureChroma(normalized.path, finalProbe);
      // Con alfa real, la «calidad del recorte» es el borde transparente medido.
      const chroma: ChromaMeasurement =
        finalProbe.hasAlpha && alphaShare !== null
          ? { type: "none", keyQuality: alphaShare, keyColor: null }
          : measured;
      const audible = await deps.tools.audibleAudio(normalized.path, finalProbe);
      const proposal = await propose(normalized.path, finalProbe, log);
      if (proposal?.nsfw === true) throw new ImportFailure("nsfw_rejected");

      const kind: LibraryAssetKind = decideKind(
        finalProbe,
        chroma,
        job.kindHint as LibraryAssetKind | undefined,
      );
      const checked = validateLibraryMetadata(
        buildLibraryMetadata({
          kind,
          title: row.title,
          probed: finalProbe,
          chroma,
          audible,
          proposal,
          license: license.data as LibraryLicense,
        }),
      );
      if (!checked.ok) {
        deps.logger.warn(
          { ...log, issues: checked.issues },
          "JSON de la biblioteca inválido",
        );
        throw new ImportFailure("invalid_metadata");
      }
      const metadata = checked.metadata;

      const stored = await deps.storage.put({
        key: libraryObjectKey(job.assetId, normalized.extension),
        body: await readFile(normalized.path),
        contentType: normalized.contentType,
      });
      const posterPath = await deps.tools.poster(normalized.path, finalProbe, dir);
      let preview: { key: string; url: string } | null = null;
      if (posterPath !== null) {
        const put = await deps.storage.put({
          key: libraryPreviewKey(job.assetId),
          body: await readFile(posterPath),
          contentType: "image/jpeg",
        });
        preview = { key: put.key, url: await canonicalObjectUrl(deps.storage, put.key) };
      }

      const updated = await libraryAssetRepository.update(deps.db, job.assetId, {
        status: "ready",
        kind,
        mediaType: finalProbe.mediaType,
        storageKey: stored.key,
        url: await canonicalObjectUrl(deps.storage, stored.key),
        previewKey: preview?.key ?? null,
        previewUrl: preview?.url ?? null,
        contentType: normalized.contentType,
        sizeMb: stored.sizeBytes / BYTES_PER_MB,
        durationSec: metadata.durationSec,
        width: finalProbe.width,
        height: finalProbe.height,
        metadata,
        metadataSource: "auto",
        searchText: buildLibrarySearchText(row.title, metadata),
        failureCode: null,
      });
      if (updated === null) {
        // La borraron mientras procesaba: el objeto queda huérfano, se limpia.
        await deps.storage.delete(stored.key).catch(() => undefined);
        return { kind: "skipped", why: "deleted_while_processing" };
      }
      // La subida cruda ya no hace falta: el asset vive en `library/{id}/`.
      if (job.origin.kind === "upload") {
        await deps.storage.delete(job.origin.storageKey).catch(() => undefined);
      }
      deps.logger.info(
        {
          ...log,
          kind,
          keyQuality: metadata.chroma.keyQuality,
          tagged: proposal !== null,
          transcoded: normalized.transcoded,
        },
        "asset de la biblioteca listo",
      );
      return { kind: "ready", row: updated, tagged: proposal !== null };
    } catch (error: unknown) {
      if (error instanceof RetryableDownload) {
        if (ctx.attempt < ctx.maxAttempts) {
          deps.logger.warn(log, "bajada de la biblioteca fallida, se reintenta");
          throw new Error("library_download_retry");
        }
        return fail(job.assetId, "download_failed");
      }
      if (error instanceof ImportFailure) {
        deps.logger.warn({ ...log, code: error.code }, "import a la biblioteca fallido");
        return fail(job.assetId, error.code);
      }
      if (error instanceof MediaToolError) {
        deps.logger.warn({ ...log, code: error.code }, "import a la biblioteca fallido");
        return fail(job.assetId, error.code);
      }
      if (ctx.attempt < ctx.maxAttempts) throw error;
      deps.logger.error(
        { ...log, error: error instanceof Error ? error.message : "unknown" },
        "import a la biblioteca fallido definitivamente",
      );
      return fail(job.assetId, "download_failed");
    } finally {
      if (dir !== null) await rm(dir, { recursive: true, force: true });
    }
  };
}

export function createLibraryImportHandler(deps: LibraryImportDeps): JobHandler<unknown> {
  const run = createLibraryImportRunner(deps);
  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseLibraryImportJob(ctx.payload);
    if (!parsed.ok) {
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de library-import inválido",
      );
      return;
    }
    await run(parsed.job, ctx);
  };
}
