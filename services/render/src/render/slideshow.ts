/**
 * `P2-RENDER-004` — Slideshow: hasta 20 slides, aspect ratios 1:1 / 4:5 / 3:4 /
 * 9:16 (`FR-070`, `F-068`; default `4:5`).
 *
 * Es un carrusel de imágenes, no un video: se resuelve entero con sharp, sin
 * tocar ffmpeg. `EXT-006` en acción — por defecto se recorta preservando el
 * aspecto (`cover`) en vez del `stretch-to-canvas` que el PRD documenta como
 * limitación conocida de la v1.
 *
 * Igual que los formatos de video, el trabajo se parte en dos: la base (imagen
 * recortada y escalada al canvas, sin texto) se cachea por `mediaKey`, y el
 * texto se compone encima en una pasada aparte.
 */
import sharp from "sharp";
import { RenderError } from "../errors.js";
import type { Canvas } from "../domain/canvas.js";
import type { SlideshowPayload } from "../domain/payload.js";
import { placeMedia } from "./formats.js";
import { renderTextOverlay, type TextLayerOptions } from "./textLayer.js";

/** Calidad JPEG de salida. El PRD no la fija: elección del servicio. ABIERTO. */
export const SLIDE_JPEG_QUALITY = 92;

export interface SlideRender {
  readonly index: number;
  readonly jpeg: Buffer;
  readonly canvas: Canvas;
  readonly hasUnverifiedFont: boolean;
}

/** Base de un slide: la imagen recortada y colocada en el canvas, sin texto. */
export async function renderSlideBase(
  payload: SlideshowPayload,
  index: number,
  imagePath: string,
): Promise<Buffer> {
  const slide = payload.slides[index];
  if (slide === undefined) {
    throw new RenderError("bad_request", "índice de slide fuera de rango", {
      details: { index },
    });
  }
  const canvas: Canvas = { width: slide.canvas.width, height: slide.canvas.height };

  const source = sharp(imagePath, { failOn: "error" });
  const metadata = await source.metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    throw new RenderError("unsupported_media_format", "no se pudieron leer las dimensiones", {
      details: { index },
    });
  }

  const placement = placeMedia(canvas, slide.image, { width, height });
  const placed = await sharp(imagePath, { failOn: "error" })
    .extract({
      left: placement.crop.x,
      top: placement.crop.y,
      width: placement.crop.width,
      height: placement.crop.height,
    })
    .resize(placement.draw.width, placement.draw.height, {
      fit: "fill",
      kernel: "lanczos3",
    })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([{ input: placed, left: placement.draw.x, top: placement.draw.y }])
    .png()
    .toBuffer();
}

/** Compone el texto sobre una base ya resuelta y produce el JPEG final. */
export async function renderSlideWithText(
  payload: SlideshowPayload,
  index: number,
  basePng: Buffer,
  options: TextLayerOptions,
): Promise<SlideRender> {
  const slide = payload.slides[index];
  if (slide === undefined) {
    throw new RenderError("bad_request", "índice de slide fuera de rango", {
      details: { index },
    });
  }
  const canvas: Canvas = { width: slide.canvas.width, height: slide.canvas.height };
  const overlay = await renderTextOverlay(slide.texts, canvas, options);
  const jpeg = await sharp(basePng)
    .composite([{ input: overlay.png, left: 0, top: 0 }])
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .jpeg({ quality: SLIDE_JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  if (jpeg.byteLength === 0) {
    // Misma garantía que con ffmpeg: "no falló" no es "produjo algo".
    throw new RenderError("render_empty_output", "el slide se renderizó vacío", {
      details: { index },
    });
  }

  return { index, jpeg, canvas, hasUnverifiedFont: overlay.hasUnverifiedFont };
}
