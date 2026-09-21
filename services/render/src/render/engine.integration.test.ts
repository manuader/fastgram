/**
 * Integración real: se generan medios sintéticos con lavfi y se corre el motor
 * entero contra el ffmpeg de la máquina. No hay mocks de ffmpeg.
 *
 * Lo que este test prueba y los unitarios no pueden:
 *  · que el filtergraph de cada formato de verdad compila y encodea;
 *  · que la salida NO está vacía (la trampa del código 0 sin archivo);
 *  · que el corte de cache ahorra el re-encode cuando sólo cambió el texto.
 *
 * Si no hay ffmpeg, el bloque se saltea en vez de fallar: es un test de
 * integración, no de unidad.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileCacheStore } from "../cache/store.js";
import { probeCapabilities, FFMPEG_BIN } from "../ffmpeg/capabilities.js";
import { probeMedia } from "../ffmpeg/probe.js";
import { parsePrefixList, type MediaPolicyConfig } from "../media/urlPolicy.js";
import { renderBuild, type RenderEngineConfig } from "./engine.js";

const execFileAsync = promisify(execFile);
const caps = await probeCapabilities();
const suite = caps.available ? describe : describe.skip;

const MEDIA_PREFIX = "https://cdn.test.local/media/ws-1/";
const LIBRARY_PREFIX = "https://library.test.local/audio/";

let workDir = "";
const files = new Map<string, string>();

async function lavfi(args: string[], output: string): Promise<void> {
  await execFileAsync(FFMPEG_BIN, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...args,
    output,
  ]);
}

beforeAll(async () => {
  if (!caps.available) return;
  workDir = await mkdtemp(path.join(tmpdir(), "fastgram-render-it-"));

  const video = path.join(workDir, "video.mp4");
  await lavfi(
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=30:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
    ],
    video,
  );

  const chroma = path.join(workDir, "chroma.mp4");
  await lavfi(
    [
      "-f",
      "lavfi",
      "-i",
      "smptebars=size=480x360:rate=30:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
    ],
    chroma,
  );

  const demo = path.join(workDir, "demo.mp4");
  await lavfi(
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=360x640:rate=30:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
    ],
    demo,
  );

  const audio = path.join(workDir, "audio.m4a");
  await lavfi(
    ["-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-c:a", "aac"],
    audio,
  );

  const image = path.join(workDir, "bg.png");
  await writeFile(
    image,
    await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: { r: 20, g: 40, b: 80 },
      },
    })
      .png()
      .toBuffer(),
  );

  files.set(`${MEDIA_PREFIX}video.mp4`, video);
  files.set(`${MEDIA_PREFIX}chroma.mp4`, chroma);
  files.set(`${MEDIA_PREFIX}demo.mp4`, demo);
  files.set(`${MEDIA_PREFIX}bg.png`, image);
  files.set(`${LIBRARY_PREFIX}track.m4a`, audio);
}, 120_000);

afterAll(async () => {
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

function policy(): MediaPolicyConfig {
  return {
    mediaPrefixes: parsePrefixList(MEDIA_PREFIX),
    sharedPrefixes: parsePrefixList(LIBRARY_PREFIX),
    grantSecret: null,
    requireGrant: false,
    now: Date.now,
  };
}

function engineConfig(cacheDir: string): RenderEngineConfig {
  return {
    cache: new FileCacheStore(cacheDir),
    policy: policy(),
    fonts: { fontDir: null, strict: false },
    resolveMedia: async (url) => {
      const local = files.get(url);
      if (local === undefined) throw new Error(`url no mapeada en el test: ${url}`);
      return local;
    },
    // La normalización se ejercita en su propio test; acá los inputs ya son MP4.
    normalizeInputs: false,
    allowUntonemappedHdr: false,
  };
}

const CANVAS = { width: 540, height: 960 };

function textBox(content: string) {
  return {
    id: "t1",
    text: content,
    position: { x: 50, y: 25 },
    widthPercent: 80,
    align: "center",
    font: { family: "inter", weight: 700, size: 28 },
    color: "#FFFFFF",
    stroke: { width: 3, color: "#000000" },
    background: null,
  };
}

suite("motor de render contra ffmpeg real", () => {
  it("wall-of-text produce un MP4 no vacío del tamaño del canvas y con audio", async () => {
    const cacheDir = path.join(workDir, "cache-wot");
    const result = await renderBuild(
      {
        payload: {
          type: "wall-of-text",
          canvas: CANVAS,
          video: { url: `${MEDIA_PREFIX}video.mp4` },
          audio: { url: `${LIBRARY_PREFIX}track.m4a` },
          texts: [textBox("Wall of text")],
        },
      },
      engineConfig(cacheDir),
    );

    expect(result.artifacts).toHaveLength(1);
    const artifact = result.artifacts[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    expect(artifact.bytes).toBeGreaterThan(0);

    const info = await probeMedia(artifact.path);
    expect(info.width).toBe(CANVAS.width);
    expect(info.height).toBe(CANVAS.height);
    expect(info.hasAudio).toBe(true);
  }, 120_000);

  it("green-screen compone el croma sobre la imagen de fondo", async () => {
    const cacheDir = path.join(workDir, "cache-gs");
    const result = await renderBuild(
      {
        payload: {
          type: "green-screen",
          canvas: CANVAS,
          image: { url: `${MEDIA_PREFIX}bg.png` },
          video: { url: `${MEDIA_PREFIX}chroma.mp4` },
          texts: [textBox("Green screen")],
        },
      },
      engineConfig(cacheDir),
    );
    const artifact = result.artifacts[0];
    expect(artifact?.bytes ?? 0).toBeGreaterThan(0);
    if (artifact === undefined) return;
    const info = await probeMedia(artifact.path);
    expect(info.width).toBe(CANVAS.width);
    expect(info.height).toBe(CANVAS.height);
  }, 120_000);

  it("video-hook apila hook arriba y demo abajo", async () => {
    const cacheDir = path.join(workDir, "cache-vh");
    const result = await renderBuild(
      {
        payload: {
          type: "video-hook",
          canvas: CANVAS,
          hookVideo: { url: `${MEDIA_PREFIX}video.mp4` },
          demoVideo: { url: `${MEDIA_PREFIX}demo.mp4` },
          audio: { url: `${LIBRARY_PREFIX}track.m4a` },
          texts: [textBox("Hook y demo")],
        },
      },
      engineConfig(cacheDir),
    );
    const artifact = result.artifacts[0];
    expect(artifact?.bytes ?? 0).toBeGreaterThan(0);
    if (artifact === undefined) return;
    const info = await probeMedia(artifact.path);
    expect(info.height).toBe(CANVAS.height);
    expect(info.hasAudio).toBe(true);
  }, 120_000);

  it("slideshow produce un JPEG por slide", async () => {
    const cacheDir = path.join(workDir, "cache-ss");
    const result = await renderBuild(
      {
        payload: {
          type: "slideshow",
          numImages: 3,
          slides: [0, 1, 2].map((index) => ({
            canvas: { width: 540, height: 675, aspectRatio: "4:5" },
            image: { url: `${MEDIA_PREFIX}bg.png` },
            texts: [{ ...textBox(`Slide ${index}`), id: `t${index}` }],
          })),
        },
      },
      engineConfig(cacheDir),
    );
    expect(result.artifacts).toHaveLength(3);
    for (const artifact of result.artifacts) {
      expect(artifact.kind).toBe("image");
      expect(artifact.bytes).toBeGreaterThan(1000);
      const meta = await sharp(artifact.path).metadata();
      expect(meta.width).toBe(540);
      expect(meta.height).toBe(675);
      expect(meta.format).toBe("jpeg");
    }
  }, 120_000);

  it("una edición SÓLO de texto reutiliza la base: no re-encodea el fondo", async () => {
    const cacheDir = path.join(workDir, "cache-edit");
    const config = engineConfig(cacheDir);
    const base = {
      type: "wall-of-text",
      canvas: CANVAS,
      video: { url: `${MEDIA_PREFIX}video.mp4` },
      audio: { url: `${LIBRARY_PREFIX}track.m4a` },
    };

    const first = await renderBuild(
      { payload: { ...base, texts: [textBox("copy original")] } },
      config,
    );
    expect(first.cache).toEqual({ base: "miss", build: "miss" });

    // Minor edit de `FR-051`: cambia sólo la copy.
    const second = await renderBuild(
      { payload: { ...base, texts: [textBox("copy reescrita")] } },
      config,
    );
    expect(second.keys.mediaKey).toBe(first.keys.mediaKey);
    expect(second.keys.buildKey).not.toBe(first.keys.buildKey);
    // Esto es la palanca de costo: la base salió de cache.
    expect(second.cache.base).toBe("hit");
    expect(second.cache.build).toBe("miss");

    // El mismo payload otra vez: ni siquiera se recompone el overlay.
    const third = await renderBuild(
      { payload: { ...base, texts: [textBox("copy reescrita")] } },
      config,
    );
    expect(third.cache).toEqual({ base: "hit", build: "hit" });
  }, 180_000);

  it("una URL ajena al workspace se rechaza ANTES de tocar ffmpeg", async () => {
    const cacheDir = path.join(workDir, "cache-reject");
    await expect(
      renderBuild(
        {
          payload: {
            type: "wall-of-text",
            canvas: CANVAS,
            video: { url: "https://evil.test.local/v.mp4" },
            audio: { url: `${LIBRARY_PREFIX}track.m4a` },
            texts: [textBox("x")],
          },
        },
        engineConfig(cacheDir),
      ),
    ).rejects.toMatchObject({ code: "media_url_not_allowed", status: 400 });
  }, 30_000);
});
