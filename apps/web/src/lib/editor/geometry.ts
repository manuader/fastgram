/**
 * Geometría del editor · `PU-EDIT-004`, FR-051, decisiones del dueño
 * 2026-09-23 (escala 360) y 2026-09-24 (centro + ancho).
 *
 * ## Qué tiene que coincidir con el render, y dónde vive allá
 *
 * El preview sólo sirve si **lo que se ve es lo que sale**. Estas funciones son
 * la réplica, del lado del cliente, de tres piezas del servidor:
 *
 * | acá                         | allá                                                        |
 * |-----------------------------|-------------------------------------------------------------|
 * | {@link editorUnitsToCanvasPx} | `services/render/src/domain/text.ts` · `editorUnitsToCanvasPx` |
 * | {@link boxToCanvasGeometry}   | `packages/core/src/content/text-boxes-to-build-payload.ts` · `textBoxToBuildText` (centro + ancho en px de canvas) |
 * | {@link BACKGROUND_PADDING_RATIO} | `services/render/src/render/textLayer.ts`                |
 *
 * `apps/web` no puede importar `core` ni el servicio (dependency-cruiser), así
 * que la fórmula se repite. Lo que impide que se separen son los tests: fijan
 * los **mismos números literales** que los tests de `core` (1080×1350, caja
 * (50,50) al 80 % → centro (540, 675), ancho 864; `18` → 54 px en 1080). Si
 * alguien cambia el mapeo de un lado, el test de este lado deja de coincidir
 * con el del otro y hay que mirarlo.
 *
 * ## El preview no es una foto del canvas en píxeles de canvas
 *
 * El lienzo del editor se dibuja a `previewWidth` px (360 por defecto: a esa
 * escala las unidades de editor **son** píxeles). Todo lo que el render
 * calcula en px de canvas se multiplica por `previewWidth / canvas.width` —
 * incluido el redondeo a entero de la fuente, que se hace **antes** de escalar,
 * igual que en el render.
 */
import type { ContentTextBox } from "@fastgram/contracts";
import {
  TEXT_POSITION_MAX,
  TEXT_POSITION_MIN,
  TEXT_WIDTH_PERCENT_MAX,
  TEXT_WIDTH_PERCENT_MIN,
} from "@fastgram/contracts";

/** Ancho de referencia de las unidades de editor (FR-070, decisión 2026-09-23). */
export const EDITOR_REFERENCE_WIDTH = 360;

/** Padding del fondo, en múltiplos del tamaño de fuente (`textLayer.ts`). */
export const BACKGROUND_PADDING_RATIO = 0.35;

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

/** Unidades de editor → px de canvas, redondeado a entero. Igual que el render. */
export function editorUnitsToCanvasPx(units: number, canvasWidth: number): number {
  return Math.round((units * canvasWidth) / EDITOR_REFERENCE_WIDTH);
}

/** Cuatro decimales, como `round4` de `core`. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** La caja en px de canvas: lo que el payload de build lleva (`FR-070`). */
export interface CanvasBoxGeometry {
  /** Centro de la caja. */
  readonly x: number;
  readonly y: number;
  /** Ancho de la caja. */
  readonly width: number;
  readonly fontSizePx: number;
  readonly strokeWidthPx: number;
}

/**
 * Caja → geometría en px de canvas. `x`/`y`/`width` son exactamente los de
 * `textBoxToBuildText`; `fontSizePx`/`strokeWidthPx` los de `renderTextBox`
 * (que es donde se escala, no en el payload).
 */
export function boxToCanvasGeometry(
  box: Pick<ContentTextBox, "position" | "widthPercent" | "font" | "stroke">,
  canvas: CanvasSize,
): CanvasBoxGeometry {
  return {
    x: round4((box.position.x * canvas.width) / 100),
    y: round4((box.position.y * canvas.height) / 100),
    width: round4((box.widthPercent * canvas.width) / 100),
    fontSizePx: Math.max(1, editorUnitsToCanvasPx(box.font.size, canvas.width)),
    strokeWidthPx: Math.max(0, editorUnitsToCanvasPx(box.stroke.width, canvas.width)),
  };
}

/** Cuánto mide un px de canvas en el preview. */
export function previewScale(previewWidth: number, canvas: CanvasSize): number {
  return previewWidth / canvas.width;
}

/** Alto del preview para un ancho dado, manteniendo el aspecto del canvas. */
export function previewHeight(previewWidth: number, canvas: CanvasSize): number {
  return (previewWidth * canvas.height) / canvas.width;
}

/** La caja en px **del preview**, lista para `style`. */
export interface PreviewBoxGeometry {
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  /** Ancho útil para el wrap: el contorno crece hacia afuera (`textLayer.ts`). */
  readonly wrapWidth: number;
  readonly fontSize: number;
  readonly strokeWidth: number;
  readonly backgroundPadding: number;
}

export function boxToPreviewGeometry(
  box: Pick<ContentTextBox, "position" | "widthPercent" | "font" | "stroke">,
  canvas: CanvasSize,
  previewWidth: number,
): PreviewBoxGeometry {
  const g = boxToCanvasGeometry(box, canvas);
  const s = previewScale(previewWidth, canvas);
  const wrapCanvas = Math.max(1, Math.round(g.width) - g.strokeWidthPx * 2);
  return {
    centerX: g.x * s,
    centerY: g.y * s,
    width: g.width * s,
    wrapWidth: wrapCanvas * s,
    fontSize: g.fontSizePx * s,
    strokeWidth: g.strokeWidthPx * s,
    backgroundPadding: Math.round(g.fontSizePx * BACKGROUND_PADDING_RATIO) * s,
  };
}

