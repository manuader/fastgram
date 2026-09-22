/**
 * Jobs de ejemplo compartidos por los tests del adaptador HTTP.
 *
 * Las URLs son `https://` y no `memory://` porque el schema de
 * `services/render` las valida con `z.string().url()` y su política de media
 * las parsea con `new URL`. El audio cuelga de otro host a propósito:
 * `FR-070` dice que «el audio sólo puede venir de la librería compartida», y la
 * política del servicio lo verifica contra `RENDER_SHARED_LIBRARY_PREFIXES`,
 * que es un prefijo distinto del Media Bank.
 *
 * Las dimensiones son verticales (1080×1920, y 1080×1350 para el slideshow en
 * 4:5) porque los cuatro formatos del producto son verticales. No hay ningún
 * número de proveedor acá.
 */

import type {
  GreenScreenJob,
  RenderJob,
  RenderText,
  SlideshowJob,
  VideoHookJob,
  WallOfTextJob,
} from "@fastgram/ports";

export const TEXT: RenderText = {
  content: "hook",
  x: 80,
  y: 1200,
  width: 920,
  fontSize: 48,
  color: "#FFFFFF",
  textAlign: "center",
};

export const SLIDESHOW: SlideshowJob = {
  format: "slideshow",
  num_images: 2,
  images: [
    {
      canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
      image: {
        url: "https://media.test/slide-1.png",
        drawX: 0,
        drawY: 0,
        drawW: 1080,
        drawH: 1350,
      },
      texts: [TEXT],
    },
    {
      canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
      image: {
        url: "https://media.test/slide-2.png",
        drawX: 0,
        drawY: 0,
        drawW: 1080,
        drawH: 1350,
      },
      texts: [{ ...TEXT, content: "segundo" }],
    },
  ],
};

/** Un slide: es lo único que `MediaRenderer.render` puede devolver hoy. */
export const SLIDESHOW_ONE: SlideshowJob = {
  format: "slideshow",
  num_images: 1,
  images: [
    {
      canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
      image: {
        url: "https://media.test/slide-1.png",
        drawX: 0,
        drawY: 0,
        drawW: 1080,
        drawH: 1350,
      },
      texts: [TEXT],
    },
  ],
};

export const WALL_OF_TEXT: WallOfTextJob = {
  format: "wall-of-text",
  canvas: { width: 1080, height: 1920 },
  video: {
    url: "https://media.test/bg.mp4",
    drawX: 0,
    drawY: 0,
    drawW: 1080,
    drawH: 1920,
  },
  audio: { url: "https://library.test/track.mp3" },
  text: TEXT,
};

export const GREEN_SCREEN: GreenScreenJob = {
  format: "green-screen",
  canvas: { width: 1080, height: 1920 },
  image: {
    url: "https://media.test/bg.png",
    drawX: 0,
    drawY: 0,
    drawW: 1080,
    drawH: 1920,
  },
  video: {
    url: "https://media.test/talent.mp4",
    drawX: 0,
    drawY: 400,
    drawW: 1080,
    drawH: 1080,
  },
  text: TEXT,
};

export const VIDEO_HOOK: VideoHookJob = {
  format: "video-hook",
  canvas: { width: 1080, height: 1920 },
  hook_video: {
    url: "https://media.test/hook.mp4",
    drawX: 0,
    drawY: 0,
    drawW: 1080,
    drawH: 960,
  },
  demo_video: {
    url: "https://media.test/demo.mp4",
    drawX: 0,
    drawY: 960,
    drawW: 1080,
    drawH: 960,
  },
  audio: { url: "https://library.test/track.mp3" },
  text: TEXT,
};

export const ALL_JOBS: readonly RenderJob[] = [
  SLIDESHOW_ONE,
  WALL_OF_TEXT,
  GREEN_SCREEN,
  VIDEO_HOOK,
];
