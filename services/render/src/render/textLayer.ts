/**
 * Composición del texto con `sharp`, a PNG RGBA, para superponer con `overlay`.
 *
 * NO se usa `drawtext`. Ver `ffmpeg/capabilities.ts` para la verificación y el
 * porqué: en esta máquina el filtro no existe y su ausencia es silenciosa.
 *
 * El texto se dibuja con el motor de texto de libvips (Pango + HarfBuzz +
 * FreeType), que da shaping y wrap de verdad. El contorno (`stroke` de
 * `FR-051`) no existe en Pango, así que se sintetiza componiendo el glifo en
 * color de contorno en un anillo de desplazamientos y encima el glifo en color
 * de relleno. Es determinista: la misma entrada da el mismo PNG byte a byte
 * (verificado antes de escribir este módulo).
 *
 * ── La escala de `font.size` y `stroke.width` ──────────────────────────────
 * Son unidades de editor (vista previa de 360 px), no píxeles del lienzo. La
 * conversión vive en `domain/text.ts` (`editorUnitsToCanvasPx`) y se aplica en
 * `renderTextBox`, que es el único camino del texto para los cuatro formatos
 * —cada slide del slideshow con su propio canvas—.
 */
import sharp from "sharp";
import type { Canvas } from "../domain/canvas.js";
import { editorUnitsToCanvasPx, type TextObject } from "../domain/text.js";
import { noteTextEngineUse } from "./fontActivation.js";
import { resolveFont, type FontLoaderOptions, type ResolvedFont } from "./fontLoader.js";

/** Padding del fondo, en múltiplos del tamaño de fuente. Elección del servicio. */
export const BACKGROUND_PADDING_RATIO = 0.35;

/**
 * Sin perilla de escala: el ancho de referencia es una constante de dominio.
 * Una opción por llamada no entraría en la clave de cache (`domain/hash.ts`) y
 * dos procesos podrían servirse frames de escalas distintas bajo la misma clave.
 */
export type TextLayerOptions = FontLoaderOptions;

