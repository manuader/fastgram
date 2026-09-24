/**
 * Sprint 7 (agente F), contra Postgres: el video propio (`custom`) deja de
 * terminar siempre `FAILED`, el HDR sin `zscale` conserva el original, y el
 * Studio con IA escribe el texto antes del primer render.
 *
 * ## El MOV es de verdad
 *
 * Lo genera `ffmpeg` en el `beforeAll` (contenedor QuickTime, `moov` al final,
 * como sale de un iPhone). El renderer de normalización de este test es un
 * doble **que corre FFmpeg de verdad** sobre los bytes del storage: probe con
 * `ffprobe`, transcodificación a MP4 con `+faststart` y miniatura JPEG. Lo que
 * no ejercita es el HTTP de `services/render` (eso lo cubre
 * `render-wiring.int.test.ts` y la suite del servicio): acá se mide que el
 * **handler** lea el archivo que antes no encontraba, lo normalice y cierre
 * `CREATED` con un MP4 que ffprobe reconoce como MP4 con `moov` adelante.
 *
 * Sin `ffmpeg`/`ffprobe` en el PATH, esos casos se saltean con el motivo en
 * el nombre.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  FixedClock,
  MemoryMediaRenderer,
  MemoryStorage,
  canonicalObjectUrl,
} from "@fastgram/adapters";
import { APP_ROLE, migrateWithUrl, type DbHandle } from "@fastgram/db";
import {
  PortError,
  type JobContext,
  type Llm,
  type LlmJsonRequest,
  type MediaProbe,
  type MediaRenderer,
  type NormalizeRequest,
  type RenderBuild,
  type RenderedMedia,
  type RenderResult,
  type ThumbnailRequest,
} from "@fastgram/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createContentBuildHandler,
  type BuildLogger,
} from "../src/content/build-handler.js";
import { createMediaNormalizationHandler } from "../src/media/normalization-handler.js";
import { DATABASE_URL, openDb, seedCompany, seedPiece } from "./helpers/fixtures.js";

const run = promisify(execFile);
const NOW = new Date("2026-09-24T12:00:00.000Z");
const clock = new FixedClock(NOW);
const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;
let companyId: string;
let dir: string;
let movBytes: Uint8Array | null = null;

/** Se decide al cargar el módulo: el `describe` necesita saberlo antes del `beforeAll`. */
const ffmpegMissing: string | null = await Promise.all([
  run("ffmpeg", ["-version"]),
  run("ffprobe", ["-version"]),
]).then(
  () => null,
  () => "sin ffmpeg/ffprobe en el PATH",
);

