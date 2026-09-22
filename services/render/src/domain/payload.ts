/**
 * Payloads de build de los cuatro formatos base (`FR-070`, "contrato normativo").
 *
 * El contrato del PRD es:
 *   wall-of-text : {canvas, video{url,draw…}, audio{url}, text}
 *   green-screen : {canvas, image{url,draw…}, video{url,draw…}, text}  — croma SOBRE la imagen
 *   video-hook   : {canvas, hook_video{…}, demo_video{…}, audio{url}, text} — hook arriba, demo abajo
 *   slideshow    : {num_images, images:[{canvas{…,aspectRatio}, image{url,draw…}, texts:[…]}]}
 *
 * Diferencias deliberadas, todas documentadas:
 *  · `draw` es opcional. Cuando falta, la geometría la calcula `computePlacement`
 *    con `fit` (default `cover`, `EXT-006`). El PRD la trae siempre porque su v1
 *    hacía stretch; acá estirar es opt-in.
 *  · El texto usa el objeto canónico de `FR-051` (unidades de editor), no la
 *    forma plana en píxeles de `FR-070`. Ver la nota ABIERTO en `text.ts`.
 *  · `text` singular del PRD se modela como lista `texts`, porque `FR-051`
 *    habla de "cajas de texto" en plural en los cuatro formatos y permite
 *    `Add Text`.
 */
import { z } from "zod";
import { aspectRatioSchema, canvasSchema, DEFAULT_SLIDESHOW_ASPECT } from "./canvas.js";
import { DEFAULT_FIT_MODE, fitModeSchema, focalPointSchema } from "./fit.js";
import { textObjectListSchema } from "./text.js";

/** `FR-070`: "Máximo 20 slides por slideshow". */
export const MAX_SLIDES = 20;

/** Rectángulo de dibujo explícito (`drawX/drawY/drawW/drawH` del PRD). */
export const drawRectSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const mediaRefSchema = z
  .object({
    url: z.string().url(),
    /** Cuando falta, se calcula con `fit` sobre el canvas completo. */
    draw: drawRectSchema.optional(),
    fit: fitModeSchema.default(DEFAULT_FIT_MODE),
    focal: focalPointSchema.optional(),
  })
  .strict();

export type MediaRef = z.infer<typeof mediaRefSchema>;

/**
 * `FR-070`: "El audio sólo puede venir de la librería compartida".
 *
 * Es OPCIONAL en `wall-of-text` y `video-hook`: `FR-053.1` (PRD:1234) dice que
 * la primera opción del modal `Select Audio` es `No audio` y que elegirla
 * "omite el bloque `audio`". El contrato público
 * (`@fastgram/contracts`, `contentBuildPayloadSchema`) ya lo tenía `.optional()`,
 * así que exigirlo acá hacía irrenderizable el payload más común del producto:
 * `POST /content` lo aceptaba, lo cobraba y lo encolaba, y este servicio lo
 * rechazaba con `bad_request`.
 */
export const audioRefSchema = z.object({ url: z.string().url() }).strict();

/**
 * Parámetros del chromakey. ABIERTO: el PRD dice "el video con croma se compone
 * sobre la imagen de fondo" pero no fija color ni tolerancias. Los defaults de
 * acá son una elección del servicio (verde puro, tolerancia media), no del PRD.
 */
export const chromaKeySchema = z
  .object({
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#00FF00"),
    similarity: z.number().min(0.01).max(1).default(0.18),
    blend: z.number().min(0).max(1).default(0.1),
  })
  .strict();

export type ChromaKey = z.infer<typeof chromaKeySchema>;

export const slideSchema = z
  .object({
    canvas: canvasSchema.extend({ aspectRatio: aspectRatioSchema }).strict(),
    image: mediaRefSchema,
    texts: textObjectListSchema,
  })
  .strict();

/**
 * Base sin refinamientos cruzados: `z.discriminatedUnion` sólo acepta
 * `ZodObject`, y un `.superRefine` lo convierte en `ZodEffects`. Los
 * refinamientos se aplican sobre la unión (`buildPayloadSchema`) y sobre el
 * esquema individual exportado.
 */
export const slideshowPayloadBaseSchema = z
  .object({
    type: z.literal("slideshow"),
    numImages: z.number().int().min(1).max(MAX_SLIDES),
    slides: z.array(slideSchema).min(1).max(MAX_SLIDES),
  })
  .strict();

type SlideshowShape = z.infer<typeof slideshowPayloadBaseSchema>;

