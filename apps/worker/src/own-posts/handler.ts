/**
 * El handler de `own-post-import` — `FR-011.5.1`, D-04, `P1-ONB-008`, §9.5 #21.
 *
 * ```
 *   [tx]  leer la fila; si ya terminó, nada; si no, `running`
 *         listar (Graph de Instagram, Data API de YouTube, o yt-dlp del perfil)
 *         por cada post, hasta `max_items`:
 *           ¿ya hay un asset con ese `source_ref`? → skipped (dedupe)
 *           bajar (URL directa o yt-dlp) → put en `media/<marca>/imported/…`
 *           [tx] INSERT … ON CONFLICT DO NOTHING (índice único parcial)
 *                + encolar `media-normalization` si es video
 *   [tx]  `done` con los contadores (o `failed` con código estable)
 * ```
 *
 * ## Idempotencia
 *
 * Una reentrega vuelve a listar y vuelve a pasar por el dedupe: lo que ya se
 * importó cuenta como `skipped`, no se duplica. La guarda la sostiene el
 * índice `media_company_source_ref_uq` (dos corridas en paralelo del mismo
 * post: una inserta, la otra choca y borra lo que subió).
 *
 * ## Decisiones que el PRD no cubre
 *
 * - **Categorías**: una imagen entra como `slideshow-image` y un video como
 *   `background-video`, para que Blitz los use desde el día 1 (el «beneficio
 *   directo» de `FR-011.5.1`). Se cambian en el Media Bank como cualquier otro.
 * - **Un post que falla no falla el import**: cuenta como `failed` y se sigue.
 *   El import entero falla sólo si no se pudo listar.
 * - **Duración**: tope de 10 min por video (el del import por link es 3 min,
 *   pensado para memes). El tope de tamaño es el del Media Bank (50 MB).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalObjectUrl } from "@fastgram/adapters";
import {
  BYTES_PER_MB,
  UPLOAD_IMAGE_MAX_MB,
  UPLOAD_VIDEO_MAX_MB,
} from "@fastgram/contracts";
import { JOB_QUEUES } from "@fastgram/core";
import {
  findMediaBySourceRef,
  insertImportedMedia,
  ownPostImportRepository,
  withCompany,
  type Database,
  type OwnPostImportRow,
  type Transaction,
} from "@fastgram/db";
import type {
  Clock,
  ConnectionTokens,
  JobContext,
  JobHandler,
  MediaDownloader,
  Queue,
  Storage,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import {
  listInstagramMedia,
  listYouTubeUploads,
  type Fetch,
  type ListOutcome,
  type OwnPostItem,
  type ProfileLister,
} from "./listers.js";

/** Los `maxAttempts: 3` de `mediaNormalization` en el catálogo, en reintentos. */
const MEDIA_NORMALIZATION_RETRY_LIMIT = 2;
const MAX_VIDEO_SECONDS = 600;
const DOWNLOAD_TIMEOUT_MS = 180_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El payload. Escrito dos veces (acá y en la ruta de la API), como el de la normalización. */
export interface OwnPostImportJob {
  readonly companyId: string;
  readonly importId: string;
}