async function bytesOf(body: RenderedMedia["body"]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Orden de los átomos de primer nivel de un ISOBMFF: `moov` antes que `mdat` = faststart. */
function topLevelAtoms(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const view = Buffer.from(bytes);
  let at = 0;
  while (at + 8 <= view.length) {
    let size = view.readUInt32BE(at);
    const type = view.toString("latin1", at + 4, at + 8);
    if (size === 1) size = Number(view.readBigUInt64BE(at + 8));
    if (size < 8) break;
    out.push(type);
    at += size;
  }
  return out;
}

/**
 * El doble de `MediaRenderer` para `probe`/`normalize`/`thumbnail`, con
 * FFmpeg de verdad. Los métodos de render lanzan: un video propio no se
 * renderiza (trampa 46: si el handler usara el renderer equivocado, lo dice).
 */
class FfmpegRenderer implements MediaRenderer {
  readonly calls: string[] = [];
  constructor(
    private readonly storage: MemoryStorage,
    private readonly base: string,
  ) {}

  async render(): Promise<RenderResult> {
    throw new Error("un video propio no se renderiza");
  }
  async renderAll(): Promise<RenderBuild> {
    throw new Error("un video propio no se renderiza");
  }
  fingerprint(): string {
    throw new Error("un video propio no se renderiza");
  }

  private async fileFor(url: string, ext: string): Promise<string> {
    const key = decodeURIComponent(url.slice(this.base.length));
    const bytes = await bytesOf(await this.storage.get(key));
    const file = path.join(dir, `${randomUUID()}${ext}`);
    await writeFile(file, bytes);
    return file;
  }

  async probe(url: string): Promise<MediaProbe> {
    this.calls.push("probe");
    const file = await this.fileFor(url, ".bin");
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      file,
    ]);
    const info = JSON.parse(stdout) as {
      format: { duration?: string; tags?: { major_brand?: string } };
      streams: {
        codec_type: string;
        width?: number;
        height?: number;
        color_transfer?: string;
      }[];
    };
    const video = info.streams.find((s) => s.codec_type === "video");
    const brand = (info.format.tags?.major_brand ?? "").trim();
    const atoms = topLevelAtoms(await readFile(file));
    return {
      contentType: brand === "qt" ? "video/quicktime" : "video/mp4",
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      durationSeconds: Number(info.format.duration ?? "0"),
      hasAudio: info.streams.some((s) => s.codec_type === "audio"),
      isHdr: ["smpte2084", "arib-std-b67"].includes(video?.color_transfer ?? ""),
      isFastStart:
        atoms.indexOf("moov") !== -1 && atoms.indexOf("moov") < atoms.indexOf("mdat"),
    };
  }

  async normalize(request: NormalizeRequest): Promise<RenderedMedia> {
    this.calls.push("normalize");
    const input = await this.fileFor(request.url, ".mov");
    const output = path.join(dir, `${randomUUID()}.mp4`);
    await run("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      output,
    ]);
    const bytes = await readFile(output);
    return {
      body: (async function* () {
        yield new Uint8Array(bytes);
      })(),
      contentType: "video/mp4",
      sizeBytes: bytes.byteLength,
      width: 320,
      height: 568,
    };
  }

  async thumbnail(request: ThumbnailRequest): Promise<RenderedMedia> {
    this.calls.push("thumbnail");
    const input = await this.fileFor(request.url, ".mp4");
    const output = path.join(dir, `${randomUUID()}.jpg`);
    await run("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-frames:v",
      "1",
      "-vf",
      `scale=${String(request.maxWidth ?? 480)}:-2`,
      output,
    ]);
    const bytes = await readFile(output);
    return {
      body: (async function* () {
        yield new Uint8Array(bytes);
      })(),
      contentType: "image/jpeg",
      sizeBytes: bytes.byteLength,
      width: 480,
      height: 852,
    };
  }
}

const ctx = (payload: unknown, attempt = 1, maxAttempts = 3): JobContext<unknown> => ({
  jobId: "job_studio_media",
  payload,
  attempt,
  maxAttempts,
});

async function rowOf(contentId: string) {
  const [row] = await handle.sql<
    {
      status: string;
      files: string[];
      thumbnail_url: string | null;
      build_payload: Record<string, unknown>;
      last_edit: Record<string, unknown> | null;
    }[]
  >`select status, files, thumbnail_url, build_payload, last_edit from contents where id = ${contentId}`;
  if (row === undefined) throw new Error("la pieza no existe");
  return row;
}

/** Una pieza `custom` como la deja `POST /content/custom/video`, con el MOV subido. */
async function customPiece(storage: MemoryStorage, bytes: Uint8Array) {
  const storageKey = `content/custom-video/${companyId}/${randomUUID()}.mov`;
  await storage.put({ key: storageKey, body: bytes, contentType: "video/quicktime" });
  const contentId = await seedPiece(handle, companyId, {
    type: "custom",
    saveBucket: null,
    buildPayload: {
      customVideo: { storageKey, contentType: "video/quicktime", filename: "clip.mov" },
    },
  });
  return { contentId, storageKey };
}

