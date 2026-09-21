/**
 * Planes de render de los cuatro formatos base (`P2-RENDER-004` … `007`).
 *
 * Un "plan" es la lista exacta de argumentos que recibirá ffmpeg, más la
 * geometría resuelta. Se calcula ANTES de ejecutar nada:
 *
 *  · es lo que hashean los golden tests (`P2-RENDER-011`): mismo payload ⇒
 *    mismo plan, y un cambio de filtergraph salta en el diff sin comparar
 *    píxeles;
 *  · deja el pipeline auditable sin correr ffmpeg;
 *  · permite fallar por capacidad faltante antes de gastar CPU.
 *
 * ── El corte en dos pasadas ──────────────────────────────────────────────────
 * El texto NO entra en la pasada pesada. Cada formato produce primero una
 * **base** sin texto (recorte, escalado, croma, apilado, audio) que se cachea
 * por `mediaKey`, y después una pasada liviana que superpone el PNG del
 * overlay y se cachea por `buildKey`. Es exactamente la palanca de IMPL §5: si
 * sólo cambió el texto, la base se reutiliza y no se re-encodea el fondo.
 *
 * `slideshow` no tiene plan de ffmpeg: es un carrusel de imágenes y se resuelve
 * entero con sharp (`F-070`: "Multi-image carousel with captions").
 */
import type { Canvas } from "../domain/canvas.js";
import { toEvenDimension } from "../domain/canvas.js";
import {
  CENTER_FOCAL,
  computePlacement,
  type Placement,
  type Size,
} from "../domain/fit.js";
import type {
  GreenScreenPayload,
  MediaRef,
  VideoHookPayload,
  WallOfTextPayload,
} from "../domain/payload.js";
import {
  chromaFilterName,
  requireFilters,
  type FfmpegCapabilities,
} from "../ffmpeg/capabilities.js";

/** Frame rate de salida. El PRD no lo fija: elección del servicio. ABIERTO. */
export const OUTPUT_FPS = 30;

export interface FfmpegPlan {
  readonly args: readonly string[];
  readonly filterGraph: string;
  readonly placements: Readonly<Record<string, Placement>>;
  /** `true` si la salida lleva pista de audio. */
  readonly hasAudio: boolean;
}

export interface SourceGeometry extends Size {
  readonly durationSeconds: number | null;
  readonly hasAudio: boolean;
}

function targetRect(
  canvas: Canvas,
  ref: MediaRef,
): { x: number; y: number; width: number; height: number } {
  if (ref.draw !== undefined) {
    return {
      x: ref.draw.x,
      y: ref.draw.y,
      width: toEvenDimension(ref.draw.width),
      height: toEvenDimension(ref.draw.height),
    };
  }
  return { x: 0, y: 0, width: canvas.width, height: canvas.height };
}

export function placeMedia(canvas: Canvas, ref: MediaRef, source: Size): Placement {
  return computePlacement(
    source,
    targetRect(canvas, ref),
    ref.fit,
    ref.focal ?? CENTER_FOCAL,
  );
}

/** `crop=…,scale=…,setsar=1` que materializa un `Placement`. */
export function placementFilter(placement: Placement): string {
  const { crop, draw } = placement;
  return [
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    `scale=${draw.width}:${draw.height}:flags=lanczos`,
    "setsar=1",
  ].join(",");
}

function baseArgs(): string[] {
  return ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
}

function encodeArgs(): string[] {
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(OUTPUT_FPS),
    "-movflags",
    "+faststart",
  ];
}

/**
 * Sin `overlay`, `scale`, `crop` o `setsar` no hay pipeline posible: se falla
 * acá, antes de gastar CPU, con un código estable.
 */
function requireBaseFilters(caps: FfmpegCapabilities): void {
  requireFilters(caps, ["overlay", "scale", "crop", "setsar"]);
}

function colorSource(canvas: Canvas, label: string): string {
  return `color=c=black:s=${canvas.width}x${canvas.height}:r=${OUTPUT_FPS}[${label}]`;
}

// ── wall-of-text (`P2-RENDER-005`) ───────────────────────────────────────────
// `FR-070`: `{canvas, video{url,draw…}, audio{url}, text}`.

export interface WallOfTextInputs {
  readonly videoPath: string;
  readonly audioPath: string;
  readonly outputPath: string;
  readonly video: SourceGeometry;
}

export function planWallOfTextBase(
  payload: WallOfTextPayload,
  inputs: WallOfTextInputs,
  caps: FfmpegCapabilities,
): FfmpegPlan {
  requireBaseFilters(caps);
  const canvas = payload.canvas;
  const placement = placeMedia(canvas, payload.video, inputs.video);
  const graph = [
    colorSource(canvas, "bg"),
    `[0:v]${placementFilter(placement)}[src]`,
    `[bg][src]overlay=${placement.draw.x}:${placement.draw.y}:shortest=1[v]`,
  ].join(";");

  const args = [
    ...baseArgs(),
    "-i",
    inputs.videoPath,
    "-i",
    inputs.audioPath,
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    "-map",
    "1:a",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    ...encodeArgs(),
    inputs.outputPath,
  ];
  return { args, filterGraph: graph, placements: { video: placement }, hasAudio: true };
}

// ── green-screen (`P2-RENDER-006`) ───────────────────────────────────────────
// `FR-070`: el video con croma se compone SOBRE la imagen de fondo.

