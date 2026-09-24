/**
 * `P2-RENDER-011` — Golden files. "Mismo payload ⇒ mismo frame. Detectan que un
 * upgrade de FFmpeg movió la tipografía. Comparar por hash de la salida, no
 * píxel a píxel" (IMPL §4).
 *
 * Hay DOS golden distintos, y la diferencia importa:
 *
 *  1. **Golden de plan** (`plans.json`) — el argv y el filtergraph exactos de
 *     cada formato. No depende de la máquina: viaja en el repo y se compara en
 *     cualquier CI. Es el que atrapa un cambio silencioso en el pipeline.
 *
 *  2. **Golden de frame** (`frames.<fingerprint>.json`) — el SHA-256 del PNG del
 *     overlay y del JPEG del slide. Esto SÍ depende del stack local (libvips,
 *     Pango, FreeType, fuentes instaladas), así que el archivo lleva la huella
 *     del entorno en el nombre y se graba en la primera corrida. Dentro de un
 *     mismo entorno —una imagen de CI, por ejemplo— detecta exactamente lo que
 *     pide el plan: que un upgrade movió la tipografía. Entre entornos
 *     distintos no se compara nada, porque comparar sería mentir.
 *
 * Si `frames.<fingerprint>.json` no existe, el test lo graba y avisa. No falla:
 * un golden ausente no es una regresión.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  buildPayloadSchema,
  videoHookPayloadSchema,
  wallOfTextPayloadSchema,
} from "../domain/payload.js";
import type { FfmpegCapabilities } from "../ffmpeg/capabilities.js";
import {
  planGreenScreenBase,
  planTextOverlayPass,
  planVideoHookBase,
  planWallOfTextBase,
} from "./formats.js";
import { renderSlideBase, renderSlideWithText } from "./slideshow.js";
import { renderTextOverlay, type TextLayerOptions } from "./textLayer.js";

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__goldens__");

const CAPS: FfmpegCapabilities = {
  available: true,
  version: "golden",
  filters: new Set([
    "overlay",
    "scale",
    "crop",
    "setsar",
    "chromakey",
    "colorkey",
    // Sprint 7: la mezcla de la música con el clip del green-screen.
    "amix",
    "volume",
  ]),
  encoders: new Set(["libx264", "aac"]),
  hasDrawtext: false,
  hasOverlay: true,
  hasChromakey: true,
  hasColorkey: true,
  hasZscale: false,
  hasTonemap: true,
  hasColorspace: true,
};

const TEXT = {
  id: "t1",
  text: "El hook que para el scroll",
  position: { x: 50, y: 22 },
  widthPercent: 80,
  align: "center",
  font: { family: "inter", weight: 700, size: 36 },
  color: "#FFFFFF",
  stroke: { width: 4, color: "#000000" },
  background: null,
} as const;

const CANVAS = { width: 1080, height: 1920 };
const SOURCE = { width: 1920, height: 1080, durationSeconds: 8, hasAudio: true };

function readGolden(file: string): Record<string, unknown> | null {
  const target = path.join(GOLDEN_DIR, file);
  if (!existsSync(target)) return null;
  return JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
}

function writeGolden(file: string, value: unknown): void {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(path.join(GOLDEN_DIR, file), `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("golden de plan — portable entre máquinas", () => {
  const wallOfText = buildPayloadSchema.parse({
    type: "wall-of-text",
    canvas: CANVAS,
    video: { url: "https://cdn.example.com/media/ws-1/v.mp4" },
    audio: { url: "https://library.example.com/audio/a.m4a" },
    texts: [TEXT],
  });
  const greenScreen = buildPayloadSchema.parse({
    type: "green-screen",
    canvas: CANVAS,
    image: { url: "https://cdn.example.com/media/ws-1/bg.jpg" },
    video: { url: "https://cdn.example.com/media/ws-1/chroma.mp4" },
    texts: [TEXT],
  });
  const videoHook = buildPayloadSchema.parse({
    type: "video-hook",
    canvas: CANVAS,
    hookVideo: { url: "https://cdn.example.com/media/ws-1/hook.mp4" },
    demoVideo: { url: "https://cdn.example.com/media/ws-1/demo.mp4" },
    audio: { url: "https://library.example.com/audio/a.m4a" },
    texts: [TEXT],
  });

  const wallOfTextNoAudio = wallOfTextPayloadSchema.parse({
    type: "wall-of-text",
    canvas: CANVAS,
    video: { url: "https://cdn.example.com/media/ws-1/v.mp4" },
    texts: [TEXT],
  });
  const videoHookNoAudio = videoHookPayloadSchema.parse({
    type: "video-hook",
    canvas: CANVAS,
    hookVideo: { url: "https://cdn.example.com/media/ws-1/hook.mp4" },
    demoVideo: { url: "https://cdn.example.com/media/ws-1/demo.mp4" },
    texts: [TEXT],
  });

  function buildPlans(): Record<string, unknown> {
    if (wallOfText.type !== "wall-of-text") throw new Error("payload inesperado");
    if (greenScreen.type !== "green-screen") throw new Error("payload inesperado");
    if (videoHook.type !== "video-hook") throw new Error("payload inesperado");
    return {
      "wall-of-text": planWallOfTextBase(
        wallOfText,
        {
          videoPath: "/in/video.mp4",
          audioPath: "/in/audio.m4a",
          outputPath: "/out/base.mp4",
          video: SOURCE,
        },
        CAPS,
      ),
      "green-screen": planGreenScreenBase(
        greenScreen,
        {
          backgroundPath: "/in/bg.jpg",
          videoPath: "/in/chroma.mp4",
          outputPath: "/out/base.mp4",
          background: { width: 1500, height: 1500 },
          video: SOURCE,
        },
        CAPS,
      ),
      // Sprint 7: música de la marca en green-screen. Con clip con audio se
      // mezcla (clip 100 %, música 30 %); con clip mudo, la música va sola.
      "green-screen-music-mix": planGreenScreenBase(
        greenScreen,
        {
          backgroundPath: "/in/bg.jpg",
          videoPath: "/in/chroma.mp4",
          audioPath: "/in/music.mp3",
          outputPath: "/out/base.mp4",
          background: { width: 1500, height: 1500 },
          video: SOURCE,
        },
        CAPS,
      ),
      "green-screen-music-only": planGreenScreenBase(
        greenScreen,
        {
          backgroundPath: "/in/bg.jpg",
          videoPath: "/in/chroma.mp4",
          audioPath: "/in/music.mp3",
          outputPath: "/out/base.mp4",
          background: { width: 1500, height: 1500 },
          video: { ...SOURCE, hasAudio: false },
        },
        CAPS,
      ),
      "video-hook": planVideoHookBase(
        videoHook,
        {
          hookPath: "/in/hook.mp4",
          demoPath: "/in/demo.mp4",
          audioPath: "/in/audio.m4a",
          outputPath: "/out/base.mp4",
          hook: SOURCE,
          demo: { width: 1080, height: 1920, durationSeconds: 12, hasAudio: false },
        },
        CAPS,
      ),
      // `FR-053.1` / `P2-RENDER-014`: el mismo payload sin bloque `audio`. Va al
      // golden porque el riesgo real no es que rompa hoy, es que alguien
      // "arregle" el grafo y le meta una pista de silencio sin notarlo.
      "wall-of-text-no-audio": planWallOfTextBase(
        wallOfTextNoAudio,
        {
          videoPath: "/in/video.mp4",
          audioPath: null,
          outputPath: "/out/base.mp4",
          video: SOURCE,
        },
        CAPS,
      ),
      "video-hook-no-audio": planVideoHookBase(
        videoHookNoAudio,
        {
          hookPath: "/in/hook.mp4",
          demoPath: "/in/demo.mp4",
          audioPath: null,
          outputPath: "/out/base.mp4",
          hook: SOURCE,
          demo: { width: 1080, height: 1920, durationSeconds: 12, hasAudio: false },
        },
        CAPS,
      ),
      "overlay-pass": planTextOverlayPass(
        "/out/base.mp4",
        "/out/overlay.png",
        "/out/final.mp4",
        true,
        CAPS,
      ),
      "overlay-pass-no-audio": planTextOverlayPass(
        "/out/base.mp4",
        "/out/overlay.png",
        "/out/final.mp4",
        false,
        CAPS,
      ),
    };
  }

  it("el mismo payload produce el mismo plan, dos veces seguidas", () => {
    expect(JSON.stringify(buildPlans())).toBe(JSON.stringify(buildPlans()));
  });

  it("coincide con el golden versionado", () => {
    const current = JSON.parse(JSON.stringify(buildPlans())) as Record<string, unknown>;
    const golden = readGolden("plans.json");
    if (golden === null) {
      writeGolden("plans.json", current);
      console.warn("[golden] plans.json no existía: se grabó ahora.");
      return;
    }
    expect(current).toEqual(golden);
  });

  it("el plan nunca usa drawtext", () => {
    const serialized = JSON.stringify(buildPlans());
    expect(serialized).not.toContain("drawtext");
    expect(serialized).toContain("overlay=");
  });

  it("el plan de la base NO incluye el overlay de texto: es la pasada separada", () => {
    const plans = buildPlans() as Record<string, { args: string[] }>;
    // La base de wall-of-text tiene 2 entradas (video + audio), no 3.
    const inputs = plans["wall-of-text"]?.args.filter((arg) => arg === "-i").length;
    expect(inputs).toBe(2);
  });

  /**
   * `P2-RENDER-014`. Lo que se mide es la decisión, no el formato: sin bloque
   * `audio` la salida NO lleva stream de audio (`-an`) y NO lleva una pista de
   * silencio. Si alguien agrega un `anullsrc`, esto se pone rojo.
   */
  it("sin bloque `audio` el plan pierde el input y sale con `-an`", () => {
    const plans = buildPlans() as Record<
      string,
      { args: string[]; hasAudio: boolean; filterGraph: string }
    >;
    const countInputs = (key: string): number =>
      plans[key]?.args.filter((arg) => arg === "-i").length ?? -1;

    expect(countInputs("wall-of-text")).toBe(2);
    expect(countInputs("wall-of-text-no-audio")).toBe(1);
    expect(countInputs("video-hook")).toBe(3);
    expect(countInputs("video-hook-no-audio")).toBe(2);

    for (const key of ["wall-of-text-no-audio", "video-hook-no-audio"]) {
      const plan = plans[key];
      expect(plan).toBeDefined();
      if (plan === undefined) continue;
      expect(plan.hasAudio).toBe(false);
      expect(plan.args).toContain("-an");
      // Nada de pista de silencio, y nada de encoder de audio.
      expect(plan.args).not.toContain("-c:a");
      expect(plan.args.join(" ")).not.toContain("anullsrc");
      expect(plan.args.join(" ")).not.toContain("aevalsrc");
      expect(plan.filterGraph).not.toContain("anullsrc");
    }

    // El grafo de video es idéntico con y sin audio: los índices no se mueven.
    expect(plans["wall-of-text-no-audio"]?.filterGraph).toBe(
      plans["wall-of-text"]?.filterGraph,
    );
    expect(plans["video-hook-no-audio"]?.filterGraph).toBe(
      plans["video-hook"]?.filterGraph,
    );
  });
});

