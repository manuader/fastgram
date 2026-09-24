/**
 * El handler de `media-import` — `PU-MEME-001` (bajar), `PU-MEME-002` (fondo),
 * `PU-MEME-003` (etiquetas). `docs/PLAN-USO-PERSONAL.md` §6, D-12.
 *
 * ```
 *   leer estado (terminal → no hacer nada)
 *   estado = downloading
 *   mkdtemp ─┬─ yt-dlp (proceso hijo, sin shell, timeout duro)
 *            ├─ medir con FFmpeg: duración real, ¿es verde?, 3 cuadros
 *            ├─ subir el original ─ [tx] fila `processing` + encolar `media-normalization`
 *            ├─ estado = imported (background/tagging: pending)
 *            ├─ recorte: verde → nada; si no, y se pidió foreground → fal → 2.ª fila con alfa
 *            ├─ etiquetas: modelo `vision` si hay → metadata
 *            └─ estado = imported (final)
 *   finally: rm -rf del temporal — **siempre**, también si algo lanza
 * ```
 *
 * ## Por qué el video pasa por `media-normalization` como cualquier subida
 *
 * `yt-dlp` ya entrega MP4, pero no garantiza SDR ni `faststart`, y el Media
 * Bank tiene **un** camino a `ready` (`FR-100`). El import no inventa otro: la
 * fila nace `processing` y la saca de ahí el mismo job que a un upload. Sin
 * servicio de render configurado, queda `processing` (verdad) igual que un
 * upload.
 *
 * El clip con alfa (`PU-MEME-002`) **no** pasa por ahí: la normalización lo
 * transcodifica a H.264 y el alfa se pierde. Nace `ready` como webm; el render
 * lo detecta y lo superpone sin croma (`services/render`, `planGreenScreenBase`).
 *
 * ## Idempotencia
 *
 * - El `mediaId` viene en el payload: un reintento encuentra la fila y no
 *   duplica (el objeto que subió de más se borra).
 * - Un estado terminal (`imported`/`failed`) corta: un reintento tardío no
 *   vuelve a pagar un recorte en fal.
 * - Después de crear la fila, **nada relanza**: el recorte y las etiquetas son
 *   de mejor esfuerzo y su fallo queda en el estado, no en un reintento que
 *   bajaría el clip otra vez.
 *
 * ## Lo que nunca sale
 *
 * El stderr de `yt-dlp` y de FFmpeg, y los mensajes de los proveedores: el
 * estado lleva un código de `MEDIA_IMPORT_FAILURE_CODES` y nada más.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalObjectUrl } from "@fastgram/adapters";
import {
  BYTES_PER_MB,
  brandAudioKeyPrefix,
  videoMediaCategorySchema,
} from "@fastgram/contracts";
import {
  CLIP_TAGGING_FRAMES,
  CLIP_TAGGING_FRAME_MAX_SIDE,
  DEFAULT_MEDIA_IMPORT_MAX_DURATION_SECONDS,
  GREEN_SCREEN_CATEGORY,
  JOB_QUEUES,
  MEDIA_IMPORT_MAX_BYTES,
  MEDIA_IMPORT_TIMEOUT_MS,
  categoriesForOriginal,
  checkImportUrl,
  parseMediaImportJob,
  wantsForeground,
  type BackgroundState,
  type MediaImportJob,
  type MediaImportStatus,
  type TaggingState,
} from "@fastgram/core";
import {
  addMediaTag,
  brandAudioRepository,
  mediaRepository,
  withCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";
import type {
  BackgroundRemoval,
  ClipInspector,
  ClipTagger,
  ClipTags,
  Clock,
  JobContext,
  JobHandler,
  MediaDownloader,
  MediaImportFailureCode,
  Queue,
  Storage,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { readImportStatus, writeImportStatus, writeMediaMeta } from "./status-store.js";

/** Los `maxAttempts: 3` de `mediaNormalization` en el catálogo, en reintentos. */
const MEDIA_NORMALIZATION_RETRY_LIMIT = 2;

const VIDEO_CATEGORIES: readonly string[] = videoMediaCategorySchema.options;

