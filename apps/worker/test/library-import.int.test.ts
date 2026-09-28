/**
 * `library-import` contra Postgres real — sprint 9 (agente N), `PU-S9-005/006`.
 *
 * Lo que se atraviesa de verdad: FFmpeg/ffprobe (clips generados acá), el
 * `FfmpegClipInspector`, el storage (memoria), las filas de `library_assets`
 * y el esquema del contrato. Lo doblado: el HTTP de la fuente (se sirve el
 * **JSON real grabado de Commons** y un clip generado para su URL de
 * `upload.wikimedia.org`) y el modelo de visión.
 *
 * Qué se mide:
 *  · subida manual (licencia `own`) → `ready`, JSON válido, croma medido,
 *    objeto bajo `library/{id}/`, la subida cruda borrada;
 *  · fuente (Commons, fixture real) → la licencia verificada por core viaja
 *    en la fila y en el JSON, y la bajada sólo va al host de la fuente;
 *  · sin modelo de visión → `ready` con lo medible y `needsReview`;
 *  · el modelo dice NSFW → `failed/nsfw_rejected`;
 *  · un host fuera de la lista → `failed/download_failed` sin pedirlo;
 *  · idempotencia: un segundo job sobre una fila `ready` no hace nada;
 *  · el temporal se borra siempre.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FfmpegClipInspector, FixedClock, MemoryStorage } from "@fastgram/adapters";
import { libraryAssetMetadataSchema, type LibraryLicense } from "@fastgram/contracts";
import {
  describeLibraryAsset,
  libraryKindsForFormat,
  parseWikimediaResponse,
  wikimediaFileUrl,
  type LibraryImportJob,
  type LibraryTagProposal,
} from "@fastgram/core";
import {
  libraryAssetRepository,
  libraryAssets,
  listLibraryCandidates,
  type DbHandle,
} from "@fastgram/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createLibraryImportRunner, type LibraryFetch } from "../src/library/handler.js";
import { createMediaTools } from "../src/library/media-tools.js";
import type { LibraryTagger } from "../src/library/tagger.js";
import { openDb } from "./helpers/fixtures.js";

const COMMONS_FIXTURE = fileURLToPath(
  new URL(
    "../../../packages/core/src/library/__fixtures__/wikimedia-file-scales.json",
    import.meta.url,
  ),
);

const silent: BuildLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let handle: DbHandle;
let work: string;
let greenClip: Buffer;
let plainClip: Buffer;
let tempRoot: string;

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

beforeAll(() => {
  handle = openDb();
  work = mkdtempSync(path.join(tmpdir(), "fastgram-library-int-"));
  tempRoot = mkdtempSync(path.join(tmpdir(), "fastgram-library-tmp-"));
  // Verde croma con un «sujeto» rojo en el centro que no toca el borde.
  const green = path.join(work, "green.webm");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x00B140:s=640x360:d=2,drawbox=x=240:y=80:w=160:h=200:color=red@1:t=fill",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "300k",
    green,
  ]);
  greenClip = readFileSync(green);
  const plain = path.join(work, "plain.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=1080x1920:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    plain,
  ]);
  plainClip = readFileSync(plain);
}, 120_000);

afterAll(async () => {
  await handle?.close();
  rmSync(work, { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(libraryAssets);
});

const tools = createMediaTools({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
const inspector = new FfmpegClipInspector({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });

function stubTagger(proposal: LibraryTagProposal): () => Promise<LibraryTagger> {
  return async () => ({ model: "stub-vision", tag: async () => proposal });
}

const proposal: LibraryTagProposal = {
  description: "A red block stands still in front of a green screen.",
  memeType: "overlay_effect",
  emotions: ["neutral"],
  useCases: ["when you need a placeholder"],
  characters: ["red block"],
  tags: ["block", "red"],
  framing: "object",
  energy: "low",
  nsfw: false,
};

function runnerWith(
  storage: MemoryStorage,
  opts: {
    tagger?: () => Promise<LibraryTagger | null>;
    fetch?: LibraryFetch;
    bytesPerSecond?: { wikimedia?: number };
  } = {},
) {
  return createLibraryImportRunner({
    db: handle.db,
    storage,
    clock: new FixedClock("2026-09-28T12:00:00.000Z"),
    logger: silent,
    tools,
    inspector,
    tagger: opts.tagger ?? (async () => null),
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    ...(opts.bytesPerSecond === undefined ? {} : { bytesPerSecond: opts.bytesPerSecond }),
    tempRoot,
  });
}

const RUN = { jobId: "job-1", attempt: 1, maxAttempts: 2 };

async function seedRow(values: {
  title: string;
  license: LibraryLicense;
  provider: string;
  mediaType?: string;
}) {
  const row = await libraryAssetRepository.create(handle.db, {
    title: values.title,
    kind: "background_video",
    mediaType: values.mediaType ?? "video",
    status: "processing",
    provider: values.provider,
    license: values.license,
    licenseType: values.license.type,
    licenseSourceUrl: values.license.sourceUrl ?? null,
    searchText: values.title,
  });
  if (row === null) throw new Error("no se creó la fila");
  return row;
}

describe("library-import", () => {
  it("subida manual: ready, JSON válido, croma medido y la subida cruda borrada", async () => {
    const storage = new MemoryStorage(new FixedClock("2026-09-28T12:00:00.000Z"));
    const row = await seedRow({
      title: "Red block",
      license: { type: "own", verifiedAt: "2026-09-28T12:00:00.000Z" },
      provider: "upload",
    });
    const uploadKey = `library/uploads/${randomUUID()}`;
    await storage.put({ key: uploadKey, body: greenClip, contentType: "video/webm" });
    const job: LibraryImportJob = {
      assetId: row.id,
      origin: { kind: "upload", storageKey: uploadKey, contentType: "video/webm" },
    };

    const out = await runnerWith(storage, { tagger: stubTagger(proposal) })(job, RUN);

    expect(out.kind).toBe("ready");
    const saved = await libraryAssetRepository.findById(handle.db, row.id);
    expect(saved?.status).toBe("ready");
    expect(saved?.kind).toBe("green_screen_video");
    expect(saved?.storageKey).toBe(`library/${row.id}/asset.mp4`);
    expect(saved?.previewKey).toBe(`library/${row.id}/preview.jpg`);
    expect(saved?.contentType).toBe("video/mp4");
    const meta = libraryAssetMetadataSchema.parse(saved?.metadata);
    expect(meta.chroma.type).toBe("green");
    expect(meta.chroma.keyQuality).toBeGreaterThanOrEqual(0.9);
    expect(meta.durationSec).toBeCloseTo(2, 0);
    expect(meta.aspect).toEqual({ ratio: "16:9", width: 640, height: 360 });
    // Lo propuesto por el modelo, acotado; lo medido por el código.
    expect(meta.description).toBe(proposal.description);
    expect(meta.memeType).toBe("overlay_effect");
    expect(meta.hasSpeech).toBe(false);
    expect(meta.needsReview).toBe(false);
    expect(saved?.searchText).toContain("placeholder");
    expect(await storage.head(uploadKey)).toBeNull();
    expect(await storage.head(`library/${row.id}/asset.mp4`)).not.toBeNull();
    expect(readdirSync(tempRoot)).toEqual([]);

    // Lo que consume el decisor (O): candidatos filtrados en SQL y su texto.
    const candidates = await listLibraryCandidates(handle.db, {
      kinds: libraryKindsForFormat("video"),
      maxDurationSec: 5,
      aspect: "16:9",
      text: "placeholder",
    });
    expect(candidates.map((c) => c.id)).toEqual([row.id]);
    expect(
      await listLibraryCandidates(handle.db, { kinds: ["image"], text: "placeholder" }),
    ).toEqual([]);
    const text = describeLibraryAsset(meta, saved?.title);
    expect(text).toContain("green screen video: Red block");
    expect(text).toMatch(/green key \(clean border (9\d|100)%\)/);

    // Idempotente: la fila ya no está `processing`.
    const again = await runnerWith(storage)(job, RUN);
    expect(again).toEqual({ kind: "skipped", why: "status_ready" });
  });

  it("fuente (Commons, JSON real grabado): la licencia verificada viaja al JSON", async () => {
    const page = parseWikimediaResponse(
      JSON.parse(readFileSync(COMMONS_FIXTURE, "utf8")) as unknown,
      "2026-09-28T12:00:00.000Z",
    );
    const candidate = page.candidates[0];
    if (candidate?.license == null)
      throw new Error("el fixture no trae licencia verificable");
    expect(wikimediaFileUrl(candidate.externalId)).toContain("titles=File%3AScales");
    const row = await seedRow({
      title: candidate.title,
      license: candidate.license as LibraryLicense,
      provider: "wikimedia",
    });
    const asked: string[] = [];
    const fetchClip: LibraryFetch = async (url) => {
      asked.push(url);
      return new Response(new Uint8Array(greenClip), {
        status: 200,
        headers: {
          "content-type": "video/webm",
          "content-length": String(greenClip.length),
        },
      });
    };
    const storage = new MemoryStorage(new FixedClock("2026-09-28T12:00:00.000Z"));
    const out = await runnerWith(storage, { fetch: fetchClip })(
      {
        assetId: row.id,
        origin: {
          kind: "remote",
          source: "wikimedia",
          downloadUrl: candidate.downloadUrl,
          mime: candidate.mime,
        },
      },
      RUN,
    );

    expect(out.kind).toBe("ready");
    expect(asked).toEqual([candidate.downloadUrl]);
    const saved = await libraryAssetRepository.findById(handle.db, row.id);
    const meta = libraryAssetMetadataSchema.parse(saved?.metadata);
    expect(meta.license.type).toBe("cc-by");
    expect(meta.license.attribution).toMatch(/via Wikimedia Commons$/);
    expect(meta.license.sourceUrl).toBe(candidate.pageUrl);
    // Sin modelo de visión: lo medible, descripción vacía y a revisar.
    expect(meta.description).toBe("");
    expect(meta.needsReview).toBe(true);
    expect(meta.tags).toEqual(expect.arrayContaining(["scales", "symbol", "law"]));
    expect(meta.chroma.type).toBe("green");
  });

  it("sin croma, un video queda como fondo y el 9:16 se mide", async () => {
    const storage = new MemoryStorage(new FixedClock("2026-09-28T12:00:00.000Z"));
    const row = await seedRow({
      title: "Test pattern",
      license: { type: "generated", verifiedAt: "2026-09-28T12:00:00.000Z" },
      provider: "upload",
    });
    const uploadKey = `library/uploads/${randomUUID()}.mp4`;
    await storage.put({ key: uploadKey, body: plainClip, contentType: "video/mp4" });
    await runnerWith(storage)(
      {
        assetId: row.id,
        origin: { kind: "upload", storageKey: uploadKey, contentType: "video/mp4" },
        kindHint: "green_screen_video",
      },
      RUN,
    );
    const saved = await libraryAssetRepository.findById(handle.db, row.id);
    const meta = libraryAssetMetadataSchema.parse(saved?.metadata);
    // La pista pedía green screen, pero no hay croma medido: no se sostiene.
    expect(saved?.kind).toBe("background_video");
    expect(meta.chroma.type).toBe("none");
    expect(meta.aspect.ratio).toBe("9:16");
    expect(meta.memeType).toBe("background");
  });

  it("NSFW según el modelo → failed/nsfw_rejected, sin objeto", async () => {
    const storage = new MemoryStorage(new FixedClock("2026-09-28T12:00:00.000Z"));
    const row = await seedRow({
      title: "x",
      license: { type: "own", verifiedAt: "2026-09-28T12:00:00.000Z" },
      provider: "upload",
    });
    const uploadKey = `library/uploads/${randomUUID()}`;
    await storage.put({ key: uploadKey, body: greenClip, contentType: "video/webm" });
    const out = await runnerWith(storage, {
      tagger: stubTagger({ ...proposal, nsfw: true }),
    })(
      {
        assetId: row.id,
        origin: { kind: "upload", storageKey: uploadKey, contentType: "video/webm" },
      },
      RUN,
    );
    expect(out).toEqual({ kind: "failed", code: "nsfw_rejected" });
    const saved = await libraryAssetRepository.findById(handle.db, row.id);
    expect(saved?.status).toBe("failed");
    expect(saved?.failureCode).toBe("nsfw_rejected");
    expect(await storage.head(`library/${row.id}/asset.mp4`)).toBeNull();
  });

  it("un host que no es de la fuente no se pide", async () => {
    const storage = new MemoryStorage(new FixedClock("2026-09-28T12:00:00.000Z"));
    const row = await seedRow({
      title: "y",
      license: {
        type: "cc0",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Y.webm",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        verifiedAt: "2026-09-28T12:00:00.000Z",
      },
      provider: "wikimedia",
    });
    let called = false;
    const out = await runnerWith(storage, {
      fetch: async () => {
        called = true;
        return new Response("x");
      },
    })(
      {
        assetId: row.id,
        origin: {
          kind: "remote",
          source: "wikimedia",
          downloadUrl: "https://evil.example/y.webm",
          mime: null,
        },
      },
      RUN,
    );
    expect(called).toBe(false);
    expect(out).toEqual({ kind: "failed", code: "download_failed" });
  });
  it("un 429 de la fuente no se reintenta: source_rate_limited", async () => {
    const storage = new MemoryStorage(new FixedClock("2026-09-28T12:00:00.000Z"));
    const row = await seedRow({
      title: "z",
      license: {
        type: "cc0",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Z.webm",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        verifiedAt: "2026-09-28T12:00:00.000Z",
      },
      provider: "wikimedia",
    });
    let calls = 0;
    const out = await runnerWith(storage, {
      fetch: async () => {
        calls += 1;
        return new Response("Too many requests", {
          status: 429,
          headers: { "retry-after": "600" },
        });
      },
    })(
      {
        assetId: row.id,
        origin: {
          kind: "remote",
          source: "wikimedia",
          downloadUrl: "https://upload.wikimedia.org/z.webm",
          mime: "video/webm",
        },
      },
      { jobId: "j", attempt: 1, maxAttempts: 2 },
    );
    expect(out).toEqual({ kind: "failed", code: "source_rate_limited" });
    expect(calls).toBe(1);
  });

  it("la bajada de Commons respeta el tope de ancho de banda", async () => {
    const storage = new MemoryStorage(new FixedClock("2026-09-28T12:00:00.000Z"));
    const row = await seedRow({
      title: "w",
      license: {
        type: "cc0",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:W.webm",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        verifiedAt: "2026-09-28T12:00:00.000Z",
      },
      provider: "wikimedia",
    });
    // Medio segundo de tope para el clip entero, servido en pedazos.
    const rate = Math.ceil(greenClip.length * 2);
    const started = Date.now();
    const out = await runnerWith(storage, {
      bytesPerSecond: { wikimedia: rate },
      fetch: async () => {
        const chunks = [0, 1, 2, 3].map((i) =>
          greenClip.subarray(
            Math.floor((i * greenClip.length) / 4),
            Math.floor(((i + 1) * greenClip.length) / 4),
          ),
        );
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const c of chunks) controller.enqueue(new Uint8Array(c));
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      },
    })(
      {
        assetId: row.id,
        origin: {
          kind: "remote",
          source: "wikimedia",
          downloadUrl: "https://upload.wikimedia.org/w.webm",
          mime: "video/webm",
        },
      },
      RUN,
    );
    expect(out.kind).toBe("ready");
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });
  it("alfa declarado pero opaco → se trata como verde; alfa real → keyQuality del borde transparente", async () => {
    const opaque = path.join(work, "opaque-alpha.webm");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=0x00B140:s=320x240:d=1,format=yuva420p",
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-auto-alt-ref",
      "0",
      opaque,
    ]);
    const real = path.join(work, "real-alpha.webm");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=black@0.0:s=320x240:d=1,format=yuva420p,drawbox=x=100:y=60:w=120:h=120:color=red@1:t=fill",
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-auto-alt-ref",
      "0",
      real,
    ]);
    const storage = new MemoryStorage(new FixedClock("2026-09-28T12:00:00.000Z"));
    const results: Record<string, unknown>[] = [];
    for (const file of [opaque, real]) {
      const row = await seedRow({
        title: path.basename(file),
        license: { type: "own", verifiedAt: "2026-09-28T12:00:00.000Z" },
        provider: "upload",
      });
      const key = `library/uploads/${randomUUID()}.webm`;
      await storage.put({ key, body: readFileSync(file), contentType: "video/webm" });
      await runnerWith(storage)(
        {
          assetId: row.id,
          origin: { kind: "upload", storageKey: key, contentType: "video/webm" },
        },
        RUN,
      );
      const saved = await libraryAssetRepository.findById(handle.db, row.id);
      const meta = libraryAssetMetadataSchema.parse(saved?.metadata);
      results.push({
        contentType: saved?.contentType,
        chroma: meta.chroma.type,
        q: meta.chroma.keyQuality,
      });
    }
    expect(results[0]).toMatchObject({ contentType: "video/mp4", chroma: "green" });
    expect(results[1]).toMatchObject({
      contentType: "video/webm",
      chroma: "alpha",
      q: 1,
    });
  });
});