export function parseOwnPostImportJob(
  payload: unknown,
): { ok: true; job: OwnPostImportJob } | { ok: false; reason: string } {
  if (typeof payload !== "object" || payload === null)
    return { ok: false, reason: "el payload no es un objeto" };
  const { companyId, importId } = payload as Record<string, unknown>;
  if (typeof companyId !== "string" || !UUID.test(companyId))
    return { ok: false, reason: "companyId ausente o no es un uuid" };
  if (typeof importId !== "string" || !UUID.test(importId))
    return { ok: false, reason: "importId ausente o no es un uuid" };
  return { ok: true, job: { companyId, importId } };
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const VIDEO_TYPES: Readonly<Record<string, string>> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

export interface OwnPostImportDeps {
  readonly db: Database;
  readonly storage: Storage;
  readonly queue: Queue;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  /** Tokens de las conexiones. `null` = sin publicación montada: sólo perfiles. */
  readonly tokens: ConnectionTokens | null;
  /** `yt-dlp` (del import por link). `null` = sin `yt-dlp`: sólo Instagram. */
  readonly downloader: MediaDownloader | null;
  readonly profiles: ProfileLister | null;
  readonly fetch?: Fetch;
  readonly tempRoot?: string;
}

type Counters = { found: number; imported: number; skipped: number; failed: number };

export function createOwnPostImportHandler(deps: OwnPostImportDeps): JobHandler<unknown> {
  const http: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const inCompany = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>) =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  async function list(
    job: OwnPostImportJob,
    row: OwnPostImportRow,
  ): Promise<ListOutcome> {
    if (row.source === "profile") {
      if (deps.profiles === null || row.profileUrl === null)
        return { ok: false, code: "listing_failed" };
      return deps.profiles.list(row.profileUrl, row.platform, row.maxItems);
    }
    if (deps.tokens === null || row.connectionId === null)
      return { ok: false, code: "connection_unavailable" };
    let token: string;
    try {
      token = await deps.tokens.getAccessToken(row.connectionId, {
        companyId: job.companyId,
      });
    } catch {
      return { ok: false, code: "connection_unavailable" };
    }
    if (row.platform === "instagram")
      return listInstagramMedia(http, token, row.maxItems);
    if (row.platform === "youtube") return listYouTubeUploads(http, token, row.maxItems);
    return { ok: false, code: "listing_failed" };
  }

  /** Baja un archivo directo con tope de tamaño. `null` = no sirve. */
  async function downloadDirect(
    item: OwnPostItem,
  ): Promise<{ body: Uint8Array; contentType: string; ext: string } | null> {
    if (item.directUrl === undefined) return null;
    const response = await http(item.directUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const contentType =
      (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    const table = item.kind === "image" ? IMAGE_TYPES : VIDEO_TYPES;
    const ext = table[contentType];
    if (ext === undefined) return null;
    const max =
      (item.kind === "image" ? UPLOAD_IMAGE_MAX_MB : UPLOAD_VIDEO_MAX_MB) * BYTES_PER_MB;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > max) return null;
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > max) return null;
    return { body, contentType, ext };
  }

  async function downloadPage(
    item: OwnPostItem,
    dir: string,
  ): Promise<{
    body: Uint8Array;
    contentType: string;
    ext: string;
    durationSeconds: number | null;
    title: string | null;
  } | null> {
    if (deps.downloader === null || item.pageUrl === undefined) return null;
    const outcome = await deps.downloader.download({
      url: item.pageUrl,
      kind: "video",
      directory: dir,
      maxDurationSeconds: MAX_VIDEO_SECONDS,
      maxBytes: UPLOAD_VIDEO_MAX_MB * BYTES_PER_MB,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    if (!outcome.ok) return null;
    const ext = VIDEO_TYPES[outcome.clip.contentType];
    if (ext === undefined) return null;
    return {
      body: new Uint8Array(await readFile(outcome.clip.path)),
      contentType: outcome.clip.contentType,
      ext,
      durationSeconds: outcome.clip.durationSeconds,
      title: outcome.clip.title,
    };
  }

  /** Un post: `imported`, `skipped` o `failed`. Nunca lanza por el post en sí. */
  async function importOne(
    job: OwnPostImportJob,
    item: OwnPostItem,
    dir: string,
  ): Promise<"imported" | "skipped" | "failed"> {
    const scope = { companyId: job.companyId };
    const existing = await inCompany(job.companyId, (tx) =>
      findMediaBySourceRef(tx, scope, item.ref),
    );
    if (existing !== null) return "skipped";

    let file: {
      body: Uint8Array;
      contentType: string;
      ext: string;
      durationSeconds?: number | null;
      title?: string | null;
    } | null;
    try {
      file =
        item.directUrl !== undefined
          ? await downloadDirect(item)
          : await downloadPage(item, dir);
    } catch (error: unknown) {
      deps.logger.warn({ ref: item.ref, error }, "no se pudo bajar un post propio");
      return "failed";
    }
    if (file === null) return "failed";

    const key = `media/${job.companyId}/imported/${randomUUID()}${file.ext}`;
    const stored = await deps.storage.put({
      key,
      body: file.body,
      contentType: file.contentType,
    });
    const url = await canonicalObjectUrl(deps.storage, stored.key);
    const isVideo = file.contentType.startsWith("video/");
    const label = (file.title ?? item.title ?? item.ref)
      .replace(/[^\w .-]+/g, " ")
      .trim()
      .slice(0, 80);

    const inserted = await inCompany(job.companyId, async (tx) => {
      const row = await insertImportedMedia(tx, scope, {
        sourceRef: item.ref,
        mediaType: isVideo ? "video" : "image",
        filename: `${label === "" ? item.ref.replace(":", "-") : label}${file.ext}`,
        r2Url: url,
        storageKey: stored.key,
        // FR-100: la imagen nace `ready`; el video `processing` hasta normalizarse.
        status: isVideo ? "processing" : "ready",
        sizeMb: stored.sizeBytes / BYTES_PER_MB,
        ...(file.durationSeconds === undefined || file.durationSeconds === null
          ? {}
          : { videoDurationSec: Math.round(file.durationSeconds) }),
        categories: isVideo ? ["background-video"] : ["slideshow-image"],
      });
      if (row !== null && isVideo) {
        // Dentro de la transacción (ADR-005): sin job no hay fila.
        await deps.queue.enqueue({
          queue: JOB_QUEUES.mediaNormalization,
          payload: { companyId: job.companyId, mediaId: row.mediaId },
          options: {
            transaction: tx,
            singletonKey: `${JOB_QUEUES.mediaNormalization}:${row.mediaId}`,
            retryLimit: MEDIA_NORMALIZATION_RETRY_LIMIT,
            retryBackoff: true,
          },
        });
      }
      return row;
    });
    if (inserted === null) {
      // Otra corrida lo importó mientras bajábamos: lo nuestro sobra.
      try {
        await deps.storage.delete(stored.key);
      } catch (error: unknown) {
        deps.logger.warn({ key: stored.key, error }, "no se pudo borrar un duplicado");
      }
      return "skipped";
    }
    return "imported";
  }

  async function finish(
    job: OwnPostImportJob,
    patch: Partial<Counters> & { state: "done" | "failed"; errorCode?: string | null },
  ): Promise<void> {
    await inCompany(job.companyId, (tx) =>
      ownPostImportRepository.update(tx, { companyId: job.companyId }, job.importId, {
        ...patch,
        updatedAt: new Date(deps.clock.nowMs()),
      }),
    );
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseOwnPostImportJob(ctx.payload);
    if (!parsed.ok) {
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de own-post-import inválido",
      );
      return;
    }
    const job = parsed.job;
    const base = { jobId: ctx.jobId, importId: job.importId, attempt: ctx.attempt };

    const row = await inCompany(job.companyId, async (tx) => {
      const current = await ownPostImportRepository.findById(
        tx,
        { companyId: job.companyId },
        job.importId,
      );
      if (current === null || current.state === "done" || current.state === "failed")
        return null;
      return ownPostImportRepository.update(
        tx,
        { companyId: job.companyId },
        job.importId,
        {
          state: "running",
          updatedAt: new Date(deps.clock.nowMs()),
        },
      );
    });
    if (row === null) {
      deps.logger.info(base, "import de posts propios omitido (inexistente o terminado)");
      return;
    }

    const listed = await list(job, row);
    if (!listed.ok) {
      await finish(job, { state: "failed", errorCode: listed.code });
      deps.logger.warn(
        { ...base, code: listed.code },
        "no se pudieron listar los posts propios",
      );
      return;
    }
    const items = listed.items.slice(0, row.maxItems);
    if (items.length === 0) {
      await finish(job, { state: "failed", errorCode: "nothing_found", found: 0 });
      return;
    }

    const counters: Counters = {
      found: items.length,
      imported: 0,
      skipped: 0,
      failed: 0,
    };
    const dir = await mkdtemp(
      path.join(deps.tempRoot ?? tmpdir(), "fastgram-own-posts-"),
    );
    try {
      for (const item of items) {
        let result: "imported" | "skipped" | "failed";
        try {
          result = await importOne(job, item, dir);
        } catch (error: unknown) {
          // Storage o base: se cuenta y se sigue; el resto puede andar.
          deps.logger.warn({ ...base, ref: item.ref, error }, "post propio no importado");
          result = "failed";
        }
        counters[result] += 1;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await finish(job, { state: "done", errorCode: null, ...counters });
    deps.logger.info({ ...base, ...counters }, "import de posts propios terminado");
  };
}