export interface TextLayerGeometry {
  /** Ancho de la caja en píxeles de canvas (`widthPercent` resuelto). */
  readonly boxWidth: number;
  readonly fontSizePx: number;
  readonly strokeWidthPx: number;
  /** Rectángulo final del layer sobre el canvas. Puede salirse: se recorta. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface RenderedTextLayer {
  readonly id: string;
  readonly png: Buffer;
  readonly geometry: TextLayerGeometry;
  readonly font: ResolvedFont;
}

/** Escape de markup Pango. El texto del usuario NUNCA se interpola crudo. */
export function escapePango(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;")
    .replace(/"/g, "&quot;");
}

/**
 * Anillo de desplazamientos que sintetiza el contorno. Determinista y acotado
 * (máx. 48 por anillo) para que un `stroke.width: 8` no dispare cientos de
 * composiciones.
 */
export function strokeOffsets(radius: number): readonly (readonly [number, number])[] {
  if (radius <= 0) return [];
  const rings = radius > 3 ? [radius, radius * 0.55] : [radius];
  const seen = new Map<string, readonly [number, number]>();
  for (const r of rings) {
    const steps = Math.min(48, Math.max(8, Math.ceil((2 * Math.PI * r) / 1.5)));
    for (let index = 0; index < steps; index += 1) {
      const angle = (index / steps) * Math.PI * 2;
      const dx = Math.round(Math.cos(angle) * r);
      const dy = Math.round(Math.sin(angle) * r);
      if (dx === 0 && dy === 0) continue;
      seen.set(`${dx},${dy}`, [dx, dy]);
    }
  }
  return [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function pangoAlign(align: TextObject["align"]): "left" | "centre" | "right" {
  return align === "center" ? "centre" : align;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

async function renderGlyphs(
  markupText: string,
  font: ResolvedFont,
  colorHex: string,
  wrapWidth: number,
  align: TextObject["align"],
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const text: {
    text: string;
    font: string;
    rgba: boolean;
    dpi: number;
    width: number;
    align: "left" | "centre" | "right";
    wrap: "word";
  } = {
    text: `<span foreground="${colorHex}">${markupText}</span>`,
    font: font.pangoDescription,
    rgba: true,
    dpi: 72,
    width: wrapWidth,
    align: pangoAlign(align),
    wrap: "word",
  };
  // Sin `fontfile`: se ignora (ver fontLoader.ts). La familia resuelve por
  // nombre porque `fontActivation.ts` la activó al arrancar.
  noteTextEngineUse();
  const pipeline = sharp({ text });
  const { data, info } = await pipeline.png().toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/**
 * Renderiza una caja. Devuelve `null` cuando la caja no dibuja nada: `FR-051`
 * permite texto vacío, y una caja vacía no es un error.
 */
export async function renderTextBox(
  box: TextObject,
  canvas: Canvas,
  options: TextLayerOptions,
): Promise<RenderedTextLayer | null> {
  if (box.text.trim() === "") return null;

  const fontSizePx = Math.max(1, editorUnitsToCanvasPx(box.font.size, canvas.width));
  const strokeWidthPx = Math.max(
    0,
    editorUnitsToCanvasPx(box.stroke.width, canvas.width),
  );
  const boxWidth = Math.max(1, Math.round((canvas.width * box.widthPercent) / 100));
  // El contorno crece hacia afuera: el wrap usa el ancho útil.
  const wrapWidth = Math.max(1, boxWidth - strokeWidthPx * 2);

  const font = await resolveFont(box.font.family, box.font.weight, fontSizePx, options);
  const markup = escapePango(box.text);

  const fill = await renderGlyphs(markup, font, box.color, wrapWidth, box.align);

  const pad = strokeWidthPx;
  const glyphLeft = pad;
  const glyphTop = pad;
  /** El bloque de texto con su contorno, sin fondo. */
  const blockWidth = fill.width + pad * 2;
  let layerWidth = blockWidth;
  let layerHeight = fill.height + pad * 2;

  // ── Dónde cae el bloque (FR-051, decisión del dueño 2026-09-24) ─────────
  // `position` es el CENTRO de la caja, en % del lienzo; `widthPercent` es el
  // ancho de la caja. El texto hace wrap a ese ancho y la caja crece hacia
  // arriba y abajo desde el centro. Pango devuelve la imagen recortada al
  // texto (una línea corta sale más angosta que la caja), así que la
  // alineación se resuelve acá, contra la caja: `left` pega el bloque al borde
  // izquierdo de la caja, `right` al derecho, `center` lo centra en `x`. Antes
  // se centraba siempre en `x`, y `left`/`right` sólo alineaban las líneas
  // entre sí: una caja alineada a la izquierda no arrancaba donde el editor la
  // muestra.
  const centerX = (canvas.width * box.position.x) / 100;
  const centerY = (canvas.height * box.position.y) / 100;
  const boxLeft = centerX - boxWidth / 2;

  const composites: sharp.OverlayOptions[] = [];

  // Fondo (`FR-051`: pill | full-width | null).
  const fullWidth = box.background?.style === "full-width";
  let backgroundPadding = 0;
  if (box.background !== null) {
    backgroundPadding = Math.round(fontSizePx * BACKGROUND_PADDING_RATIO);
    const rgb = hexToRgb(box.background.color);
    const bgHeight = layerHeight + backgroundPadding * 2;
    const bgWidth = fullWidth ? canvas.width : layerWidth + backgroundPadding * 2;
    const radius = box.background.style === "pill" ? Math.round(bgHeight / 2) : 0;
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${bgWidth}" height="${bgHeight}">` +
        `<rect x="0" y="0" width="${bgWidth}" height="${bgHeight}" rx="${radius}" ry="${radius}" ` +
        `fill="rgb(${rgb.r},${rgb.g},${rgb.b})" fill-opacity="${box.background.opacity}"/></svg>`,
    );
    layerWidth = bgWidth;
    layerHeight = bgHeight;
    composites.push({ input: svg, left: 0, top: 0 });
  }

  // Ancho de lo que se alinea dentro de la caja: el bloque con su pill, o el
  // bloque solo cuando el fondo es una banda de lado a lado.
  const alignedWidth = fullWidth ? blockWidth : layerWidth;
  const alignedLeft =
    box.align === "left"
      ? boxLeft
      : box.align === "right"
        ? boxLeft + boxWidth - alignedWidth
        : centerX - alignedWidth / 2;

  // `full-width` es una banda de TODO el ancho del lienzo: la capa va en 0 y
  // el texto se corre adentro. Antes la banda se centraba en `x`, y con una
  // caja fuera del centro quedaba corrida y cortada de un lado. Se acota al
  // lienzo porque `composite` no acepta desplazamientos negativos.
  const layerLeft = fullWidth ? 0 : Math.round(alignedLeft);
  const contentLeft = fullWidth
    ? Math.min(
        Math.max(0, Math.round(alignedLeft)),
        Math.max(0, canvas.width - blockWidth),
      )
    : box.background === null
      ? 0
      : backgroundPadding;
  const contentTop =
    box.background === null ? 0 : Math.round((layerHeight - fill.height - pad * 2) / 2);

  if (strokeWidthPx > 0) {
    const strokeGlyphs = await renderGlyphs(
      markup,
      font,
      box.stroke.color,
      wrapWidth,
      box.align,
    );
    for (const [dx, dy] of strokeOffsets(strokeWidthPx)) {
      composites.push({
        input: strokeGlyphs.buffer,
        left: contentLeft + glyphLeft + dx,
        top: contentTop + glyphTop + dy,
      });
    }
  }
  composites.push({
    input: fill.buffer,
    left: contentLeft + glyphLeft,
    top: contentTop + glyphTop,
  });

  const png = await sharp({
    create: {
      width: layerWidth,
      height: layerHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();

  const left = layerLeft;
  const top = Math.round(centerY - layerHeight / 2);

  return {
    id: box.id,
    png,
    font,
    geometry: {
      boxWidth,
      fontSizePx,
      strokeWidthPx,
      left,
      top,
      width: layerWidth,
      height: layerHeight,
    },
  };
}

/** Recorta un layer que se sale del canvas para que `composite` lo acepte. */
async function clipToCanvas(
  layer: RenderedTextLayer,
  canvas: Canvas,
): Promise<sharp.OverlayOptions | null> {
  const { left, top, width, height } = layer.geometry;
  const visibleLeft = Math.max(0, left);
  const visibleTop = Math.max(0, top);
  const visibleRight = Math.min(canvas.width, left + width);
  const visibleBottom = Math.min(canvas.height, top + height);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;

  const needsClip =
    visibleLeft !== left ||
    visibleTop !== top ||
    visibleRight !== left + width ||
    visibleBottom !== top + height;

  if (!needsClip) return { input: layer.png, left, top };

  const clipped = await sharp(layer.png)
    .extract({
      left: visibleLeft - left,
      top: visibleTop - top,
      width: visibleRight - visibleLeft,
      height: visibleBottom - visibleTop,
    })
    .png()
    .toBuffer();
  return { input: clipped, left: visibleLeft, top: visibleTop };
}

export interface TextOverlay {
  /** PNG RGBA del tamaño exacto del canvas. */
  readonly png: Buffer;
  readonly layers: readonly RenderedTextLayer[];
  /** `true` si alguna caja se renderizó con una fuente no verificada. */
  readonly hasUnverifiedFont: boolean;
}

/** Overlay completo del canvas, listo para `overlay` de ffmpeg o `composite` de sharp. */
export async function renderTextOverlay(
  boxes: readonly TextObject[],
  canvas: Canvas,
  options: TextLayerOptions,
): Promise<TextOverlay> {
  const layers: RenderedTextLayer[] = [];
  for (const box of boxes) {
    const layer = await renderTextBox(box, canvas, options);
    if (layer !== null) layers.push(layer);
  }

  const composites: sharp.OverlayOptions[] = [];
  for (const layer of layers) {
    const entry = await clipToCanvas(layer, canvas);
    if (entry !== null) composites.push(entry);
  }

  const png = await sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();

  return {
    png,
    layers,
    hasUnverifiedFont: layers.some((layer) => !layer.font.verified),
  };
}
