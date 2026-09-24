/**
 * `green-screen` con un foreground **con alfa** — `PU-MEME-002`.
 *
 * Un recorte de fondo (fal BiRefNet → webm VP9 con alfa, o ProRes 4444) no es
 * verde: el croma no tiene qué sacar. El plan lo detecta y usa `overlay`
 * directo. Lo que este test mide contra el ffmpeg real, con clips generados acá:
 *
 *  · el píxel de una esquina del resultado es el **fondo de marca** (el alfa 0
 *    del clip dejó ver la imagen) y el del centro es el **sujeto** (alfa 1);
 *  · en webm VP9 eso exige forzar `libvpx-vp9`: con el decoder nativo el alfa
 *    no llega y la esquina sale negra (la trampa de `probe.ts`);
 *  · con `normalizeInputs: true` el foreground con alfa **no** se normaliza
 *    (la normalización lo pasaría a H.264 y el alfa se perdería);
 *  · la rama de croma no cambió (el plan sin alfa sigue usando `chromakey`).
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FileCacheStore } from "../cache/store.js";
import { FFMPEG_BIN, probeCapabilities } from "../ffmpeg/capabilities.js";
import { probeMedia } from "../ffmpeg/probe.js";
import { parsePrefixList } from "../media/urlPolicy.js";
import { renderBuild, type RenderEngineConfig } from "./engine.js";
import { planGreenScreenBase } from "./formats.js";

const execFileAsync = promisify(execFile);
const caps = await probeCapabilities();
const suite = caps.available ? describe : describe.skip;

const PREFIX = "https://cdn.test.local/media/ws-1/";
const CANVAS = { width: 540, height: 960 };
const BG = { r: 20, g: 40, b: 200 };

let workDir = "";
const files = new Map<string, string>();

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync(FFMPEG_BIN, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...args,
  ]);
}

/**
 * Un clip **entero rojo** con alfa 255 sólo en un rectángulo central. Si el
 * alfa no llegara al overlay (decoder nativo de VP9, o una normalización a
 * H.264), la esquina saldría roja y no del color del fondo.
 *
 * El alfa se escribe con `geq`: `drawbox` sobre `yuva420p` pinta color pero
 * **no toca el plano alfa** (medido: el rectángulo quedaba con alfa 0).
 */
const SUBJECT =
  "color=c=red:s=360x640:r=30:d=2,format=yuva420p," +
  "geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(between(X,120,239)*between(Y,220,419),255,0)'";

beforeAll(async () => {
  if (!caps.available) return;
  workDir = await mkdtemp(path.join(tmpdir(), "fastgram-alpha-it-"));
  const webm = path.join(workDir, "cutout.webm");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    SUBJECT,
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-auto-alt-ref",
    "0",
    webm,
  ]);
  const mov = path.join(workDir, "cutout.mov");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    SUBJECT,
    "-c:v",
    "prores_ks",
    "-profile:v",
    "4444",
    "-pix_fmt",
    "yuva444p10le",
    mov,
  ]);
  const bg = path.join(workDir, "bg.png");
  await writeFile(
    bg,
    await sharp({ create: { width: 1080, height: 1920, channels: 3, background: BG } })
      .png()
      .toBuffer(),
  );
  files.set(`${PREFIX}cutout.webm`, webm);
  files.set(`${PREFIX}cutout.mov`, mov);
  files.set(`${PREFIX}bg.png`, bg);
}, 120_000);