// --- Movimiento ---------------------------------------------------------------

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

/** Dos decimales: suficiente para el ojo y estable para comparar ediciones. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Un desplazamiento en px del preview, en % del canvas. */
export function pointerDeltaToPercent(
  dxPx: number,
  dyPx: number,
  previewSize: CanvasSize,
): { readonly dx: number; readonly dy: number } {
  return {
    dx: (dxPx / previewSize.width) * 100,
    dy: (dyPx / previewSize.height) * 100,
  };
}

/** Mueve el centro de la caja, dentro de [0, 100] (FR-051). */
export function moveBox<B extends Pick<ContentTextBox, "position">>(
  box: B,
  dx: number,
  dy: number,
): B {
  return {
    ...box,
    position: {
      x: round2(clamp(box.position.x + dx, TEXT_POSITION_MIN, TEXT_POSITION_MAX)),
      y: round2(clamp(box.position.y + dy, TEXT_POSITION_MIN, TEXT_POSITION_MAX)),
    },
  };
}

/** Ancho de la caja, dentro de [25, 100] (FR-051). */
export function clampWidthPercent(widthPercent: number): number {
  return round2(clamp(widthPercent, TEXT_WIDTH_PERCENT_MIN, TEXT_WIDTH_PERCENT_MAX));
}

/**
 * Redimensionar desde el borde derecho: la caja crece **simétrica** alrededor
 * del centro (el centro no se mueve, es lo que guarda `position`), así que
 * arrastrar el borde `d` px agrega `2·d` px de ancho.
 */
export function resizeFromEdge(
  widthPercent: number,
  dxPx: number,
  previewWidth: number,
): number {
  return clampWidthPercent(widthPercent + ((2 * dxPx) / previewWidth) * 100);
}

/** Paso de las flechas: 1 %, con Shift 5 % (brief de `PU-EDIT-003`). */
export const NUDGE_STEP = 1;
export const NUDGE_STEP_LARGE = 5;

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** `null` si la tecla no es una flecha. */
export function nudgeFor(
  key: string,
  shift: boolean,
): { readonly dx: number; readonly dy: number } | null {
  const dir = ARROWS[key];
  if (dir === undefined) return null;
  const step = shift ? NUDGE_STEP_LARGE : NUDGE_STEP;
  return { dx: dir[0] * step, dy: dir[1] * step };
}

// --- Media --------------------------------------------------------------------

export interface DrawRect {
  readonly drawX: number;
  readonly drawY: number;
  readonly drawW: number;
  readonly drawH: number;
}

/**
 * Zoom del video del green-screen (`FR-051`, `Zoom: 100%`), sobre el rectángulo
 * base y **alrededor del centro del rectángulo actual**, para que hacer zoom no
 * deshaga lo que el usuario ya arrastró.
 */
export function zoomRect(base: DrawRect, current: DrawRect, zoom: number): DrawRect {
  const w = base.drawW * zoom;
  const h = base.drawH * zoom;
  const cx = current.drawX + current.drawW / 2;
  const cy = current.drawY + current.drawH / 2;
  return {
    drawX: Math.round(cx - w / 2),
    drawY: Math.round(cy - h / 2),
    drawW: Math.round(w),
    drawH: Math.round(h),
  };
}

/** Arrastrar el video: px del preview → px de canvas. */
export function panRect(
  rect: DrawRect,
  dxPx: number,
  dyPx: number,
  previewWidth: number,
  canvas: CanvasSize,
): DrawRect {
  const s = previewScale(previewWidth, canvas);
  return {
    ...rect,
    drawX: Math.round(rect.drawX + dxPx / s),
    drawY: Math.round(rect.drawY + dyPx / s),
  };
}

/** El zoom actual respecto del rectángulo base, en %. */
export function zoomPercentOf(base: DrawRect, current: DrawRect): number {
  if (base.drawW <= 0) return 100;
  return Math.round((current.drawW / base.drawW) * 100);
}

// --- Fondo del texto ----------------------------------------------------------

export interface RenderedBackground {
  readonly color: string;
  readonly radius: "pill";
}

/**
 * El fondo **que sale en el video**, no el que dice la caja.
 *
 * Hoy el camino editor → render pierde dos atributos (cabecera de
 * `core/content/text-boxes-to-build-payload.ts`): el payload de `FR-070` sólo
 * lleva `backgroundColor`, y el adaptador (`render-wire.ts`, `DEFAULT_MAPPING`)
 * lo dibuja como `pill` opaco. La única excepción es opacidad 0, que `core`
 * trata como sin fondo. El preview hace lo mismo —si no, mostraría un fondo
 * translúcido que el video no tiene— y el inspector lo avisa.
 */
export function renderedBackground(
  background: ContentTextBox["background"],
): RenderedBackground | null {
  if (background === null || background.opacity <= 0) return null;
  return { color: background.color, radius: "pill" };
}
