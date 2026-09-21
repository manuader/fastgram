/**
 * Canvas y aspect ratios.
 *
 * `F-068` / `FR-050`: `aspectRatio` ∈ {1:1, 4:5, 3:4, 9:16}, sólo aplica a
 * slideshow, default `4:5` (`FR-070`: "para slideshows la ratio objetivo por
 * defecto es 4:5").
 */
import { z } from "zod";

export const ASPECT_RATIOS = ["1:1", "4:5", "3:4", "9:16"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** `FR-070`: la ratio por defecto del slideshow. */
export const DEFAULT_SLIDESHOW_ASPECT: AspectRatio = "4:5";

/** `FR-070` usa 1080×1920 como ejemplo de canvas; 1080 de ancho es la base. */
export const DEFAULT_CANVAS_WIDTH = 1080;

export const ASPECT_RATIO_FRACTIONS: Readonly<
  Record<AspectRatio, readonly [number, number]>
> = {
  "1:1": [1, 1],
  "4:5": [4, 5],
  "3:4": [3, 4],
  "9:16": [9, 16],
};

export const aspectRatioSchema = z.enum(ASPECT_RATIOS);

export const canvasSchema = z
  .object({
    width: z.number().int().min(16).max(4096),
    height: z.number().int().min(16).max(4096),
  })
  .strict();

export type Canvas = z.infer<typeof canvasSchema>;

/**
 * Los encoders H.264 en yuv420p exigen dimensiones pares. Se redondea hacia
 * abajo al par más cercano en vez de dejar que ffmpeg falle con
 * `width not divisible by 2`.
 */
export function toEvenDimension(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

export function canvasForAspect(
  aspect: AspectRatio,
  width: number = DEFAULT_CANVAS_WIDTH,
): Canvas {
  const fraction = ASPECT_RATIO_FRACTIONS[aspect];
  const w = toEvenDimension(width);
  const h = toEvenDimension((w * fraction[1]) / fraction[0]);
  return { width: w, height: h };
}

/** Ratio efectiva de un canvas concreto, con tolerancia de 1 px por el redondeo a par. */
export function aspectOfCanvas(canvas: Canvas): AspectRatio | null {
  for (const aspect of ASPECT_RATIOS) {
    const expected = canvasForAspect(aspect, canvas.width);
    if (Math.abs(expected.height - canvas.height) <= 1) return aspect;
  }
  return null;
}
