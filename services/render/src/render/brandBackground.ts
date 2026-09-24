/**
 * `PU-MEDIA-002` — `POST /brand-backgrounds`: fondos de marca dibujados acá.
 *
 * Qué se dibuja lo decide `domain/brandBackground.ts` (puro); este archivo lo
 * convierte en bytes:
 *
 *  · **imagen** (1080×1350 o 1080×1920, JPEG): sharp compone en un solo
 *    pipeline el degradé de base, las manchas desenfocadas, la viñeta y el
 *    grano. Nada de texto: son fondos, el texto lo pone el build.
 *  · **video** (1080×1920, 6–10 s, H.264 yuv420p, faststart, sin audio): sharp
 *    dibuja las capas **una vez** (base, una PNG con alfa por mancha, viñeta) y
 *    FFmpeg las mueve con `overlay` + expresiones periódicas. El loop cierra
 *    por construcción: ver `blobOffsetAt`.
 *
 * ## Por qué las manchas se dibujan a un cuarto de resolución
 *
 * Un desenfoque gaussiano de σ≈90 px sobre 2 MP es caro, y el resultado es,
 * por definición, una imagen sin detalle. Se dibuja la máscara a ¼, se
 * desenfoca ahí (σ/4) y se agranda: el resultado es indistinguible y cuesta
 * una fracción. El grano va a resolución completa, después, porque es lo único
 * que sí tiene detalle.
 *
 * ## Filtros de FFmpeg
 *
 * Sólo `overlay` y `format`, más `noise` para el grano del video. Los tres
 * están en cualquier build razonable —el de esta máquina, 9.0.1 de Homebrew
 * sin libfreetype, los trae— y se exigen con `requireFilters` antes de gastar
 * un segundo de encode. Nada de `drawtext`, `gradients` ni `perlin`: el
 * degradé y las formas las dibuja sharp, que ya es dependencia dura.
 *
 * ## Autorización
 *
 * No hay URLs que validar —el pedido no lee media de nadie—, pero dibujar un
 * video cuesta CPU, y `RENDER_REQUIRE_GRANT=true` (el default del producto)
 * dice que sin grant firmado este servicio no trabaja. Se aplica igual: con
 * `requireGrant`, un pedido sin grant es `media_grant_invalid`; con grant, se
 * verifica firma y vencimiento como en cualquier otra ruta.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { z } from "zod";
import { RenderError } from "../errors.js";
import {
  probeCapabilities,
  requireFilters,
  type FfmpegCapabilities,
} from "../ffmpeg/capabilities.js";
import { probeMedia } from "../ffmpeg/probe.js";
import { runFfmpeg } from "../ffmpeg/run.js";
import {
  BRAND_BACKGROUND_GENERATOR_VERSION,
  HEX_COLOR,
  MAX_PALETTE,
  MIN_PALETTE,
  normalizePalette,
  planBackground,
  seededRandom,
  type BackgroundSpec,
  type BlobSpec,
} from "../domain/brandBackground.js";
import { mediaGrantSchema, verifyGrant } from "../media/urlPolicy.js";
import type { ArtifactExtension, CacheState, RenderEngineConfig } from "./engine.js";
import { engineVersion } from "./engineVersion.js";

/** Lo que el plan de uso personal pide: feed 4:5 y story/reel 9:16. */
export const BACKGROUND_CANVASES = {
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
} as const;
export type BackgroundAspect = keyof typeof BACKGROUND_CANVASES;

export const VIDEO_FPS = 30;
export const MIN_VIDEO_SECONDS = 6;
export const MAX_VIDEO_SECONDS = 10;
export const DEFAULT_VIDEO_SECONDS = 8;

/** Factor de la resolución a la que se dibujan y desenfocan las máscaras. */
const MASK_SCALE = 4;

/** Filtros que el loop necesita. Se verifican antes de encodear. */
export const VIDEO_FILTERS = ["overlay", "format", "noise"] as const;