export interface MediaImportDeps {
  readonly db: Database;
  readonly storage: Storage;
  /** Para encolar `media-normalization` dentro de la transacción de la fila. */
  readonly queue: Queue;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly downloader: MediaDownloader;
  readonly inspector: ClipInspector;
  /** El detector local de croma (`ChromaKeyBackgroundRemoval`). */
  readonly chroma: BackgroundRemoval;
  /** El recorte con proveedor, resuelto **por job** (el registro puede cambiar). `null` = sin configurar. */
  readonly backgroundRemoval: () => Promise<BackgroundRemoval | null>;
  /** El etiquetador, por job. `null` = sin modelo de visión. */
  readonly tagger: () => Promise<ClipTagger | null>;
  readonly maxDurationSeconds?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Dónde crear el temporal. Default `os.tmpdir()`. */
  readonly tempRoot?: string;
}

/** Un nombre de archivo presentable a partir del título del sitio (texto de terceros). */
export function importFilename(title: string | null, extension: string): string {
  const clean = (title ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return `${clean.length === 0 ? "import" : clean}.${extension}`;
}

/**
 * El título de una pista importada: el del sitio (texto de terceros, se trata
 * como dato y se recorta) o uno genérico. Se renombra desde la Library.
 */
export function importedAudioTitle(title: string | null): string {
  const clean = (title ?? "").replace(/\s+/g, " ").trim().slice(0, 200).trim();
  return clean.length === 0 ? "Imported audio" : clean;
}

class ImportFailure extends Error {
  constructor(readonly code: MediaImportFailureCode) {
    super(code);
  }
}

/** El job en curso: para el log y para decidir si un fallo se reintenta. */
export interface ImportRun {
  readonly jobId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}

/** Sprint 7: lo que «crear desde prompt» apaga cuando importa un meme solo. */
export interface ImportOptions {
  /** `false` = no etiquetar con el modelo de visión. Default: etiquetar. */
  readonly tagging?: boolean;
  /** `false` = nunca pagar un recorte de fondo (fal). Default: si se pidió foreground. */
  readonly paidCutout?: boolean;
}

/**
 * El import entero, reutilizable (sprint 7): el handler de la cola lo corre
 * por job, y «crear desde prompt» lo corre **en línea** con el meme que
 * encontró (`discovery/meme-finder.ts`) — un solo camino al Media Bank.
 *
 * Devuelve el estado final (o `null` si no llegó a escribir ninguno). Con
 * `attempt < maxAttempts` puede **lanzar** para que la cola reintente una
 * bajada fallida; quien lo llama en línea pasa `attempt = maxAttempts`.
 */
export type MediaImportRunner = (
  job: MediaImportJob,
  run: ImportRun,
  options?: ImportOptions,
) => Promise<MediaImportStatus | null>;

export function createMediaImportRunner(deps: MediaImportDeps): MediaImportRunner {
  const maxDuration =
    deps.maxDurationSeconds ?? DEFAULT_MEDIA_IMPORT_MAX_DURATION_SECONDS;
  const maxBytes = deps.maxBytes ?? MEDIA_IMPORT_MAX_BYTES;
  const timeoutMs = deps.timeoutMs ?? MEDIA_IMPORT_TIMEOUT_MS;

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

  const now = (): number => deps.clock.nowMs();

  async function save(
    job: MediaImportJob,
    base: MediaImportStatus,
    patch: Partial<MediaImportStatus>,
  ) {
    const next: MediaImportStatus = { ...base, ...patch, updatedAt: now() };
    await writeImportStatus(deps.storage, job.companyId, next);
    return next;
  }

  async function discard(key: string | null): Promise<void> {
    if (key === null) return;
    try {
      await deps.storage.delete(key);
    } catch (error: unknown) {
      deps.logger.warn({ key, error }, "no se pudo borrar un objeto huérfano del import");
    }
  }

  /** Crea la fila del original y encola su normalización, o devuelve la que ya estaba. */
  async function createOriginalRow(
    job: MediaImportJob,
    values: {
      filename: string;
      storageKey: string;
      r2Url: string;
      sizeMb: number;
      videoDurationSec: number | null;
      categories: string[];
    },
  ): Promise<{ created: boolean }> {
    return inCompany(job.companyId, async (tx) => {
      const existing = await mediaRepository.findById(
        tx,
        { companyId: job.companyId },
        job.mediaId,
        { includeDeleted: true },
      );
      if (existing !== null) return { created: false };
      await mediaRepository.create(
        tx,
        { companyId: job.companyId },
        {
          mediaId: job.mediaId,
          mediaType: "video",
          filename: values.filename,
          r2Url: values.r2Url,
          storageKey: values.storageKey,
          // FR-100: un video nace `processing` y lo saca la normalización.
          status: "processing",
          sizeMb: values.sizeMb,
          ...(values.videoDurationSec === null
            ? {}
            : { videoDurationSec: values.videoDurationSec }),
          categories: values.categories,
          // Lo importó el dueño con su link (D-12): es una subida suya por otro
          // camino. Un origen propio (`link_import`) exige migración: está en
          // el reporte.
          origin: "manual_upload",
        },
      );
      // Dentro de la transacción (ADR-005): sin job no hay fila, y al revés.
      await deps.queue.enqueue({
        queue: JOB_QUEUES.mediaNormalization,
        payload: { companyId: job.companyId, mediaId: job.mediaId },
        options: {
          transaction: tx,
          singletonKey: `${JOB_QUEUES.mediaNormalization}:${job.mediaId}`,
          retryLimit: MEDIA_NORMALIZATION_RETRY_LIMIT,
          retryBackoff: true,
        },
      });
      return { created: true };
    });
  }

  return async function runImport(
    job: MediaImportJob,
    ctx: ImportRun,
    options: ImportOptions = {},
  ): Promise<MediaImportStatus | null> {
    const log = { jobId: ctx.jobId, importId: job.importId, attempt: ctx.attempt };

    const previous = await readImportStatus(deps.storage, job.companyId, job.importId);
    if (
      previous !== null &&
      (previous.state === "imported" || previous.state === "failed")
    ) {
      deps.logger.info(
        { ...log, state: previous.state },
        "import ya terminado: se omite",
      );
      return previous;
    }
    let status: MediaImportStatus = await save(
      job,
      previous ?? {
        importId: job.importId,
        kind: job.kind,
        state: "queued",
        sourceUrl: job.url,
        updatedAt: now(),
      },
      { state: "downloading", jobId: ctx.jobId },
    );

    const fail = async (code: MediaImportFailureCode): Promise<void> => {
      status = await save(job, status, { state: "failed", error: code });
      deps.logger.warn({ ...log, code }, "import fallido");
    };

    // Defensa en profundidad: la API ya lo validó, pero el payload vive en la cola.
    const url = checkImportUrl(job.url);
    if (!url.ok) {
      await fail("unsupported_url");
      return status;
    }

    let dir: string | null = null;
    try {
      dir = await mkdtemp(path.join(deps.tempRoot ?? tmpdir(), "fastgram-import-"));
      const outcome = await deps.downloader.download({
        url: url.url,
        kind: job.kind,
        directory: dir,
        maxDurationSeconds: maxDuration,
        maxBytes,
        timeoutMs,
      });
      if (!outcome.ok) {
        // `download_failed` puede ser la red: se reintenta si queda intento. Los
        // otros tres son del link y darían lo mismo.
        if (outcome.code === "download_failed" && ctx.attempt < ctx.maxAttempts) {
          deps.logger.warn(log, "bajada fallida, se reintenta");
          throw new Error("download_failed");
        }
        await fail(outcome.code);
        return status;
      }
      const clip = outcome.clip;

      // La duración que dijo el sitio no alcanza: se mide el archivo.
      const probe = await deps.inspector.probe(clip.path);
      if (job.kind === "video" && !probe.hasVideo)
        throw new ImportFailure("download_failed");
      const duration = probe.durationSeconds ?? clip.durationSeconds;
      if (duration !== null && duration > maxDuration + 1)
        throw new ImportFailure("too_long");
      const body = await readFile(clip.path);
      if (body.byteLength > maxBytes) throw new ImportFailure("too_large");

      // ── audio: a la biblioteca de audio de la marca (sprint 7, `0025`) ──
      // Bajo `audio/{companyId}/` —el prefijo que el build autoriza como
      // librería— y con fila en `brand_audio_tracks`, que es lo que el editor
      // lista. Antes quedaba en `media/…/imports/` sin fila: no se podía elegir
      // y el render la rechazaba. `createFromImport` es idempotente por
      // `importId`: un reintento encuentra la fila.
      if (job.kind === "audio") {
        const stored = await deps.storage.put({
          key: `${brandAudioKeyPrefix(job.companyId)}/imports/${job.importId}.${clip.extension}`,
          body,
          contentType: clip.contentType,
        });
        const audioUrl = await canonicalObjectUrl(deps.storage, stored.key);
        await inCompany(job.companyId, (tx) =>
          brandAudioRepository.createFromImport(
            tx,
            { companyId: job.companyId },
            {
              importId: job.importId,
              title: importedAudioTitle(clip.title),
              origin: "import",
              storageKey: stored.key,
              url: audioUrl,
              contentType: clip.contentType,
              sizeMb: body.byteLength / BYTES_PER_MB,
              durationSec: duration,
              sourceUrl: job.url,
            },
          ),
        );
        status = await save(job, status, {
          state: "imported",
          audioUrl,
          background: "not_requested",
          tagging: "skipped",
        });
        deps.logger.info(log, "audio importado");
        return status;
      }

      // ── video ──
      const chroma = await deps.chroma.remove({
        path: clip.path,
        contentType: clip.contentType,
      });
      const isGreen = chroma.kind === "chroma_key";
      // Sprint 7: el meme que encuentra «crear desde prompt» no se etiqueta
      // (el job de prompt tiene 120 s y un modelo de visión local puede
      // tardar), y no paga un recorte: sólo sirve si ya es verde.
      const tagger = options.tagging === false ? null : await deps.tagger();
      let frames: readonly Uint8Array[] = [];
      if (tagger !== null) {
        try {
          frames = await deps.inspector.frames(
            clip.path,
            CLIP_TAGGING_FRAMES,
            CLIP_TAGGING_FRAME_MAX_SIDE,
          );
        } catch (error: unknown) {
          deps.logger.warn(
            { ...log, error },
            "no se pudieron sacar cuadros para etiquetar",
          );
        }
      }

      const requested = job.categories.filter((c) => VIDEO_CATEGORIES.includes(c));
      const categories = categoriesForOriginal(requested, isGreen);
      const stored = await deps.storage.put({
        key: `media/${job.companyId}/imports/${job.mediaId}/${randomUUID()}.${clip.extension}`,
        body,
        contentType: clip.contentType,
      });
      const filename = importFilename(clip.title, clip.extension);
      const row = await createOriginalRow(job, {
        filename,
        storageKey: stored.key,
        r2Url: await canonicalObjectUrl(deps.storage, stored.key),
        sizeMb: stored.sizeBytes / BYTES_PER_MB,
        videoDurationSec: duration === null ? null : Math.round(duration),
        categories,
      });
      if (!row.created) await discard(stored.key);

      const wantsCutout =
        wantsForeground(job.categories) && !isGreen && options.paidCutout !== false;
      status = await save(job, status, {
        state: "imported",
        mediaId: job.mediaId,
        background: isGreen ? "green_screen" : wantsCutout ? "pending" : "not_requested",
        tagging: tagger === null ? "skipped" : "pending",
      });

      // ── De acá en adelante nada relanza: el clip ya está en el Media Bank. ──
      let background: BackgroundState = status.background ?? "not_requested";
      let cutoutMediaId: string | undefined;
      if (wantsCutout) {
        const remover = await deps.backgroundRemoval().catch(() => null);
        if (remover === null) {
          background = "needs_background_removal";
        } else {
          try {
            const cut = await remover.remove({
              path: clip.path,
              contentType: clip.contentType,
            });
            if (cut.kind === "alpha_video") {
              const id = randomUUID();
              const cutStored = await deps.storage.put({
                key: `media/${job.companyId}/imports/${job.mediaId}/cutout-${id}.${cut.extension}`,
                body: cut.body,
                contentType: cut.contentType,
              });
              const cutUrl = await canonicalObjectUrl(deps.storage, cutStored.key);
              await inCompany(job.companyId, (tx) =>
                mediaRepository.create(
                  tx,
                  { companyId: job.companyId },
                  {
                    mediaId: id,
                    mediaType: "video",
                    filename: importFilename(
                      `${filename.replace(/\.[^.]+$/, "")} cutout`,
                      cut.extension,
                    ),
                    r2Url: cutUrl,
                    storageKey: cutStored.key,
                    // `ready` sin normalizar a propósito: ver la cabecera.
                    status: "ready",
                    sizeMb: cutStored.sizeBytes / BYTES_PER_MB,
                    ...(duration === null
                      ? {}
                      : { videoDurationSec: Math.round(duration) }),
                    categories: [GREEN_SCREEN_CATEGORY],
                    origin: "manual_upload",
                  },
                ),
              );
              cutoutMediaId = id;
              background = "removed";
            } else {
              background = "failed";
            }
          } catch (error: unknown) {
            deps.logger.warn(
              { ...log, remover: remover.id, error },
              "recorte de fondo fallido; el original queda igual",
            );
            background = "failed";
          }
        }
      }

      let tagging: TaggingState = tagger === null ? "skipped" : "failed";
      let tags: ClipTags | undefined;
      if (tagger !== null && frames.length > 0) {
        try {
          tags = await tagger.tag(frames);
          tagging = "tagged";
        } catch (error: unknown) {
          deps.logger.warn({ ...log, error }, "etiquetado fallido");
        }
      }

      try {
        await writeMediaMeta(deps.storage, job.companyId, {
          mediaId: job.mediaId,
          sourceUrl: url.url,
          background,
          ...(tags === undefined ? {} : { tags }),
          ...(cutoutMediaId === undefined ? {} : { cutoutMediaId }),
        });
        if (cutoutMediaId !== undefined) {
          await writeMediaMeta(deps.storage, job.companyId, {
            mediaId: cutoutMediaId,
            sourceUrl: url.url,
            background: "removed",
            cutoutOf: job.mediaId,
            ...(tags === undefined ? {} : { tags }),
          });
        }
      } catch (error: unknown) {
        deps.logger.warn({ ...log, error }, "no se pudo guardar la metadata del clip");
      }

      // Sprint 7: las etiquetas automáticas también van a `media.tags` (0029),
      // que es lo que filtra y busca el Media Bank y lo que rankea JV-6.
      if (tags !== undefined) {
        const labels = [
          ...new Set(
            [tags.emotion, tags.situation, ...tags.tags]
              .map((t) => t.trim().toLowerCase())
              .filter((t) => t.length > 0 && t.length <= 40),
          ),
        ];
        const ids =
          cutoutMediaId === undefined ? [job.mediaId] : [job.mediaId, cutoutMediaId];
        try {
          await inCompany(job.companyId, async (tx) => {
            for (const id of ids) {
              for (const label of labels) {
                await addMediaTag(tx, { companyId: job.companyId }, id, label);
              }
            }
          });
        } catch (error: unknown) {
          deps.logger.warn(
            { ...log, error },
            "no se pudieron guardar las etiquetas del clip",
          );
        }
      }

      status = await save(job, status, {
        background,
        tagging,
        ...(tags === undefined ? {} : { tags }),
        ...(cutoutMediaId === undefined ? {} : { cutoutMediaId }),
      });
      deps.logger.info(
        { ...log, mediaId: job.mediaId, background, tagging },
        "video importado",
      );
    } catch (error: unknown) {
      if (error instanceof ImportFailure) {
        await fail(error.code);
        return status;
      }
      if (status.state === "imported") {
        // Ya hay fila: no se reintenta (bajaría el clip otra vez).
        deps.logger.error({ ...log, error }, "error después de importar; el clip queda");
        return status;
      }
      if (ctx.attempt < ctx.maxAttempts) throw error;
      deps.logger.error({ ...log, error }, "import fallido definitivamente");
      await fail("download_failed");
    } finally {
      // Siempre, también si algo lanzó arriba.
      if (dir !== null) await rm(dir, { recursive: true, force: true });
    }
    return status;
  };
}

export function createMediaImportHandler(deps: MediaImportDeps): JobHandler<unknown> {
  const runImport = createMediaImportRunner(deps);
  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseMediaImportJob(ctx.payload);
    if (!parsed.ok) {
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de media-import inválido",
      );
      return;
    }
    await runImport(parsed.job, ctx);
  };
}