afterAll(async () => {
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

function config(cacheDir: string, normalizeInputs: boolean): RenderEngineConfig {
  return {
    cache: new FileCacheStore(cacheDir),
    policy: {
      mediaPrefixes: parsePrefixList(PREFIX),
      sharedPrefixes: [],
      grantSecret: null,
      requireGrant: false,
      now: Date.now,
    },
    fonts: { fontDir: null, strict: false },
    resolveMedia: async (url) => {
      const local = files.get(url);
      if (local === undefined) throw new Error(`url no mapeada: ${url}`);
      return local;
    },
    normalizeInputs,
    allowUntonemappedHdr: false,
  };
}

/** RGB de un píxel del cuadro en `t` segundos. */
async function pixel(
  file: string,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  const { stdout } = await execFileAsync(
    FFMPEG_BIN,
    [
      "-nostdin",
      "-loglevel",
      "error",
      "-ss",
      "0.5",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `format=rgb24,crop=2:2:${x}:${y}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  return [stdout[0] ?? -1, stdout[1] ?? -1, stdout[2] ?? -1];
}

const near = (a: [number, number, number], b: { r: number; g: number; b: number }) =>
  Math.abs(a[0] - b.r) < 30 && Math.abs(a[1] - b.g) < 30 && Math.abs(a[2] - b.b) < 30;

suite("green-screen con foreground con alfa (ffmpeg real)", () => {
  it("probe detecta el alfa del webm por alpha_mode y el de ProRes por pix_fmt", async () => {
    const webm = await probeMedia(path.join(workDir, "cutout.webm"));
    expect(webm.pixelFormat).toBe("yuv420p");
    expect(webm.hasAlpha).toBe(true);
    expect(webm.alphaDecoder).toBe("libvpx-vp9");
    const mov = await probeMedia(path.join(workDir, "cutout.mov"));
    expect(mov.hasAlpha).toBe(true);
    expect(mov.alphaDecoder).toBeNull();
  });

  for (const [name, normalizeInputs] of [
    ["cutout.webm", false],
    ["cutout.webm", true],
    ["cutout.mov", true],
  ] as const) {
    it(`${name} (normalizeInputs=${normalizeInputs}): esquina = fondo, centro = sujeto`, async () => {
      const result = await renderBuild(
        {
          payload: {
            type: "green-screen",
            canvas: CANVAS,
            image: { url: `${PREFIX}bg.png` },
            video: { url: `${PREFIX}${name}` },
            // Arriba y angosto: no pisa ni la esquina ni el centro que se miden.
            texts: [
              {
                id: "t1",
                text: "Meme",
                position: { x: 50, y: 15 },
                widthPercent: 40,
                align: "center",
                font: { family: "inter", weight: 700, size: 28 },
                color: "#FFFFFF",
                stroke: { width: 3, color: "#000000" },
                background: null,
              },
            ],
          },
        },
        config(path.join(workDir, `cache-${name}-${normalizeInputs}`), normalizeInputs),
      );
      const out = result.artifacts[0];
      expect(out?.bytes ?? 0).toBeGreaterThan(0);
      if (out === undefined) return;
      const info = await probeMedia(out.path);
      expect([info.width, info.height]).toEqual([CANVAS.width, CANVAS.height]);

      // El clip 360×640 se escala a 540×960 (cover): la esquina es alfa 0.
      const corner = await pixel(out.path, 10, 10);
      expect(near(corner, BG), `esquina ${corner.join(",")}`).toBe(true);
      const center = await pixel(out.path, 270, 480);
      expect(near(center, { r: 255, g: 0, b: 0 }), `centro ${center.join(",")}`).toBe(
        true,
      );
    }, 120_000);
  }
});

describe("planGreenScreenBase", () => {
  const payload = {
    type: "green-screen" as const,
    canvas: { width: 540, height: 960 },
    image: { url: "https://x/bg.png", fit: "cover" as const },
    video: { url: "https://x/v.webm", fit: "cover" as const },
    chromaKey: { color: "#00FF00", similarity: 0.3, blend: 0.1 },
    texts: [],
  };
  const fakeCaps = {
    ...caps,
    available: true,
    filters: new Set([
      "overlay",
      "scale",
      "crop",
      "setsar",
      "chromakey",
      "colorkey",
      "format",
    ]),
  };
  const inputs = (video: Record<string, unknown>) => ({
    backgroundPath: "/bg.png",
    videoPath: "/v.webm",
    outputPath: "/out.mp4",
    background: { width: 1080, height: 1920 },
    video: { width: 360, height: 640, durationSeconds: 2, hasAudio: false, ...video },
  });

  it("con alfa: sin croma y con el decoder antes del -i del foreground", () => {
    // El payload real sale del parser; acá alcanza con la forma que lee el plan.
    const plan = planGreenScreenBase(
      payload as never,
      inputs({ hasAlpha: true, alphaDecoder: "libvpx-vp9" }),
      fakeCaps as never,
    );
    expect(plan.filterGraph).not.toContain("chromakey");
    expect(plan.filterGraph).toContain("[1:v]format=yuva420p,");
    const i = plan.args.indexOf("/v.webm");
    expect(plan.args.slice(i - 3, i)).toEqual(["-c:v", "libvpx-vp9", "-i"]);
  });

  it("sin alfa: la rama de croma de siempre", () => {
    const plan = planGreenScreenBase(payload as never, inputs({}), fakeCaps as never);
    expect(plan.filterGraph).toMatch(/\[1:v\](chromakey|colorkey)=0x00FF00:0\.3:0\.1,/);
    expect(plan.args).not.toContain("libvpx-vp9");
  });
});