// ── Golden de frame ──────────────────────────────────────────────────────────

const FONT_OPTIONS: TextLayerOptions = { fontDir: null, strict: false };

/**
 * Huella del entorno de texto. Si cambia libvips, Pango o FreeType, cambia el
 * nombre del archivo y el golden viejo deja de aplicar en vez de fallar por una
 * razón equivocada.
 */
function environmentFingerprint(): string {
  const v = sharp.versions;
  return [
    `sharp${v.sharp}`,
    `vips${v.vips}`,
    `pango${v.pango ?? "na"}`,
    `ft${v.freetype ?? "na"}`,
    FONT_OPTIONS.fontDir === null ? "nofontdir" : "fontdir",
  ].join("-");
}

async function gradientSource(): Promise<Buffer> {
  // Fuente determinista: no hace falta un fixture binario en el repo.
  return sharp({
    create: {
      width: 1600,
      height: 900,
      channels: 3,
      background: { r: 30, g: 90, b: 160 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">` +
            `<rect x="200" y="100" width="700" height="500" fill="#e8c547"/>` +
            `<circle cx="1200" cy="600" r="220" fill="#c0392b"/></svg>`,
        ),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

describe("golden de frame — mismo payload ⇒ mismo frame", () => {
  it("el overlay de texto es determinista byte a byte", async () => {
    const first = await renderTextOverlay([TEXT], CANVAS, FONT_OPTIONS);
    const second = await renderTextOverlay([TEXT], CANVAS, FONT_OPTIONS);
    expect(sha256(first.png)).toBe(sha256(second.png));
    expect(first.png.byteLength).toBeGreaterThan(0);
  }, 30_000); // renderiza dos veces con Pango: bajo `turbo` en paralelo pasa los 5 s por defecto

  it("un cambio de tipografía cambia el frame", async () => {
    const base = await renderTextOverlay([TEXT], CANVAS, FONT_OPTIONS);
    const bigger = await renderTextOverlay(
      [{ ...TEXT, font: { ...TEXT.font, size: 48 } }],
      CANVAS,
      FONT_OPTIONS,
    );
    expect(sha256(bigger.png)).not.toBe(sha256(base.png));
  });

  it("el slideshow produce un JPEG no vacío y estable", async () => {
    const source = await gradientSource();
    const sourcePath = path.join(tmpdir(), "fastgram-golden-source.png");
    writeFileSync(sourcePath, source);

    const payload = buildPayloadSchema.parse({
      type: "slideshow",
      numImages: 1,
      slides: [
        {
          canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
          image: { url: "https://cdn.example.com/media/ws-1/a.png" },
          texts: [TEXT],
        },
      ],
    });
    if (payload.type !== "slideshow") throw new Error("payload inesperado");

    const base = await renderSlideBase(payload, 0, sourcePath);
    const rendered = await renderSlideWithText(payload, 0, base, FONT_OPTIONS);
    expect(rendered.jpeg.byteLength).toBeGreaterThan(1000);

    const again = await renderSlideWithText(payload, 0, base, FONT_OPTIONS);
    expect(sha256(again.jpeg)).toBe(sha256(rendered.jpeg));

    // `EXT-006`: la base es 4:5 recortada, no la fuente 16:9 estirada.
    const meta = await sharp(base).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);

    const file = `frames.${environmentFingerprint()}.json`;
    const current = {
      overlay: sha256((await renderTextOverlay([TEXT], CANVAS, FONT_OPTIONS)).png),
      slideBase: sha256(base),
      slideFinal: sha256(rendered.jpeg),
    };
    const golden = readGolden(file);
    if (golden === null) {
      writeGolden(file, current);
      console.warn(`[golden] ${file} no existía: se grabó ahora.`);
      return;
    }
    expect(current).toEqual(golden);
  });
});