export const brandBackgroundRequestSchema = z
  .object({
    /** 2–5 colores `#RRGGBB`. Duplicados (sin distinguir mayúsculas) no cuentan. */
    palette: z.array(z.string().regex(HEX_COLOR)).min(MIN_PALETTE).max(MAX_PALETTE),
    /** Cualquier texto: el mismo `(paleta, seed)` da el mismo fondo. */
    seed: z.string().min(1).max(200),
    kind: z.enum(["image", "video"]),
    /** Default `9:16`. El video sólo existe en 9:16 (fondo de wall-of-text). */
    aspectRatio: z.enum(["4:5", "9:16"]).default("9:16"),
    /** Sólo video. Segundos enteros: el loop se arma con N·30 cuadros exactos. */
    durationSeconds: z
      .number()
      .int()
      .min(MIN_VIDEO_SECONDS)
      .max(MAX_VIDEO_SECONDS)
      .optional(),
    grant: mediaGrantSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (normalizePalette(value.palette).length < MIN_PALETTE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["palette"],
        message: "la paleta necesita al menos dos colores distintos",
      });
    }
    if (value.kind === "video" && value.aspectRatio !== "9:16") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aspectRatio"],
        message: "el video de fondo sólo se genera en 9:16",
      });
    }
    if (value.kind === "image" && value.durationSeconds !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationSeconds"],
        message: "una imagen no tiene duración",
      });
    }
  });

export type BrandBackgroundRequest = z.infer<typeof brandBackgroundRequestSchema>;

/** La misma forma que `/thumbnail`: lo que el adaptador arma en `RenderedMedia`. */
export interface BrandBackgroundResponse {
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds?: number;
  readonly cacheKey: string;
  readonly extension: ArtifactExtension;
  readonly cache: CacheState;
  readonly warnings: readonly string[];
}

/* ------------------------------------------------------------------------ *
 * Capas (sharp)
 * ------------------------------------------------------------------------ */

function rgbOf(hex: string): { r: number; g: number; b: number } {
  const n = Number.parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** El degradé de base, opaco, a resolución completa. */
export async function renderBaseLayer(
  spec: BackgroundSpec,
  width: number,
  height: number,
): Promise<Buffer> {
  const stops = spec.stops
    .map((s) => `<stop offset="${String(s.offset)}" stop-color="${s.color}"/>`)
    .join("");
  const gradient =
    spec.style === "radial"
      ? `<radialGradient id="g" cx="${String(spec.focusX)}" cy="${String(spec.focusY)}" ` +
        `r="0.95" fx="${String(spec.focusX)}" fy="${String(spec.focusY)}">${stops}</radialGradient>`
      : `<linearGradient id="g" x1="0" y1="0.5" x2="1" y2="0.5" ` +
        `gradientTransform="rotate(${String(spec.angleDeg)} 0.5 0.5)">${stops}</linearGradient>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">` +
    `<defs>${gradient}</defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).flatten({ background: "#000000" }).png().toBuffer();
}

/** Una mancha: RGBA, del tamaño de su caja (con margen para el desenfoque). */
export interface BlobLayer {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  /** Esquina superior izquierda de la caja en `t = 0`, en píxeles. Puede ser negativa. */
  readonly left: number;
  readonly top: number;
}

export async function renderBlobLayer(
  blob: BlobSpec,
  spec: BackgroundSpec,
  canvasWidth: number,
  canvasHeight: number,
): Promise<BlobLayer> {
  // Todo en unidades de máscara (¼): radios y σ salen del ancho del canvas.
  const unit = canvasWidth / MASK_SCALE;
  const sigma = Math.max(0.5, spec.blur * unit);
  const rx = blob.rx * unit;
  const ry = blob.ry * unit;
  const pad = Math.ceil(sigma * 3);
  const qw = Math.ceil(rx * 2 + pad * 2);
  const qh = Math.ceil(ry * 2 + pad * 2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(qw)}" height="${String(qh)}">` +
    `<rect width="100%" height="100%" fill="#000"/>` +
    `<ellipse cx="${String(qw / 2)}" cy="${String(qh / 2)}" rx="${rx.toFixed(3)}" ` +
    `ry="${ry.toFixed(3)}" fill="#fff"/></svg>`;

  const width = qw * MASK_SCALE;
  const height = qh * MASK_SCALE;
  const blurred = await sharp(Buffer.from(svg))
    .flatten({ background: "#000000" })
    .greyscale()
    .blur(sigma)
    .raw()
    .toBuffer();
  // `greyscale()` + `raw()` deja un solo canal.
  const mask = await sharp(blurred, { raw: { width: qw, height: qh, channels: 1 } })
    .resize(width, height, { kernel: "cubic" })
    // **Obligatorio.** Un raw de un canal que pasa por `resize` (o `linear`)
    // sale convertido a sRGB de TRES canales, y el `joinChannel` de abajo lo
    // leería como un alfa rayado con forma de rectángulo. Medido: sin esto,
    // cada mancha era una caja con líneas horizontales.
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  // La opacidad de la mancha, horneada en el alfa. A mano y no con `.linear()`
  // por lo mismo de arriba.
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = Math.round((mask[i] ?? 0) * blob.opacity);
  }

  const { r, g, b } = rgbOf(blob.color);
  const data = await sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
  })
    .joinChannel(mask, { raw: { width, height, channels: 1 } })
    .raw()
    .toBuffer();

  return {
    data,
    width,
    height,
    left: Math.round(blob.cx * canvasWidth - width / 2),
    top: Math.round(blob.cy * canvasHeight - height / 2),
  };
}

