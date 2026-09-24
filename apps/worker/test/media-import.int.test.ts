/**
 * `media-import` contra Postgres real — `PU-MEME-001`/`002`/`003`.
 *
 * Lo que se atraviesa de verdad: el `YtDlpDownloader` lanzando un **binario**
 * como proceso hijo (un `yt-dlp` falso, un script de Node que imita su salida:
 * `--dump-single-json` imprime el JSON, la bajada copia un clip y imprime la
 * ruta final), el `FfmpegClipInspector` con el FFmpeg real sobre clips que
 * genera el test, el storage, las filas y la normalización que las saca de
 * `processing`. Lo único doblado: la cola (se registra el encolado), el
 * renderer de la normalización, fal y el modelo de visión — **ninguna llamada
 * real a un proveedor**.
 *
 * Qué se mide:
 *  · un clip verde → fila `processing` con `green-screen-video`, normalización
 *    encolada **en la misma transacción**, y después `ready`;
 *  · no verde pedido como foreground, sin fal → la fila pierde la categoría y
 *    el estado dice `needs_background_removal`;
 *  · con fal y visión → segunda fila con alfa (`ready`, webm) y etiquetas;
 *  · fallos → código estable, sin filas, y el stderr del binario no aparece;
 *  · el temporal se borra siempre (éxito y fallo);
 *  · un reintento tardío no vuelve a bajar;
 *  · la calibración del umbral de verde con fuentes reales de FFmpeg.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ChromaKeyBackgroundRemoval,
  FalBirefnetBackgroundRemoval,
  FfmpegClipInspector,
  FixedClock,
  MemoryStorage,
  OpenAiVisionTagger,
  YtDlpDownloader,
  type FalFetch,
  type FetchLike,
} from "@fastgram/adapters";
import {
  CLIP_TAGGING_SYSTEM_PROMPT,
  CLIP_TAGGING_USER_PROMPT,
  JOB_QUEUES,
  extractJsonObject,
  greenScreenVerdict,
  importStatusKey,
  mediaMetaKey,
  parseClipTags,
  type MediaImportJob,
} from "@fastgram/core";
import { APP_ROLE, type DbHandle } from "@fastgram/db";
import type {
  BackgroundRemoval,
  ClipTagger,
  EnqueuedJob,
  JobContext,
  JobSpec,
  MediaAuthorization,
  MediaProbe,
  MediaRenderer,
  NormalizeRequest,
  Queue,
  RenderBuild,
  RenderedMedia,
  RenderResult,
  ThumbnailRequest,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createMediaImportHandler } from "../src/media-import/handler.js";
import { createMediaNormalizationHandler } from "../src/media/normalization-handler.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;
const root = mkdtempSync(path.join(tmpdir(), "media-import-it-"));
const binDir = path.join(root, "bin");
const tempRoot = path.join(root, "tmp");
const clips = path.join(root, "clips");
const FAKE = path.join(binDir, "yt-dlp");

/** El `yt-dlp` falso. Lee su guion de `fake-config.json` y registra cada llamada. */
const FAKE_SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "fake-config.json"), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(args) + "\\n");
if (cfg.mode === "unsupported") {
  process.stderr.write("ERROR: Unsupported URL: " + args[args.length - 1] + " /home/secreto/.config\\n");
  process.exit(1);
}
if (args.includes("--dump-single-json")) {
  process.stdout.write(JSON.stringify(cfg.info));
  process.exit(0);
}
const o = args[args.indexOf("-o") + 1];
const out = o.replace("%(ext)s", cfg.ext || "mp4");
fs.copyFileSync(cfg.source, out);
process.stdout.write(out + "\\n");
`;

interface FakeConfig {
  readonly mode?: "unsupported";
  readonly info?: Record<string, unknown>;
  readonly source?: string;
  readonly ext?: string;
}

function guion(cfg: FakeConfig): void {
  writeFileSync(path.join(binDir, "fake-config.json"), JSON.stringify(cfg));
  writeFileSync(path.join(binDir, "calls.log"), "");
}

function llamadas(): string[][] {
  return readFileSync(path.join(binDir, "calls.log"), "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as string[]);
}

function clip(name: string, source: string): string {
  const out = path.join(clips, name);
  execFileSync("ffmpeg", [
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `${source}${source.includes("=") ? ":" : "="}s=360x640:d=2:r=15`,
    "-f",
    "lavfi",
    "-i",
    "sine=f=440:d=2",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    out,
  ]);
  return out;
}

let GREEN = "";
let CHROMA = "";
let BARS = "";

beforeAll(() => {
  handle = openDb();
  mkdirSync(binDir);
  mkdirSync(tempRoot);
  mkdirSync(clips);
  writeFileSync(FAKE, FAKE_SCRIPT);
  chmodSync(FAKE, 0o755);
  GREEN = clip("green.mp4", "color=c=0x00FF00");
  CHROMA = clip("chroma.mp4", "color=c=0x00B140");
  BARS = clip("bars.mp4", "testsrc2");
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await handle?.close();
});

/** Cola que registra: el handler encola la normalización dentro de su transacción. */
class RecordingQueue {
  readonly specs: JobSpec<unknown>[] = [];
  async enqueue<T>(spec: JobSpec<T>): Promise<EnqueuedJob> {
    this.specs.push(spec as JobSpec<unknown>);
    return { jobId: `${spec.queue}#${randomUUID()}`, created: true };
  }
}

