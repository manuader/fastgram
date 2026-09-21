/**
 * `P2-RENDER-012` / `EXT-006` — Recorte inteligente en vez de estirar al canvas.
 *
 * `FR-070` documenta el comportamiento del original: "el build v1 usa
 * stretch-to-canvas (se distorsionan si no coinciden)" y exige que el clon
 * "implemente el mismo contrato o lo mejore explícitamente". Acá se mejora
 * explícitamente: el default es `cover` (escalar preservando aspecto y recortar
 * el excedente) y `stretch` queda disponible como opt-in para paridad con v1.
 *
 * El punto focal (`focal`, 0–100 en cada eje, default centro 50/50) decide qué
 * parte sobrevive al recorte. Toda la geometría es entera y determinista: es
 * parte de la clave de cache y de los golden files.
 */
import { z } from "zod";

export const fitModeSchema = z.enum(["cover", "contain", "stretch"]);
export type FitMode = z.infer<typeof fitModeSchema>;

/** `EXT-006`: por defecto se recorta, no se deforma. */
export const DEFAULT_FIT_MODE: FitMode = "cover";

export const focalPointSchema = z
  .object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
  })
  .strict();

export type FocalPoint = z.infer<typeof focalPointSchema>;

export const CENTER_FOCAL: FocalPoint = { x: 50, y: 50 };

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Placement {
  /** Recorte a aplicar sobre la fuente, en píxeles de la fuente. */
  readonly crop: Rect;
  /** Destino dentro del canvas, en píxeles del canvas. */
  readonly draw: Rect;
  readonly mode: FitMode;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Calcula recorte + destino para meter `source` dentro de `target`.
 *
 * - `cover`   → escala al máximo que cubre `target` y recorta alrededor del focal.
 * - `contain` → escala al mínimo que entra en `target` y centra (deja banda).
 * - `stretch` → deforma hasta `target` (paridad v1 de `FR-070`).
 */
export function computePlacement(
  source: Size,
  target: Rect,
  mode: FitMode = DEFAULT_FIT_MODE,
  focal: FocalPoint = CENTER_FOCAL,
): Placement {
  if (source.width <= 0 || source.height <= 0) {
    throw new RangeError("source debe tener ancho y alto positivos");
  }

  if (mode === "stretch") {
    return {
      crop: { x: 0, y: 0, width: source.width, height: source.height },
      draw: target,
      mode,
    };
  }

  if (mode === "contain") {
    const scale = Math.min(target.width / source.width, target.height / source.height);
    const drawW = Math.max(1, Math.round(source.width * scale));
    const drawH = Math.max(1, Math.round(source.height * scale));
    return {
      crop: { x: 0, y: 0, width: source.width, height: source.height },
      draw: {
        x: target.x + Math.round((target.width - drawW) / 2),
        y: target.y + Math.round((target.height - drawH) / 2),
        width: drawW,
        height: drawH,
      },
      mode,
    };
  }

  // cover: la ventana de recorte tiene la ratio del destino y el mayor tamaño posible.
  const targetRatio = target.width / target.height;
  const sourceRatio = source.width / source.height;

  let cropW = source.width;
  let cropH = source.height;
  if (sourceRatio > targetRatio) {
    // La fuente es más ancha: se recorta a los costados.
    cropW = Math.max(1, Math.round(source.height * targetRatio));
  } else if (sourceRatio < targetRatio) {
    // La fuente es más alta: se recorta arriba y abajo.
    cropH = Math.max(1, Math.round(source.width / targetRatio));
  }

  const maxX = source.width - cropW;
  const maxY = source.height - cropH;
  // El focal marca el CENTRO de la ventana de recorte.
  const cropX = clampInt((focal.x / 100) * source.width - cropW / 2, 0, maxX);
  const cropY = clampInt((focal.y / 100) * source.height - cropH / 2, 0, maxY);

  return {
    crop: { x: cropX, y: cropY, width: cropW, height: cropH },
    draw: target,
    mode,
  };
}
