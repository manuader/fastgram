/**
 * `PU-MEDIA-002` — `POST /brand-backgrounds` contra sharp y FFmpeg de verdad,
 * por la superficie HTTP.
 *
 * Lo que se mide:
 *  · dimensiones y formato reales (sharp lee el JPEG, ffprobe el MP4);
 *  · el video: H.264, yuv420p, 1080×1920, la duración pedida, **sin** audio,
 *    y el `moov` delante (faststart), que es lo que lo deja servir como
 *    `background-video` de un wall-of-text sin normalizar;
 *  · determinismo: dos servicios con caches distintas —o sea, dos renders de
 *    verdad— dan los mismos bytes para la misma `(paleta, semilla)`;
 *  · el golden por hash, grabado por huella de entorno como el de frames
 *    (`golden.test.ts`): entre máquinas distintas no se compara nada;
 *  · el golden de plan del loop (argv), portable entre máquinas;
 *  · la autorización: con `requireGrant`, sin grant no se trabaja.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileCacheStore } from "../cache/store.js";
import { probeCapabilities } from "../ffmpeg/capabilities.js";
import { readTopLevelAtoms } from "../ffmpeg/faststart.js";
import { probeMedia } from "../ffmpeg/probe.js";
import { planBackground } from "../domain/brandBackground.js";
import { buildServer } from "../http/server.js";
import { parseArtifactName } from "../http/artifacts.js";
import { signGrantBody, type MediaPolicyConfig } from "../media/urlPolicy.js";
import { noiseSeedOf, planBackgroundVideo } from "./brandBackground.js";
import { engineVersion } from "./engineVersion.js";

const caps = await probeCapabilities();
const suite = caps.available ? describe : describe.skip;

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__goldens__");
const PALETTE = ["#1B1F3B", "#FF6B6B", "#FFD93D", "#6BCB77"];
const SECRET = "s".repeat(40);

let workDir = "";
let counter = 0;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "fastgram-brand-bg-it-"));
});

afterAll(async () => {
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

function server(policy: Partial<MediaPolicyConfig> = {}) {
  counter += 1;
  return buildServer({
    logger: false,
    engine: {
      cache: new FileCacheStore(path.join(workDir, `cache-${String(counter)}`)),
      policy: {
        mediaPrefixes: [],
        sharedPrefixes: [],
        grantSecret: null,
        requireGrant: false,
        now: Date.now,
        ...policy,
      },
      fonts: { fontDir: null, strict: false },
      resolveMedia: () => Promise.reject(new Error("este endpoint no lee media")),
      normalizeInputs: true,
      allowUntonemappedHdr: false,
    },
  });
}

type App = ReturnType<typeof server>;

interface Generated {
  readonly body: Record<string, unknown>;
  readonly bytes: Buffer;
  readonly file: string;
}

async function generate(app: App, payload: Record<string, unknown>): Promise<Generated> {
  const response = await app.inject({
    method: "POST",
    url: "/brand-backgrounds",
    payload,
  });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json() as Record<string, unknown>;
  const href = body["href"];
  expect(typeof href).toBe("string");
  expect(body).not.toHaveProperty("cacheKey");

  const artifact = await app.inject({ method: "GET", url: href as string });
  expect(artifact.statusCode).toBe(200);
  const bytes = artifact.rawPayload;
  expect(bytes.byteLength).toBe(body["sizeBytes"]);

  const ref = parseArtifactName((href as string).replace(/^\/artifact\//, ""));
  const file = path.join(
    workDir,
    `out-${String((counter += 1))}.${ref?.extension ?? "bin"}`,
  );
  await writeFile(file, bytes);
  return { body, bytes, file };
}

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

suite("POST /brand-backgrounds — imágenes", () => {
  it("4:5 → JPEG 1080×1350", async () => {
    const out = await generate(server(), {
      palette: PALETTE,
      seed: "img-45",
      kind: "image",
      aspectRatio: "4:5",
    });
    expect(out.body["contentType"]).toBe("image/jpeg");
    expect(out.body["width"]).toBe(1080);
    expect(out.body["height"]).toBe(1350);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
  });

  it("9:16 → JPEG 1080×1920, y no es un color plano", async () => {
    const out = await generate(server(), {
      palette: PALETTE,
      seed: "img-916",
      kind: "image",
    });
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
    // Un fondo liso pasaría las dimensiones y no sería un fondo de marca.
    const stats = await sharp(out.bytes).stats();
    const spread = stats.channels.map((c) => c.max - c.min);
    expect(Math.max(...spread)).toBeGreaterThan(60);
  });

  it("determinista: dos renders reales (caches distintas) dan los mismos bytes", async () => {
    const payload = { palette: PALETTE, seed: "det", kind: "image" };
    const a = await generate(server(), payload);
    const b = await generate(server(), payload);
    expect(a.body["cache"]).toBe("miss");
    expect(b.body["cache"]).toBe("miss");
    expect(sha256(a.bytes)).toBe(sha256(b.bytes));

    const other = await generate(server(), { ...payload, seed: "det-2" });
    expect(sha256(other.bytes)).not.toBe(sha256(a.bytes));
  });

  it("el segundo pedido igual sale de la cache", async () => {
    const app = server();
    const payload = { palette: PALETTE, seed: "hit", kind: "image" };
    const first = await generate(app, payload);
    const second = await generate(app, payload);
    expect(first.body["cache"]).toBe("miss");
    expect(second.body["cache"]).toBe("hit");
    expect(sha256(second.bytes)).toBe(sha256(first.bytes));
  });
});

suite("POST /brand-backgrounds — video en loop", () => {
  let video: Generated;

  beforeAll(async () => {
    video = await generate(server(), {
      palette: PALETTE,
      seed: "loop",
      kind: "video",
      durationSeconds: 6,
    });
  }, 120_000);

  it("H.264 yuv420p 1080×1920, 6 s, sin audio", async () => {
    expect(video.body["contentType"]).toBe("video/mp4");
    const info = await probeMedia(video.file);
    expect(info.videoCodec).toBe("h264");
    expect(info.pixelFormat).toBe("yuv420p");
    expect([info.width, info.height]).toEqual([1080, 1920]);
    expect(info.hasAudio).toBe(false);
    expect(info.durationSeconds).toBeCloseTo(6, 1);
    expect(video.body["durationSeconds"]).toBeCloseTo(6, 1);
  });

  it("faststart: `moov` antes que `mdat`", async () => {
    const atoms = await readTopLevelAtoms(video.file);
    expect(atoms.indexOf("moov")).toBeGreaterThanOrEqual(0);
    expect(atoms.indexOf("moov")).toBeLessThan(atoms.indexOf("mdat"));
  });

  it("pesa lo razonable para un fondo (NFR-013: ≤ 50 MB)", () => {
    expect(video.bytes.byteLength).toBeLessThan(50 * 1024 * 1024);
    expect(video.bytes.byteLength).toBeGreaterThan(50 * 1024);
  });

  it("determinista: otro render real da los mismos bytes", async () => {
    const again = await generate(server(), {
      palette: PALETTE,
      seed: "loop",
      kind: "video",
      durationSeconds: 6,
    });
    expect(again.body["cache"]).toBe("miss");
    expect(sha256(again.bytes)).toBe(sha256(video.bytes));
  }, 120_000);
});

suite("POST /brand-backgrounds — golden por hash", () => {
  it("imagen y video coinciden con el golden de este entorno", async () => {
    const image = await generate(server(), {
      palette: PALETTE,
      seed: "golden",
      kind: "image",
      aspectRatio: "4:5",
    });
    const loop = await generate(server(), {
      palette: PALETTE,
      seed: "golden",
      kind: "video",
      durationSeconds: 6,
    });
    const actual = { image: sha256(image.bytes), video: sha256(loop.bytes) };

    // La huella: lo que decide los bytes. Otra versión de libvips o de FFmpeg
    // es otro archivo, no una regresión.
    const engine = await engineVersion(caps);
    const fingerprint = [
      `sharp${sharp.versions.sharp ?? "?"}`,
      `vips${sharp.versions.vips}`,
      `ffmpeg${engine.components.ffmpeg}`,
    ].join("-");
    const file = path.join(GOLDEN_DIR, `brand-backgrounds.${fingerprint}.json`);
    if (!existsSync(file)) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
      console.warn(`golden grabado por primera vez: ${path.basename(file)}`);
      return;
    }
    expect(actual).toEqual(JSON.parse(readFileSync(file, "utf8")) as unknown);
  }, 180_000);
});

describe("golden de plan del loop — portable entre máquinas", () => {
  it("el argv de FFmpeg para una semilla fija no cambia sin querer", () => {
    const spec = planBackground(PALETTE, "plan");
    const plan = planBackgroundVideo(
      spec,
      {
        basePath: "/w/base.png",
        vignettePath: "/w/vignette.png",
        blobs: spec.blobs.map((blob, i) => ({
          path: `/w/blob-${String(i)}.png`,
          left: 100 * i - 200,
          top: 150 * i - 300,
          blob,
        })),
      },
      { width: 1080, height: 1920 },
      8,
      "/w/out.mp4",
      noiseSeedOf("plan"),
    );
    expect(plan.frames).toBe(240);
    const file = path.join(GOLDEN_DIR, "brand-background-plan.json");
    const actual = { spec, args: plan.args };
    if (!existsSync(file)) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    expect(actual).toEqual(JSON.parse(readFileSync(file, "utf8")) as unknown);
  });
});

describe("POST /brand-backgrounds — validación y autorización", () => {
  const base = { palette: PALETTE, seed: "x", kind: "image" };

  async function status(
    app: App,
    payload: Record<string, unknown>,
  ): Promise<{ code: number; error: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/brand-backgrounds",
      payload,
    });
    const body = response.json() as { error?: { code: string } };
    return { code: response.statusCode, error: body.error?.code ?? "" };
  }

  it("400 con un solo color, con dos iguales, con más de cinco", async () => {
    const app = server();
    expect(await status(app, { ...base, palette: ["#FFFFFF"] })).toEqual({
      code: 400,
      error: "bad_request",
    });
    expect(await status(app, { ...base, palette: ["#FFFFFF", "#ffffff"] })).toEqual({
      code: 400,
      error: "bad_request",
    });
    expect(
      await status(app, {
        ...base,
        palette: ["#000001", "#000002", "#000003", "#000004", "#000005", "#000006"],
      }),
    ).toEqual({ code: 400, error: "bad_request" });
    expect(await status(app, { ...base, palette: ["red", "#000000"] })).toEqual({
      code: 400,
      error: "bad_request",
    });
  });

  it("400 con un video 4:5 o una imagen con duración", async () => {
    const app = server();
    expect(await status(app, { ...base, kind: "video", aspectRatio: "4:5" })).toEqual({
      code: 400,
      error: "bad_request",
    });
    expect(await status(app, { ...base, durationSeconds: 8 })).toEqual({
      code: 400,
      error: "bad_request",
    });
    expect(await status(app, { ...base, kind: "video", durationSeconds: 11 })).toEqual({
      code: 400,
      error: "bad_request",
    });
  });

  it("con requireGrant: sin grant no se genera; con uno firmado, sí", async () => {
    const app = server({ grantSecret: SECRET, requireGrant: true });
    // La negativa primero (trampa 35): si esto diera 200, lo de abajo no dice nada.
    expect(await status(app, base)).toEqual({ code: 400, error: "media_grant_invalid" });

    const body = {
      companyId: "ws-1",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      mediaPrefixes: [],
      sharedPrefixes: [],
    };
    const forged = { body, signature: "0".repeat(64) };
    expect(await status(app, { ...base, grant: forged })).toEqual({
      code: 400,
      error: "media_grant_invalid",
    });

    const grant = { body, signature: signGrantBody(body, SECRET) };
    const ok = await app.inject({
      method: "POST",
      url: "/brand-backgrounds",
      payload: { ...base, grant },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("un grant vencido tampoco", async () => {
    const app = server({ grantSecret: SECRET, requireGrant: true });
    const body = {
      companyId: "ws-1",
      issuedAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
      mediaPrefixes: [],
      sharedPrefixes: [],
    };
    const grant = { body, signature: signGrantBody(body, SECRET) };
    expect(await status(app, { ...base, grant })).toEqual({
      code: 400,
      error: "media_grant_invalid",
    });
  });
});