class FakeRenderer implements MediaRenderer {
  async render(): Promise<RenderResult> {
    throw new Error("no rinde");
  }
  async renderAll(): Promise<RenderBuild> {
    throw new Error("no rinde");
  }
  fingerprint(): string {
    throw new Error("no rinde");
  }
  async thumbnail(_r: ThumbnailRequest): Promise<RenderedMedia> {
    throw new Error("no");
  }
  async probe(_url: string, _auth: MediaAuthorization): Promise<MediaProbe> {
    return {
      contentType: "video/mp4",
      width: 360,
      height: 640,
      durationSeconds: 2,
      hasAudio: true,
      isHdr: false,
      isFastStart: true,
    };
  }
  async normalize(_r: NormalizeRequest, _a: MediaAuthorization): Promise<RenderedMedia> {
    throw new Error("ya es MP4 faststart: no se normaliza");
  }
}

const inspector = new FfmpegClipInspector();
const publicDns = async (): Promise<readonly string[]> => ["93.184.215.14"];

function downloader() {
  return new YtDlpDownloader({ binary: FAKE, resolveHost: publicDns });
}

function fakeFal(): { remover: BackgroundRemoval; calls: string[] } {
  const calls: string[] = [];
  const BASE = "https://queue.fal.run";
  const fetch: FalFetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const json = (v: unknown) =>
      new Response(JSON.stringify(v), {
        headers: { "content-type": "application/json" },
      });
    if (init.method === "POST") {
      return json({
        request_id: "r1",
        status_url: `${BASE}/fal-ai/birefnet/requests/r1/status`,
        response_url: `${BASE}/fal-ai/birefnet/requests/r1`,
      });
    }
    if (url.endsWith("/status")) return json({ status: "COMPLETED" });
    if (url.endsWith("/requests/r1")) {
      return json({
        video: {
          url: "https://v3.fal.media/files/x/out.webm",
          content_type: "video/webm",
        },
      });
    }
    return new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 9]), { status: 200 });
  };
  return {
    remover: new FalBirefnetBackgroundRemoval({
      baseUrl: BASE,
      endpoint: "fal-ai/birefnet/v2/video",
      apiKey: "fal-test-key",
      fetch,
      sleep: async () => {},
    }),
    calls,
  };
}

