/**
 * `font.size` y `stroke.width` son unidades de editor sobre una vista previa de
 * 360 px (PRD, «Payloads de build», decisión del 2026-09-23). El render las
 * escala por `canvas.width / 360`.
 *
 * Lo que se fija acá, y que el test de la conversión sola no puede fijar:
 *  · que el escalado se aplica **en cada uno de los cuatro formatos**, con el
 *    canvas de ese payload —un formato que dibujara el texto por otro camino, o
 *    le pasara otro canvas, deja su test en rojo—;
 *  · que en el slideshow cada slide escala con **su** canvas;
 *  · que el stroke escala con el mismo factor que la fuente.
 *
 * Los valores esperados son literales a propósito: recalcularlos con
 * `editorUnitsToCanvasPx` haría que el test acompañe cualquier cambio de la
 * función en vez de detectarlo.
 *
 * `renderTextOverlay` se envuelve (no se reemplaza): el texto se dibuja de
 * verdad, y el envoltorio sólo anota con qué canvas se llamó y qué geometría
 * salió. Los formatos de video necesitan ffmpeg; sin él, ese bloque se saltea.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FileCacheStore } from "../cache/store.js";
import type { Canvas } from "../domain/canvas.js";
import type { BuildPayloadInput } from "../domain/payload.js";
import { FFMPEG_BIN, probeCapabilities } from "../ffmpeg/capabilities.js";
import { parsePrefixList } from "../media/urlPolicy.js";
import { renderBuild, type RenderEngineConfig } from "./engine.js";
import type * as TextLayerModule from "./textLayer.js";
import type { RenderedTextLayer } from "./textLayer.js";

const recorded = vi.hoisted(
  () => [] as { canvas: Canvas; layers: readonly RenderedTextLayer[] }[],
);

vi.mock("./textLayer.js", async (importOriginal) => {
  const original = await importOriginal<typeof TextLayerModule>();
  return {
    ...original,
    renderTextOverlay: async (...args: Parameters<typeof original.renderTextOverlay>) => {
      const result = await original.renderTextOverlay(...args);
      recorded.push({ canvas: args[1], layers: result.layers });
      return result;
    },
  };
});

// Importado después del mock: es el módulo envuelto.
const { renderTextBox } = await import("./textLayer.js");

const execFileAsync = promisify(execFile);
const caps = await probeCapabilities();
const videoSuite = caps.available ? describe : describe.skip;

const MEDIA = "https://cdn.test.local/media/ws-1/";
const LIBRARY = "https://library.test.local/audio/";
const FONTS = { fontDir: null, strict: false } as const;

let workDir = "";
const files = new Map<string, string>();

function box(size: number, strokeWidth: number) {
  return {
    id: "t1",
    text: "Texto escalado",
    position: { x: 50, y: 30 },
    widthPercent: 80,
    align: "center" as const,
    font: { family: "inter" as const, weight: 700, size },
    color: "#FFFFFF",
    stroke: { width: strokeWidth, color: "#000000" },
    background: null,
  };
}

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
  workDir = await mkdtemp(path.join(tmpdir(), "fastgram-text-scale-"));

  const image = path.join(workDir, "bg.png");
  await writeFile(
    image,
    await sharp({
      create: {
        width: 1200,
        height: 1500,
        channels: 3,
        background: { r: 20, g: 40, b: 80 },
      },
    })
      .png()
      .toBuffer(),
  );
  files.set(`${MEDIA}bg.png`, image);

  if (!caps.available) return;
  const video = path.join(workDir, "video.mp4");
  await lavfi(
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=30:duration=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
    ],
    video,
  );
  files.set(`${MEDIA}video.mp4`, video);
}, 120_000);

afterAll(async () => {
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  recorded.length = 0;
});

function engineConfig(name: string): RenderEngineConfig {
  return {
    cache: new FileCacheStore(path.join(workDir, `cache-${name}`)),
    policy: {
      mediaPrefixes: parsePrefixList(MEDIA),
      sharedPrefixes: parsePrefixList(LIBRARY),
      grantSecret: null,
      requireGrant: false,
      now: Date.now,
    },
    fonts: FONTS,
    resolveMedia: async (url) => {
      const local = files.get(url);
      if (local === undefined) throw new Error(`url no mapeada en el test: ${url}`);
      return local;
    },
    normalizeInputs: false,
    allowUntonemappedHdr: false,
  };
}

async function renderAndRecord(name: string, payload: BuildPayloadInput) {
  await renderBuild({ payload }, engineConfig(name));
  return recorded.map((call) => ({
    canvasWidth: call.canvas.width,
    sizes: call.layers.map((layer) => [
      layer.geometry.fontSizePx,
      layer.geometry.strokeWidthPx,
    ]),
  }));
}

describe("renderTextBox — la fuente y el stroke escalan con el mismo factor", () => {
  it("en 360 de ancho no cambia nada (×1)", async () => {
    const layer = await renderTextBox(box(18, 3), { width: 360, height: 640 }, FONTS);
    expect(layer?.geometry.fontSizePx).toBe(18);
    expect(layer?.geometry.strokeWidthPx).toBe(3);
  });

  it("en 1080 de ancho, ×3 para los dos: 18 → 54 y 3 → 9", async () => {
    const layer = await renderTextBox(box(18, 3), { width: 1080, height: 1350 }, FONTS);
    expect(layer?.geometry.fontSizePx).toBe(54);
    expect(layer?.geometry.strokeWidthPx).toBe(9);
  });

  it("el alto de la caja crece ~×3 entre 360 y 1080 (el texto se ve 3 veces más grande)", async () => {
    const small = await renderTextBox(box(18, 3), { width: 360, height: 450 }, FONTS);
    const large = await renderTextBox(box(18, 3), { width: 1080, height: 1350 }, FONTS);
    const ratio = (large?.geometry.height ?? 0) / (small?.geometry.height ?? 1);
    expect(ratio).toBeGreaterThan(2.7);
    expect(ratio).toBeLessThan(3.3);
  });
});

describe("escalado por formato — slideshow (sin ffmpeg)", () => {
  it("cada slide escala con SU canvas: 1080 → ×3 y 720 → ×2", async () => {
    const calls = await renderAndRecord("slideshow", {
      type: "slideshow",
      numImages: 2,
      slides: [
        {
          canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
          image: { url: `${MEDIA}bg.png` },
          texts: [box(18, 3)],
        },
        {
          canvas: { width: 720, height: 900, aspectRatio: "4:5" },
          image: { url: `${MEDIA}bg.png` },
          texts: [box(18, 3)],
        },
      ],
    });
    expect(calls).toEqual([
      { canvasWidth: 1080, sizes: [[54, 9]] },
      { canvasWidth: 720, sizes: [[36, 6]] },
    ]);
  }, 60_000);
});

videoSuite("escalado por formato — video (ffmpeg real)", () => {
  // 540 de ancho: ×1.5. size 24 → 36, stroke 4 → 6.
  const CANVAS = { width: 540, height: 960 };
  const EXPECTED = [{ canvasWidth: 540, sizes: [[36, 6]] }];

  it("wall-of-text", async () => {
    const calls = await renderAndRecord("wot", {
      type: "wall-of-text",
      canvas: CANVAS,
      video: { url: `${MEDIA}video.mp4` },
      texts: [box(24, 4)],
    });
    expect(calls).toEqual(EXPECTED);
  }, 120_000);

  it("green-screen", async () => {
    const calls = await renderAndRecord("gs", {
      type: "green-screen",
      canvas: CANVAS,
      image: { url: `${MEDIA}bg.png` },
      video: { url: `${MEDIA}video.mp4` },
      texts: [box(24, 4)],
    });
    expect(calls).toEqual(EXPECTED);
  }, 120_000);

  it("video-hook", async () => {
    const calls = await renderAndRecord("vh", {
      type: "video-hook",
      canvas: CANVAS,
      hookVideo: { url: `${MEDIA}video.mp4` },
      demoVideo: { url: `${MEDIA}video.mp4` },
      texts: [box(24, 4)],
    });
    expect(calls).toEqual(EXPECTED);
  }, 120_000);
});