const job = (contentId: string, extra: Record<string, unknown> = {}) => ({
  companyId,
  contentId,
  contentType: "custom",
  revision: 1,
  reason: "custom-video",
  ...extra,
});

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = openDb();
  companyId = await seedCompany(handle);
  dir = await mkdtemp(path.join(tmpdir(), "fastgram-studio-media-"));
  if (ffmpegMissing === null) {
    const mov = path.join(dir, "iphone.mov");
    await run("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x568:rate=25",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-f",
      "mov",
      mov,
    ]);
    movBytes = new Uint8Array(await readFile(mov));
  }
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await handle?.close();
});

const itFfmpeg = (name: string, fn: () => Promise<void>) =>
  (ffmpegMissing === null ? it : it.skip)(
    ffmpegMissing === null ? name : `${name} · SALTEADA — ${ffmpegMissing}`,
    fn,
    120_000,
  );

describe("content-build · video propio (P2-STUDIO-009, P1-QUEUE-008)", () => {
  itFfmpeg(
    "un MOV real se normaliza a MP4 faststart, con miniatura, y cierra CREATED",
    async () => {
      const storage = new MemoryStorage(clock);
      const base = (await canonicalObjectUrl(storage, "")).replace(/\/$/, "/");
      const normalizer = new FfmpegRenderer(storage, base);
      const { contentId, storageKey } = await customPiece(
        storage,
        movBytes as Uint8Array,
      );

      // Sanity del fixture: el original **no** es MP4 ni faststart.
      const original = await normalizer.probe(
        await canonicalObjectUrl(storage, storageKey),
      );
      expect(original.contentType).toBe("video/quicktime");
      expect(original.isFastStart).toBe(false);
      normalizer.calls.length = 0;

      await createContentBuildHandler({
        db: handle.db,
        // El del build es el de memoria: si el handler lo usara para el video
        // propio, `renderAll` saldría con bytes sintéticos y el test lo vería.
        renderer: new MemoryMediaRenderer(),
        normalizer,
        storage,
        clock,
        appRole: APP_ROLE,
        logger: silencioso,
      })(ctx(job(contentId)));

      const row = await rowOf(contentId);
      expect(row.status).toBe("CREATED");
      expect(row.files).toHaveLength(1);
      // `MemoryStorage` codifica la clave en la URL (`%2F`).
      expect(decodeURIComponent(row.files[0] as string)).toMatch(
        new RegExp(`content/${companyId}/${contentId}/1/0\\.mp4$`),
      );
      expect(row.thumbnail_url).not.toBeNull();
      expect(row.build_payload["customVideo"]).toEqual(
        expect.objectContaining({ normalization: "normalized" }),
      );
      expect(normalizer.calls).toEqual(["probe", "normalize", "thumbnail"]);

      // Lo que quedó en el bucket es MP4 de verdad, con el `moov` adelante.
      const probe = await normalizer.probe(row.files[0] as string);
      expect(probe.contentType).toBe("video/mp4");
      expect(probe.isFastStart).toBe(true);
      expect(probe.durationSeconds).toBeGreaterThan(0.5);
    },
  );

  itFfmpeg(
    "sin servicio de render: el original tal cual, marcado `not_normalized`",
    async () => {
      const storage = new MemoryStorage(clock);
      const { contentId, storageKey } = await customPiece(
        storage,
        movBytes as Uint8Array,
      );
      await createContentBuildHandler({
        db: handle.db,
        renderer: new MemoryMediaRenderer(),
        normalizer: null,
        storage,
        clock,
        appRole: APP_ROLE,
        logger: silencioso,
      })(ctx(job(contentId)));

      const row = await rowOf(contentId);
      expect(row.status).toBe("CREATED");
      expect(row.files).toEqual([await canonicalObjectUrl(storage, storageKey)]);
      expect(row.build_payload["customVideo"]).toEqual(
        expect.objectContaining({ normalization: "not_normalized" }),
      );
    },
  );

  it("una fila vieja sin la clave sigue cerrando FAILED con código estable", async () => {
    const storage = new MemoryStorage(clock);
    const contentId = await seedPiece(handle, companyId, {
      type: "custom",
      saveBucket: null,
      buildPayload: null,
    });
    await createContentBuildHandler({
      db: handle.db,
      renderer: new MemoryMediaRenderer(),
      normalizer: null,
      storage,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    })(ctx(job(contentId)));
    const row = await rowOf(contentId);
    expect(row.status).toBe("FAILED");
    expect(row.last_edit).toEqual(
      expect.objectContaining({ failureReason: "custom_not_renderable" }),
    );
  });

  it("una clave de otra marca en el payload no se lee", async () => {
    const storage = new MemoryStorage(clock);
    const contentId = await seedPiece(handle, companyId, {
      type: "custom",
      saveBucket: null,
      buildPayload: {
        customVideo: {
          storageKey: `content/custom-video/${randomUUID()}/robado.mov`,
          contentType: "video/quicktime",
        },
      },
    });
    await createContentBuildHandler({
      db: handle.db,
      renderer: new MemoryMediaRenderer(),
      normalizer: null,
      storage,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    })(ctx(job(contentId)));
    expect((await rowOf(contentId)).status).toBe("FAILED");
  });
});