/** La viñeta: negro con alfa creciente hacia los bordes. RGBA PNG. */
export async function renderVignetteLayer(
  spec: BackgroundSpec,
  width: number,
  height: number,
): Promise<Buffer> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">` +
    `<defs><radialGradient id="v" cx="0.5" cy="0.45" r="0.75">` +
    `<stop offset="0.5" stop-color="#000" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="#000" stop-opacity="${String(spec.vignette)}"/>` +
    `</radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Grano: ruido gris centrado en 128, para mezclar con `soft-light` (128 es
 * neutro). Sale del mismo PRNG sembrado que el spec, con otra rama de la
 * semilla: nada de `Math.random`.
 */
export function grainBuffer(
  seed: string,
  amplitude: number,
  width: number,
  height: number,
): Buffer {
  const rand = seededRandom(`${BRAND_BACKGROUND_GENERATOR_VERSION}|grain|${seed}`);
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    // Suma de dos uniformes: triangular, más parecida a grano de película.
    const v = Math.round(128 + (rand() + rand() - 1) * amplitude * 2);
    const clamped = v < 0 ? 0 : v > 255 ? 255 : v;
    const o = i * 3;
    out[o] = clamped;
    out[o + 1] = clamped;
    out[o + 2] = clamped;
  }
  return out;
}

/** La parte de una caja que cae dentro del canvas, para `composite` de sharp. */
function clipToCanvas(
  layer: BlobLayer,
  canvasWidth: number,
  canvasHeight: number,
): {
  left: number;
  top: number;
  width: number;
  height: number;
  x: number;
  y: number;
} | null {
  const x = Math.max(0, -layer.left);
  const y = Math.max(0, -layer.top);
  const width = Math.min(layer.width, canvasWidth - layer.left) - x;
  const height = Math.min(layer.height, canvasHeight - layer.top) - y;
  if (width <= 0 || height <= 0) return null;
  return { left: layer.left + x, top: layer.top + y, width, height, x, y };
}

/** La imagen: todas las capas en un solo pipeline, a JPEG. */
export async function renderBackgroundImage(
  spec: BackgroundSpec,
  seed: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const base = await renderBaseLayer(spec, width, height);
  const overlays: OverlayOptions[] = [];

  for (const blob of spec.blobs) {
    const layer = await renderBlobLayer(blob, spec, width, height);
    const clip = clipToCanvas(layer, width, height);
    if (clip === null) continue;
    // sharp no acepta un overlay más grande que el canvas: se recorta la caja.
    const cropped = await sharp(layer.data, {
      raw: { width: layer.width, height: layer.height, channels: 4 },
    })
      .extract({ left: clip.x, top: clip.y, width: clip.width, height: clip.height })
      .raw()
      .toBuffer();
    overlays.push({
      input: cropped,
      raw: { width: clip.width, height: clip.height, channels: 4 },
      left: clip.left,
      top: clip.top,
    });
  }

  overlays.push({ input: await renderVignetteLayer(spec, width, height) });
  if (spec.grain > 0) {
    overlays.push({
      input: grainBuffer(seed, spec.grain, width, height),
      raw: { width, height, channels: 3 },
      blend: "soft-light",
    });
  }

  return sharp(base)
    .composite(overlays)
    .removeAlpha()
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

/* ------------------------------------------------------------------------ *
 * Video (FFmpeg)
 * ------------------------------------------------------------------------ */

export interface VideoLayerFiles {
  readonly basePath: string;
  readonly vignettePath: string;
  readonly blobs: readonly {
    readonly path: string;
    readonly left: number;
    readonly top: number;
    readonly blob: BlobSpec;
  }[];
}

export interface VideoPlan {
  readonly args: readonly string[];
  readonly frames: number;
}

/** Tres decimales, sin notación exponencial: va dentro de un filtergraph. */
const f3 = (n: number): string => n.toFixed(3);

/**
 * El argv del loop. Puro: sin disco ni red. Es lo que el golden de plan compara.
 *
 * Cada mancha es un `overlay` con `eval=frame` cuya posición es
 * `left0 + A·sin(h·2π·t/D + φ)`, la misma fórmula que `blobOffsetAt`. El grano
 * es `noise` temporal con semilla fija (`all_seed`): determinista, y sin él el
 * degradé en yuv420p de 8 bits muestra bandas.
 */
export function planBackgroundVideo(
  spec: BackgroundSpec,
  layers: VideoLayerFiles,
  canvas: { readonly width: number; readonly height: number },
  durationSeconds: number,
  outputPath: string,
  noiseSeed: number,
): VideoPlan {
  const frames = durationSeconds * VIDEO_FPS;
  const inputs: string[] = [];
  const addInput = (file: string): void => {
    inputs.push("-loop", "1", "-framerate", String(VIDEO_FPS), "-i", file);
  };
  addInput(layers.basePath);
  for (const layer of layers.blobs) addInput(layer.path);
  addInput(layers.vignettePath);

  const graph: string[] = [`[0:v]format=rgba,setsar=1[s0]`];
  layers.blobs.forEach((layer, i) => {
    const b = layer.blob;
    const ax = b.orbitX * canvas.width;
    const ay = b.orbitY * canvas.height;
    const w = `2*PI*t/${String(durationSeconds)}`;
    const x = `${String(layer.left)}+${f3(ax)}*sin(${String(b.harmonicX)}*${w}+${f3(b.phaseX)})`;
    const y = `${String(layer.top)}+${f3(ay)}*cos(${String(b.harmonicY)}*${w}+${f3(b.phaseY)})`;
    graph.push(
      `[s${String(i)}][${String(i + 1)}:v]overlay=x='${x}':y='${y}':eval=frame:format=rgb[s${String(i + 1)}]`,
    );
  });
  const last = layers.blobs.length;
  const vignetteInput = last + 1;
  const grain = Math.max(1, Math.round(spec.grain * 0.6));
  graph.push(
    `[s${String(last)}][${String(vignetteInput)}:v]overlay=0:0:format=rgb,` +
      `format=yuv420p,noise=alls=${String(grain)}:allf=t:all_seed=${String(noiseSeed)}[v]`,
  );

  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputs,
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[v]",
    "-frames:v",
    String(frames),
    "-r",
    String(VIDEO_FPS),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    // Un cuadro clave por segundo: el loop se puede cortar en cualquier
    // segundo sin arrastrar un GOP entero.
    "-g",
    String(VIDEO_FPS),
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  return { args, frames };
}

/** Semilla del `noise` de FFmpeg: entero positivo derivado de la semilla. */
export function noiseSeedOf(seed: string): number {
  const digest = createHash("sha256").update(`noise|${seed}`, "utf8").digest();
  return (digest.readUInt32LE(0) % 2_000_000_000) + 1;
}

export async function renderBackgroundVideo(
  spec: BackgroundSpec,
  seed: string,
  durationSeconds: number,
  workDir: string,
  outputPath: string,
  caps: FfmpegCapabilities,
): Promise<void> {
  requireFilters(caps, VIDEO_FILTERS);
  const canvas = BACKGROUND_CANVASES["9:16"];

  const basePath = path.join(workDir, "base.png");
  await writeFile(basePath, await renderBaseLayer(spec, canvas.width, canvas.height));
  const vignettePath = path.join(workDir, "vignette.png");
  await writeFile(
    vignettePath,
    await renderVignetteLayer(spec, canvas.width, canvas.height),
  );

  const blobs: { path: string; left: number; top: number; blob: BlobSpec }[] = [];
  for (const [i, blob] of spec.blobs.entries()) {
    const layer = await renderBlobLayer(blob, spec, canvas.width, canvas.height);
    const file = path.join(workDir, `blob-${String(i)}.png`);
    await writeFile(
      file,
      await sharp(layer.data, {
        raw: { width: layer.width, height: layer.height, channels: 4 },
      })
        .png()
        .toBuffer(),
    );
    blobs.push({ path: file, left: layer.left, top: layer.top, blob });
  }

  const plan = planBackgroundVideo(
    spec,
    { basePath, vignettePath, blobs },
    canvas,
    durationSeconds,
    outputPath,
    noiseSeedOf(seed),
  );
  // Un loop de 10 s a 1080×1920 tarda segundos; el techo es el de un build.
  await runFfmpeg(plan.args, { expectOutput: outputPath });
}

/* ------------------------------------------------------------------------ *
 * La operación HTTP
 * ------------------------------------------------------------------------ */

function parseRequest(raw: unknown): BrandBackgroundRequest {
  const parsed = brandBackgroundRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RenderError("bad_request", "el pedido no es válido", {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}

/** Ver la cabecera: sin URLs, lo único que se autoriza es al que pide. */
function authorize(request: BrandBackgroundRequest, config: RenderEngineConfig): void {
  if (request.grant !== undefined) {
    verifyGrant(request.grant, config.policy);
    return;
  }
  if (config.policy.requireGrant) {
    throw new RenderError(
      "media_grant_invalid",
      "este despliegue exige un grant firmado para generar fondos",
    );
  }
}

/** La clave de cache: todo lo que decide los bytes, más la versión del motor. */
export function brandBackgroundKey(
  version: string,
  request: Pick<BrandBackgroundRequest, "palette" | "seed" | "kind" | "aspectRatio"> & {
    readonly durationSeconds: number | null;
  },
): string {
  return createHash("sha256")
    .update(
      [
        version,
        "brand-background",
        BRAND_BACKGROUND_GENERATOR_VERSION,
        request.kind,
        request.aspectRatio,
        request.durationSeconds === null ? "still" : String(request.durationSeconds),
        normalizePalette(request.palette).join(","),
        request.seed,
      ].join("|"),
      "utf8",
    )
    .digest("hex");
}

export async function brandBackgroundOperation(
  raw: unknown,
  config: RenderEngineConfig,
): Promise<BrandBackgroundResponse> {
  const request = parseRequest(raw);
  authorize(request, config);

  const caps = config.capabilities ?? (await probeCapabilities());
  const version = (await engineVersion(caps)).version;
  const canvas = BACKGROUND_CANVASES[request.aspectRatio];
  const isVideo = request.kind === "video";
  const duration = isVideo ? (request.durationSeconds ?? DEFAULT_VIDEO_SECONDS) : null;
  const extension: ArtifactExtension = isVideo ? "mp4" : "jpg";
  const contentType = isVideo ? "video/mp4" : "image/jpeg";
  const key = brandBackgroundKey(version, { ...request, durationSeconds: duration });
  const spec = planBackground(request.palette, request.seed);

  const describe = async (
    filePath: string,
    bytes: number,
    cache: CacheState,
    cacheKey: string,
  ): Promise<BrandBackgroundResponse> => {
    if (!isVideo) {
      return {
        contentType,
        sizeBytes: bytes,
        width: canvas.width,
        height: canvas.height,
        cacheKey,
        extension,
        cache,
        warnings: [],
      };
    }
    // Se mide la salida: es lo que el puerto promete, no lo que se pidió.
    const info = await probeMedia(filePath);
    if (info.width === null || info.height === null) {
      throw new RenderError(
        "render_empty_output",
        "el loop generado no declara dimensiones",
      );
    }
    return {
      contentType,
      sizeBytes: bytes,
      width: info.width,
      height: info.height,
      ...(info.durationSeconds === null ? {} : { durationSeconds: info.durationSeconds }),
      cacheKey,
      extension,
      cache,
      warnings: [],
    };
  };

  const cached = await config.cache.get(key, extension);
  if (cached !== null) return describe(cached.path, cached.bytes, "hit", cached.key);

  const workDir = await mkdtemp(path.join(tmpdir(), "fastgram-brand-bg-"));
  try {
    const outputPath = path.join(workDir, `out.${extension}`);
    if (isVideo) {
      await renderBackgroundVideo(
        spec,
        request.seed,
        duration ?? DEFAULT_VIDEO_SECONDS,
        workDir,
        outputPath,
        caps,
      );
    } else {
      await writeFile(
        outputPath,
        await renderBackgroundImage(spec, request.seed, canvas.width, canvas.height),
      );
    }
    const entry = await config.cache.adopt(key, extension, outputPath);
    return await describe(entry.path, entry.bytes, "miss", entry.key);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