function fakeTagger(): ClipTagger {
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { messages: { content: unknown }[] };
    const parts = body.messages[1]?.content as { type: string }[];
    const images = parts.filter((p) => p.type === "image_url").length;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "```json\n" +
                JSON.stringify({
                  emotion: "smug",
                  situation: `saw ${images} frames`,
                  people: 0,
                  tags: ["Test", "bars"],
                }) +
                "\n```",
            },
          },
        ],
      }),
    );
  };
  return new OpenAiVisionTagger({
    endpoint: "http://vision.test/v1/chat/completions",
    apiKey: "",
    model: "vision-test",
    systemPrompt: CLIP_TAGGING_SYSTEM_PROMPT,
    userPrompt: CLIP_TAGGING_USER_PROMPT,
    parse: (text) => parseClipTags(extractJsonObject(text)),
    fetch,
  });
}

let storage: MemoryStorage;
let queue: RecordingQueue;

beforeEach(() => {
  storage = new MemoryStorage(new FixedClock());
  queue = new RecordingQueue();
});

function handler(
  opts: { fal?: BackgroundRemoval | null; tagger?: ClipTagger | null } = {},
) {
  return createMediaImportHandler({
    db: handle.db,
    storage,
    queue: queue as unknown as Queue,
    clock: new FixedClock(),
    appRole: APP_ROLE,
    logger: silencioso,
    downloader: downloader(),
    inspector,
    chroma: new ChromaKeyBackgroundRemoval({ inspector, verdict: greenScreenVerdict }),
    backgroundRemoval: async () => opts.fal ?? null,
    tagger: async () => opts.tagger ?? null,
    tempRoot,
  });
}

function job(companyId: string, over: Partial<MediaImportJob> = {}): MediaImportJob {
  return {
    companyId,
    importId: randomUUID(),
    mediaId: randomUUID(),
    url: "https://videos.example.com/watch?v=abc",
    kind: "video",
    categories: [],
    ...over,
  };
}

const ctx = (payload: unknown, attempt = 1, maxAttempts = 2): JobContext<unknown> => ({
  jobId: `media-import#${randomUUID()}`,
  payload,
  attempt,
  maxAttempts,
});