/** Un renderer que dice HDR y contesta como `services/render` sin `zscale`. */
class HdrSinZscale extends MemoryMediaRenderer {
  normalizes = 0;
  override async probe(): Promise<MediaProbe> {
    return {
      contentType: "video/quicktime",
      width: 1080,
      height: 1920,
      durationSeconds: 4.2,
      hasAudio: true,
      isHdr: true,
      isFastStart: false,
    };
  }
  override async normalize(): Promise<RenderedMedia> {
    this.normalizes += 1;
    throw new PortError("provider_unavailable", "the render service failed", {
      source: "http-media-renderer",
      cause:
        '{"error":{"code":"render_capability_missing","message":"el medio es HDR","details":{"missing":["zscale"]}}}',
    });
  }
}

describe("HDR sin zscale (P2-RENDER-013)", () => {
  it("media-normalization: `ready` con el original y la marca, sin reintentar", async () => {
    const storage = new MemoryStorage(clock);
    const key = `media/${companyId}/hdr.mov`;
    await storage.put({
      key,
      body: new Uint8Array([1, 2, 3]),
      contentType: "video/quicktime",
    });
    const url = await canonicalObjectUrl(storage, key);
    const [row] = await handle.sql<{ media_id: string }[]>`
      insert into media (company_id, media_type, filename, r2_url, storage_key, status, size_mb, origin)
      values (${companyId}::uuid, 'video', 'hdr.mov', ${url}, ${key}, 'processing', 1, 'manual_upload')
      returning media_id
    `;
    const mediaId = row?.media_id as string;
    const renderer = new HdrSinZscale();

    // Primer intento: no lanza (no hay nada que reintentar).
    await createMediaNormalizationHandler({
      db: handle.db,
      renderer,
      storage,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    })(ctx({ companyId, mediaId }, 1, 3));

    const [after] = await handle.sql<
      {
        status: string;
        normalization: string | null;
        storage_key: string;
        video_duration_sec: number;
      }[]
    >`select status, normalization, storage_key, video_duration_sec from media where media_id = ${mediaId}`;
    expect(after).toEqual({
      status: "ready",
      normalization: "hdr_kept_original",
      storage_key: key,
      video_duration_sec: 4,
    });
    expect(renderer.normalizes).toBe(1);
  });

  it("video propio HDR: CREATED con el original, marcado", async () => {
    const storage = new MemoryStorage(clock);
    const { contentId, storageKey } = await customPiece(
      storage,
      new Uint8Array([9, 9, 9]),
    );
    await createContentBuildHandler({
      db: handle.db,
      renderer: new MemoryMediaRenderer(),
      normalizer: new HdrSinZscale(),
      storage,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    })(ctx(job(contentId)));
    const row = await rowOf(contentId);
    expect(row.status).toBe("CREATED");
    expect(row.files).toEqual([await canonicalObjectUrl(storage, storageKey)]);
    expect(row.build_payload["customVideo"]).toEqual(
      expect.objectContaining({ normalization: "hdr_kept_original" }),
    );
  });

  it("un `provider_unavailable` que NO es falta de zscale se sigue reintentando", async () => {
    const storage = new MemoryStorage(clock);
    const { contentId } = await customPiece(storage, new Uint8Array([9]));
    class Caido extends HdrSinZscale {
      override async normalize(): Promise<RenderedMedia> {
        throw new PortError("provider_unavailable", "down", {
          source: "x",
          cause: "ECONNREFUSED",
        });
      }
    }
    const handler = createContentBuildHandler({
      db: handle.db,
      renderer: new MemoryMediaRenderer(),
      normalizer: new Caido(),
      storage,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    });
    await expect(handler(ctx(job(contentId), 1, 3))).rejects.toThrow();
    expect((await rowOf(contentId)).status).toBe("BUILDING");
    await handler(ctx(job(contentId), 3, 3));
    expect((await rowOf(contentId)).status).toBe("FAILED");
  });
});