export interface GreenScreenInputs {
  readonly backgroundPath: string;
  readonly videoPath: string;
  readonly outputPath: string;
  readonly background: Size;
  readonly video: SourceGeometry;
}

export function planGreenScreenBase(
  payload: GreenScreenPayload,
  inputs: GreenScreenInputs,
  caps: FfmpegCapabilities,
): FfmpegPlan {
  requireBaseFilters(caps);
  const chroma = chromaFilterName(caps);
  const canvas = payload.canvas;
  const bgPlacement = placeMedia(canvas, payload.image, inputs.background);
  const fgPlacement = placeMedia(canvas, payload.video, inputs.video);
  const key = payload.chromaKey;
  // ffmpeg quiere `0xRRGGBB`, no `#RRGGBB`.
  const keyColor = `0x${key.color.slice(1)}`;

  const graph = [
    colorSource(canvas, "canvas"),
    `[0:v]${placementFilter(bgPlacement)}[bg]`,
    `[canvas][bg]overlay=${bgPlacement.draw.x}:${bgPlacement.draw.y}[base]`,
    `[1:v]${chroma}=${keyColor}:${key.similarity}:${key.blend},${placementFilter(fgPlacement)}[fg]`,
    `[base][fg]overlay=${fgPlacement.draw.x}:${fgPlacement.draw.y}:shortest=1[v]`,
  ].join(";");

  const args = [
    ...baseArgs(),
    "-loop",
    "1",
    "-framerate",
    String(OUTPUT_FPS),
    "-i",
    inputs.backgroundPath,
    "-i",
    inputs.videoPath,
    "-filter_complex",
    graph,
    "-map",
    "[v]",
  ];
  if (inputs.video.hasAudio) args.push("-map", "1:a", "-c:a", "aac", "-b:a", "128k");
  else args.push("-an");
  args.push("-shortest", ...encodeArgs(), inputs.outputPath);

  return {
    args,
    filterGraph: graph,
    placements: { background: bgPlacement, video: fgPlacement },
    hasAudio: inputs.video.hasAudio,
  };
}

// ── video-hook (`P2-RENDER-007`) ─────────────────────────────────────────────
// `FR-070`: hook arriba, demo abajo, más audio.

export interface VideoHookInputs {
  readonly hookPath: string;
  readonly demoPath: string;
  readonly audioPath: string;
  readonly outputPath: string;
  readonly hook: SourceGeometry;
  readonly demo: SourceGeometry;
}

export function planVideoHookBase(
  payload: VideoHookPayload,
  inputs: VideoHookInputs,
  caps: FfmpegCapabilities,
): FfmpegPlan {
  requireBaseFilters(caps);
  const canvas = payload.canvas;
  const hookHeight = toEvenDimension(canvas.height * payload.hookHeightRatio);
  const demoHeight = toEvenDimension(canvas.height - hookHeight);

  const hookPlacement = computePlacement(
    inputs.hook,
    payload.hookVideo.draw ?? { x: 0, y: 0, width: canvas.width, height: hookHeight },
    payload.hookVideo.fit,
    payload.hookVideo.focal ?? CENTER_FOCAL,
  );
  const demoPlacement = computePlacement(
    inputs.demo,
    payload.demoVideo.draw ?? {
      x: 0,
      y: hookHeight,
      width: canvas.width,
      height: demoHeight,
    },
    payload.demoVideo.fit,
    payload.demoVideo.focal ?? CENTER_FOCAL,
  );

  const graph = [
    colorSource(canvas, "canvas"),
    `[0:v]${placementFilter(hookPlacement)}[hook]`,
    `[1:v]${placementFilter(demoPlacement)}[demo]`,
    `[canvas][hook]overlay=${hookPlacement.draw.x}:${hookPlacement.draw.y}[withHook]`,
    `[withHook][demo]overlay=${demoPlacement.draw.x}:${demoPlacement.draw.y}:shortest=1[v]`,
  ].join(";");

  const args = [
    ...baseArgs(),
    "-i",
    inputs.hookPath,
    "-i",
    inputs.demoPath,
    "-i",
    inputs.audioPath,
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    "-map",
    "2:a",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    ...encodeArgs(),
    inputs.outputPath,
  ];

  return {
    args,
    filterGraph: graph,
    placements: { hook: hookPlacement, demo: demoPlacement },
    hasAudio: true,
  };
}

// ── Pasada de overlay (liviana, cacheada por `buildKey`) ─────────────────────

/**
 * Superpone el PNG de texto sobre una base ya encodeada. El audio se copia sin
 * recodificar: esta pasada no toca el sonido.
 */
export function planTextOverlayPass(
  basePath: string,
  overlayPath: string,
  outputPath: string,
  hasAudio: boolean,
  caps: FfmpegCapabilities,
): FfmpegPlan {
  requireFilters(caps, ["overlay"]);
  const graph = "[0:v][1:v]overlay=0:0:format=auto[v]";
  const args = [
    ...baseArgs(),
    "-i",
    basePath,
    "-i",
    overlayPath,
    "-filter_complex",
    graph,
    "-map",
    "[v]",
  ];
  if (hasAudio) args.push("-map", "0:a", "-c:a", "copy");
  else args.push("-an");
  args.push(...encodeArgs(), outputPath);
  return { args, filterGraph: graph, placements: {}, hasAudio };
}