function checkSlideshow(
  value: SlideshowShape,
  ctx: z.RefinementCtx,
  base: readonly (string | number)[] = [],
): void {
  // `FR-070`: "num_images debe coincidir con la longitud de images".
  if (value.numImages !== value.slides.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...base, "numImages"],
      message: `numImages (${value.numImages}) no coincide con slides (${value.slides.length})`,
    });
  }
  // Todos los slides comparten aspect ratio: es un carrusel, no un collage.
  const first = value.slides[0];
  if (first === undefined) return;
  for (const [index, slide] of value.slides.entries()) {
    if (slide.canvas.aspectRatio !== first.canvas.aspectRatio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...base, "slides", index, "canvas", "aspectRatio"],
        message: "todos los slides deben compartir el mismo aspectRatio",
      });
    }
  }
}

export const slideshowPayloadSchema = slideshowPayloadBaseSchema.superRefine(
  (value, ctx) => {
    checkSlideshow(value, ctx);
  },
);

export const wallOfTextPayloadSchema = z
  .object({
    type: z.literal("wall-of-text"),
    canvas: canvasSchema,
    video: mediaRefSchema,
    /** `FR-053.1`: ausente = `No audio`. Ver `audioRefSchema`. */
    audio: audioRefSchema.optional(),
    texts: textObjectListSchema,
  })
  .strict();

export const greenScreenPayloadSchema = z
  .object({
    type: z.literal("green-screen"),
    canvas: canvasSchema,
    /** Fondo. El video con croma se compone ENCIMA (`FR-070`). */
    image: mediaRefSchema,
    video: mediaRefSchema,
    chromaKey: chromaKeySchema.default({
      color: "#00FF00",
      similarity: 0.18,
      blend: 0.1,
    }),
    texts: textObjectListSchema,
  })
  .strict();

export const videoHookPayloadSchema = z
  .object({
    type: z.literal("video-hook"),
    canvas: canvasSchema,
    hookVideo: mediaRefSchema,
    demoVideo: mediaRefSchema,
    /** `FR-053.1`: ausente = `No audio`. Ver `audioRefSchema`. */
    audio: audioRefSchema.optional(),
    texts: textObjectListSchema,
    /**
     * Proporción vertical del hook sobre el canvas. El PRD sólo dice "hook
     * arriba, demo abajo" y no fija el reparto: 0.5 es la elección del
     * servicio. ABIERTO.
     */
    hookHeightRatio: z.number().min(0.2).max(0.8).default(0.5),
  })
  .strict();

export const buildPayloadSchema = z
  .discriminatedUnion("type", [
    slideshowPayloadBaseSchema,
    wallOfTextPayloadSchema,
    greenScreenPayloadSchema,
    videoHookPayloadSchema,
  ])
  .superRefine((value, ctx) => {
    if (value.type === "slideshow") checkSlideshow(value, ctx);
  });

export type SlideshowPayload = z.infer<typeof slideshowPayloadSchema>;
export type WallOfTextPayload = z.infer<typeof wallOfTextPayloadSchema>;
export type GreenScreenPayload = z.infer<typeof greenScreenPayloadSchema>;
export type VideoHookPayload = z.infer<typeof videoHookPayloadSchema>;
export type BuildPayload = z.infer<typeof buildPayloadSchema>;
export type BuildPayloadInput = z.input<typeof buildPayloadSchema>;
export type ContentType = BuildPayload["type"];

export const DEFAULT_ASPECT_FOR_SLIDESHOW = DEFAULT_SLIDESHOW_ASPECT;

/** Todas las URLs de media del payload, con su rol. El rol decide qué política aplica. */
export interface MediaReference {
  readonly url: string;
  readonly role: "image" | "video" | "audio";
  readonly path: readonly (string | number)[];
}

/**
 * La referencia de audio, o nada si el payload eligió `No audio` (`FR-053.1`).
 *
 * Existe como helper y no inline porque es la lista que consume `urlPolicy`: si
 * la ausencia se colara como `{url: undefined}`, `new URL(undefined)` tiraría
 * `url_invalida` y el rechazo diría exactamente lo contrario de lo que pasó.
 */
function audioReference(
  audio: { readonly url: string } | undefined,
): readonly MediaReference[] {
  if (audio === undefined) return [];
  return [{ url: audio.url, role: "audio", path: ["audio"] }];
}

export function collectMediaReferences(payload: BuildPayload): readonly MediaReference[] {
  switch (payload.type) {
    case "slideshow":
      return payload.slides.map((slide, index) => ({
        url: slide.image.url,
        role: "image" as const,
        path: ["slides", index, "image"],
      }));
    case "wall-of-text":
      return [
        { url: payload.video.url, role: "video", path: ["video"] },
        ...audioReference(payload.audio),
      ];
    case "green-screen":
      return [
        { url: payload.image.url, role: "image", path: ["image"] },
        { url: payload.video.url, role: "video", path: ["video"] },
      ];
    case "video-hook":
      return [
        { url: payload.hookVideo.url, role: "video", path: ["hookVideo"] },
        { url: payload.demoVideo.url, role: "video", path: ["demoVideo"] },
        ...audioReference(payload.audio),
      ];
  }
}