async function statusOf(
  companyId: string,
  importId: string,
): Promise<Record<string, unknown>> {
  const stream = await storage.get(importStatusKey(companyId, importId));
  const chunks: Uint8Array[] = [];
  for await (const c of stream) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

interface Fila {
  media_id: string;
  status: string;
  origin: string;
  categories: string[];
  storage_key: string;
  filename: string;
  video_duration_sec: number | null;
}

async function filas(companyId: string): Promise<Fila[]> {
  return (await handle.sql`
    select media_id::text, status::text, origin::text, categories, storage_key, filename,
           video_duration_sec
      from media where company_id = ${companyId}::uuid order by created_at
  `) as unknown as Fila[];
}

const tempVacio = (): boolean => readdirSync(tempRoot).length === 0;

describe("media-import — PU-MEME-001", () => {
  it("clip verde: fila processing + green-screen-video, normalización encolada en la tx, y ready al normalizar", async () => {
    const companyId = await seedCompany(handle);
    guion({ info: { duration: 2, title: "Chroma meme #1 😂" }, source: CHROMA });
    const j = job(companyId, { categories: ["hook-video"] });

    await handler()(ctx(j));

    const rows = await filas(companyId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      media_id: j.mediaId,
      status: "processing",
      origin: "manual_upload",
      categories: ["hook-video", "green-screen-video"],
      filename: "Chroma meme 1.mp4",
      video_duration_sec: 2,
    });
    expect(row?.storage_key.startsWith(`media/${companyId}/imports/${j.mediaId}/`)).toBe(
      true,
    );
    expect(await storage.head(row?.storage_key ?? "")).not.toBeNull();

    // Normalización encolada, dentro de la transacción de la fila.
    expect(queue.specs).toHaveLength(1);
    expect(queue.specs[0]).toMatchObject({
      queue: JOB_QUEUES.mediaNormalization,
      payload: { companyId, mediaId: j.mediaId },
    });
    expect(queue.specs[0]?.options?.transaction).toBeDefined();

    const status = await statusOf(companyId, j.importId);
    expect(status).toMatchObject({
      state: "imported",
      mediaId: j.mediaId,
      background: "green_screen",
      tagging: "skipped",
      sourceUrl: j.url,
    });
    expect(tempVacio()).toBe(true);

    // yt-dlp: sin config de usuario, la URL detrás de `--`.
    const [probe] = llamadas();
    expect(probe).toContain("--no-config");
    expect(probe?.slice(-2)).toEqual(["--", j.url]);

    // Y la normalización de siempre la saca de `processing`.
    await createMediaNormalizationHandler({
      db: handle.db,
      renderer: new FakeRenderer(),
      storage,
      clock: new FixedClock(),
      appRole: APP_ROLE,
      logger: silencioso,
    })(ctx({ companyId, mediaId: j.mediaId }, 1, 3));
    expect((await filas(companyId))[0]?.status).toBe("ready");
  });

  it("no verde pedido como foreground, sin fal: pierde green-screen-video y queda needs_background_removal", async () => {
    const companyId = await seedCompany(handle);
    guion({ info: { duration: 2 }, source: BARS });
    const j = job(companyId, { categories: ["green-screen-video"] });

    await handler({ fal: null })(ctx(j));

    const rows = await filas(companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.categories).toEqual([]);
    expect(await statusOf(companyId, j.importId)).toMatchObject({
      state: "imported",
      background: "needs_background_removal",
    });
    expect(tempVacio()).toBe(true);
  });

  it("con fal y visión: segunda fila con alfa (webm, ready, green-screen-video) y etiquetas en estado y metadata", async () => {
    const companyId = await seedCompany(handle);
    guion({ info: { duration: 2, title: "Bars" }, source: BARS });
    const fal = fakeFal();
    const j = job(companyId, { categories: ["green-screen-video"] });

    await handler({ fal: fal.remover, tagger: fakeTagger() })(ctx(j));

    const rows = await filas(companyId);
    expect(rows).toHaveLength(2);
    const cut = rows.find((r) => r.media_id !== j.mediaId);
    expect(cut).toMatchObject({
      status: "ready",
      categories: ["green-screen-video"],
      filename: "Bars cutout.webm",
    });
    expect(cut?.storage_key.endsWith(".webm")).toBe(true);
    // Sólo el original pasa por la normalización: el recorte perdería el alfa.
    expect(queue.specs).toHaveLength(1);

    const status = await statusOf(companyId, j.importId);
    expect(status).toMatchObject({
      background: "removed",
      cutoutMediaId: cut?.media_id,
      tagging: "tagged",
      tags: {
        emotion: "smug",
        situation: "saw 3 frames",
        people: 0,
        tags: ["test", "bars"],
      },
    });
    const meta = await storage.get(mediaMetaKey(companyId, j.mediaId));
    const chunks: Uint8Array[] = [];
    for await (const c of meta) chunks.push(c);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toMatchObject({
      sourceUrl: j.url,
      cutoutMediaId: cut?.media_id,
    });
    // La descarga del resultado de fal no lleva la key (lo cubre el test del adaptador);
    // acá: se llamó a la cola de fal y se bajó el resultado.
    expect(fal.calls[0]).toBe("POST https://queue.fal.run/fal-ai/birefnet/v2/video");
    expect(tempVacio()).toBe(true);
  });

  it("URL no soportada: failed/unsupported_url, sin filas, y el stderr no se filtra", async () => {
    const companyId = await seedCompany(handle);
    guion({ mode: "unsupported" });
    const j = job(companyId);

    await handler()(ctx(j));

    expect(await filas(companyId)).toHaveLength(0);
    const status = await statusOf(companyId, j.importId);
    expect(status).toMatchObject({ state: "failed", error: "unsupported_url" });
    expect(JSON.stringify(status)).not.toContain("secreto");
    expect(tempVacio()).toBe(true);
  });

  it("demasiado largo: failed/too_long sin bajar", async () => {
    const companyId = await seedCompany(handle);
    guion({ info: { duration: 999 }, source: GREEN });
    const j = job(companyId);

    await handler()(ctx(j));

    expect(await statusOf(companyId, j.importId)).toMatchObject({
      state: "failed",
      error: "too_long",
    });
    expect(llamadas()).toHaveLength(1);
    expect(await filas(companyId)).toHaveLength(0);
    expect(tempVacio()).toBe(true);
  });

  it("el sitio no declara duración y el archivo dura de más: too_long medido por FFmpeg", async () => {
    const companyId = await seedCompany(handle);
    guion({ info: {}, source: GREEN });
    const j = job(companyId);
    await createMediaImportHandler({
      db: handle.db,
      storage,
      queue: queue as unknown as Queue,
      clock: new FixedClock(),
      appRole: APP_ROLE,
      logger: silencioso,
      downloader: downloader(),
      inspector,
      chroma: new ChromaKeyBackgroundRemoval({ inspector, verdict: greenScreenVerdict }),
      backgroundRemoval: async () => null,
      tagger: async () => null,
      tempRoot,
      maxDurationSeconds: 0.5,
    })(ctx(j));
    expect(await statusOf(companyId, j.importId)).toMatchObject({ error: "too_long" });
    expect(await filas(companyId)).toHaveLength(0);
    expect(tempVacio()).toBe(true);
  });

  it("un reintento tardío de un import terminado no vuelve a bajar ni duplica", async () => {
    const companyId = await seedCompany(handle);
    guion({ info: { duration: 2 }, source: GREEN });
    const j = job(companyId);
    const h = handler();
    await h(ctx(j));
    const antes = llamadas().length;
    await h(ctx(j, 2));
    expect(llamadas().length).toBe(antes);
    expect(await filas(companyId)).toHaveLength(1);
  });

  it("audio: va a la biblioteca de audio de la marca, con fila (sprint 7)", async () => {
    const companyId = await seedCompany(handle);
    const m4a = path.join(clips, "a.m4a");
    execFileSync("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=f=330:d=2",
      "-c:a",
      "aac",
      m4a,
    ]);
    guion({ info: { duration: 2 }, source: m4a, ext: "m4a" });
    const j = job(companyId, { kind: "audio" });

    await handler()(ctx(j));

    // Nada en `media` (DATA-010 no tiene tipo audio)…
    expect(await filas(companyId)).toHaveLength(0);
    const status = await statusOf(companyId, j.importId);
    expect(status).toMatchObject({ state: "imported" });
    // …y el objeto bajo `audio/{companyId}/`, el prefijo que el build autoriza.
    expect(decodeURIComponent(String(status["audioUrl"]))).toContain(
      `audio/${companyId}/imports/${j.importId}.m4a`,
    );
    const pistas = async () =>
      (await handle.sql`
        select origin, url, storage_key, import_id::text, source_url, duration_sec,
               content_type, auto_use
          from brand_audio_tracks where company_id = ${companyId}::uuid
      `) as unknown as Record<string, unknown>[];
    const [pista] = await pistas();
    expect(pista).toMatchObject({
      origin: "import",
      url: status["audioUrl"],
      import_id: j.importId,
      source_url: j.url,
      content_type: "audio/mp4",
      auto_use: true,
    });
    expect(Number(pista?.["duration_sec"])).toBeGreaterThan(1.5);

    // Un reintento tardío (el estado ya es terminal) no duplica la fila.
    await handler()(ctx(j, 2));
    expect(await pistas()).toHaveLength(1);
  });
});

describe("calibración del umbral de verde (FFmpeg real)", () => {
  it("0x00FF00 y 0x00B140 son verdes; testsrc2 no", async () => {
    const share = async (file: string) =>
      greenScreenVerdict(await inspector.borderSamples(file, 5));
    const green = await share(GREEN);
    const chroma = await share(CHROMA);
    const bars = await share(BARS);
    expect(green.isGreen).toBe(true);
    expect(chroma.isGreen).toBe(true);
    expect(bars.isGreen).toBe(false);
    // Los números que calibran `GREEN_SCREEN_MIN_SHARE` (0,6), a la vista.
    console.info(
      `[calibración] verde=${green.share.toFixed(2)} croma=${chroma.share.toFixed(2)} testsrc2=${bars.share.toFixed(2)}`,
    );
  });
});