class LlmFake implements Llm {
  respuesta: unknown = { texts: ["Texto de la IA"] };
  pedidos: LlmJsonRequest[] = [];
  complete(): never {
    throw new Error("va por completeJson");
  }
  async completeJson(req: LlmJsonRequest) {
    this.pedidos.push(req);
    return {
      value: this.respuesta,
      raw: JSON.stringify(this.respuesta),
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "fake-llm",
      deterministic: true,
      latencyMs: 1,
    };
  }
}

describe("Content Studio con IA (`create` + `prompt`)", () => {
  const payload = {
    canvas: { width: 1080, height: 1920 },
    video: {
      url: "https://cdn.example.test/a.mp4",
      drawX: 0,
      drawY: 0,
      drawW: 1080,
      drawH: 1920,
    },
    text: {
      content: "running tips",
      x: 540,
      y: 960,
      width: 972,
      fontSize: 18,
      color: "#FFFFFF",
      textAlign: "center",
    },
  };

  it("el modelo escribe antes del render; las cajas quedan guardadas y no hay `lastEdit`", async () => {
    const storage = new MemoryStorage(clock);
    const llm = new LlmFake();
    const contentId = await seedPiece(handle, companyId, { buildPayload: payload });
    await createContentBuildHandler({
      db: handle.db,
      renderer: new MemoryMediaRenderer(),
      storage,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      copyLlm: async () => llm,
    })(
      ctx({
        companyId,
        contentId,
        contentType: "wall-of-text",
        revision: 1,
        reason: "create",
        prompt: "running tips",
      }),
    );
    const row = await rowOf(contentId);
    expect(row.status).toBe("CREATED");
    expect(row.last_edit).toBeNull();
    expect(llm.pedidos).toHaveLength(1);
    const boxes = await handle.sql<{ text: string }[]>`
      select text from content_text_boxes where content_id = ${contentId}
    `;
    expect(boxes.map((b) => b.text)).toEqual(["Texto de la IA"]);
  });

  it("sin modelo: FAILED con `llm_not_configured` y el save se devuelve", async () => {
    const storage = new MemoryStorage(clock);
    const contentId = await seedPiece(handle, companyId, { buildPayload: payload });
    await createContentBuildHandler({
      db: handle.db,
      renderer: new MemoryMediaRenderer(),
      storage,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      copyLlm: async () => null,
    })(
      ctx({
        companyId,
        contentId,
        contentType: "wall-of-text",
        revision: 1,
        reason: "create",
        prompt: "x",
      }),
    );
    const [row] = await handle.sql<
      {
        status: string;
        save_refunded_at: Date | null;
        last_edit: { failureReason?: string };
      }[]
    >`
      select status, save_refunded_at, last_edit from contents where id = ${contentId}
    `;
    expect(row?.status).toBe("FAILED");
    expect(row?.save_refunded_at).not.toBeNull();
    expect(row?.last_edit.failureReason).toBe("llm_not_configured");
  });
});
