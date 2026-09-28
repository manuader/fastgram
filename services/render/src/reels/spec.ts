/**
 * Spec del reel del lado del render — espejo de `@fastgram/contracts`
 * (`packages/contracts/src/resources/reel.ts`).
 *
 * Es una copia y no un import porque este servicio no depende de `contracts`
 * (no se tocan `package.json` con agentes en paralelo, y el render ya tenía su
 * propio esquema de payload: `domain/payload.ts`). El test
 * `spec.test.ts` fija el mismo fixture que `reel.test.ts` del contrato: si uno
 * cambia y el otro no, el adaptador (`packages/adapters/src/media-renderer`)
 * manda algo que acá se rechaza con `bad_request`, que es la falla correcta.
 */
import { z } from "zod";
import { FONT_FAMILIES, isWeightAllowed } from "../domain/fonts.js";
import {
  backgroundStyleSchema as textBackgroundStyleSchema,
  hexColorSchema,
} from "../domain/text.js";
import { mediaGrantSchema } from "../media/urlPolicy.js";

const fontFamilySchema = z.enum(FONT_FAMILIES);

// --- Números -----------------------------------------------------------------

/** El reel es vertical y de un solo tamaño: lo que publica Instagram/TikTok. */
export const REEL_CANVAS = { width: 1080, height: 1920 } as const;
/** El render sale a 30 fps; el spec no lo elige (menos cosas que validar). */
export const REEL_FPS = 30;
/**
 * 5–60 s. Menos de 3 s Instagram lo rechaza (trampa 67) y 5 s deja aire; más de
 * 60 s ya no es un reel de feed y el render en esta Mac pasa los dos minutos.
 */
export const REEL_DURATION_MIN_SEC = 5;
export const REEL_DURATION_MAX_SEC = 60;
/** Tope total de capas: cada capa es un nodo animado en cada frame capturado. */
export const REEL_MAX_LAYERS = 24;
export const REEL_MAX_TEXT_LAYERS = 12;
/** Capas con URL de video/imagen (fondos, clips, imágenes). Cada una se baja. */
export const REEL_MAX_MEDIA_LAYERS = 10;
/** Clips de video: cada uno se decodifica frame a frame (y el croma cuesta). */
export const REEL_MAX_CLIP_LAYERS = 4;
/** Texto en pantalla, no un párrafo: 280 como un tweet corto. */
export const REEL_TEXT_MAX_LENGTH = 280;
/** Subtítulos: ~2,5 palabras/s × 60 s × 4 de margen. */
export const REEL_MAX_CAPTION_WORDS = 600;
export const REEL_CAPTION_WORD_MAX_LENGTH = 40;
/** Una capa de menos de 0,2 s son 6 frames: no se llega a leer ni a ver. */
export const REEL_MIN_LAYER_SEC = 0.2;
export const REEL_TRANSITION_MIN_SEC = 0.15;
export const REEL_TRANSITION_MAX_SEC = 1.5;
/** Fades de audio. */
export const REEL_AUDIO_FADE_MAX_SEC = 5;
/** Palabras por renglón de subtítulo. */
export const REEL_CAPTION_WORDS_PER_CHUNK_MIN = 1;
export const REEL_CAPTION_WORDS_PER_CHUNK_MAX = 6;
/** z de las capas visuales. */
export const REEL_Z_MAX = 99;

/** FR-051 (PRD:1184) — los mismos topes que la caja de texto del editor. */
const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 72;
const STROKE_WIDTH_MAX = 8;
const TEXT_WIDTH_PERCENT_MIN = 25;
const TEXT_WIDTH_PERCENT_MAX = 100;

// --- Catálogos cerrados --------------------------------------------------------

/**
 * Animaciones de entrada del texto. Cerrado a propósito: cada una es un preset
 * del compilador que se miró en frames renderizados. Una animación libre
 * (keyframes arbitrarios) sería un lenguaje nuevo que validar.
 */
export const REEL_TEXT_ANIMATIONS = [
  "none",
  "fade-up",
  "pop",
  "typewriter",
  "word-by-word",
  "slide-left",
  "highlight-sweep",
  "kinetic-bounce",
  "zoom-blur",
  "wipe-reveal",
] as const;
export const reelTextAnimationSchema = z.enum(REEL_TEXT_ANIMATIONS);
export type ReelTextAnimation = z.infer<typeof reelTextAnimationSchema>;

/** Las que tienen sentido sobre una imagen entera (sin palabras ni letras). */
export const REEL_MEDIA_ANIMATIONS = [
  "none",
  "fade-up",
  "pop",
  "slide-left",
  "zoom-blur",
  "wipe-reveal",
] as const;
export const reelMediaAnimationSchema = z.enum(REEL_MEDIA_ANIMATIONS);
export type ReelMediaAnimation = z.infer<typeof reelMediaAnimationSchema>;

/** Salida de una capa de texto/imagen en sus últimos instantes. */
export const reelExitSchema = z.enum(["none", "fade"]);
export type ReelExit = z.infer<typeof reelExitSchema>;

/** Transición de entrada de un fondo: es lo que separa una escena de la otra. */
export const REEL_TRANSITIONS = [
  "cut",
  "crossfade",
  "slide-up",
  "slide-left",
  "zoom-in",
  "flash",
  "whip",
  "blur",
] as const;
export const reelTransitionSchema = z.enum(REEL_TRANSITIONS);
export type ReelTransition = z.infer<typeof reelTransitionSchema>;

export const REEL_CAPTION_STYLES = ["bold-pop", "clean", "karaoke"] as const;
export const reelCaptionStyleSchema = z.enum(REEL_CAPTION_STYLES);
export type ReelCaptionStyle = z.infer<typeof reelCaptionStyleSchema>;

/**
 * Croma del clip. `alpha` = el archivo ya trae canal alfa (webm VP9, ProRes
 * 4444); `none` = va opaco, como cualquier video.
 */
export const reelChromaSchema = z.enum(["green", "blue", "alpha", "none"]);
export type ReelChroma = z.infer<typeof reelChromaSchema>;

export const reelFitSchema = z.enum(["cover", "contain"]);
export type ReelFit = z.infer<typeof reelFitSchema>;

// --- Piezas ----------------------------------------------------------------------

/** Id de capa: estable entre ediciones, sirve de id en el HTML compilado. */
export const reelLayerIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, "expected a lowercase id (a-z, 0-9, -), max 32");

const seconds = z.number().finite().min(0).max(REEL_DURATION_MAX_SEC);

const timing = {
  id: reelLayerIdSchema,
  start: seconds,
  end: seconds,
};

const zIndex = z.number().int().min(0).max(REEL_Z_MAX);

/**
 * Rectángulo de media en % del lienzo. `x`/`y` son el **centro** (la misma
 * regla que `FR-051` para el texto), `width`/`height` el tamaño. Se permite
 * salir del lienzo (un clip que entra por abajo) y agrandar hasta 3×.
 */
export const reelRectSchema = z
  .object({
    x: z.number().min(-50).max(150),
    y: z.number().min(-50).max(150),
    width: z.number().min(5).max(300),
    height: z.number().min(5).max(300),
  })
  .strict();
export type ReelRect = z.infer<typeof reelRectSchema>;

export const REEL_FULL_RECT: ReelRect = { x: 50, y: 50, width: 100, height: 100 };

const mediaUrl = z.string().url();

export const reelBackgroundFillSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("color"), color: hexColorSchema }).strict(),
  z
    .object({
      type: z.literal("gradient"),
      from: hexColorSchema,
      to: hexColorSchema,
      angle: z.number().min(0).max(360),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      url: mediaUrl,
      /** `ken-burns`: acercamiento lento durante toda la capa. */
      motion: z.enum(["none", "ken-burns"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("video"),
      url: mediaUrl,
      mediaStartSec: seconds,
    })
    .strict(),
]);
export type ReelBackgroundFill = z.infer<typeof reelBackgroundFillSchema>;

export const reelTransitionInSchema = z
  .object({
    kind: reelTransitionSchema,
    durationSec: z.number().min(REEL_TRANSITION_MIN_SEC).max(REEL_TRANSITION_MAX_SEC),
  })
  .strict();
export type ReelTransitionIn = z.infer<typeof reelTransitionInSchema>;

export const reelBackgroundLayerSchema = z
  .object({
    ...timing,
    kind: z.literal("background"),
    z: zIndex,
    fill: reelBackgroundFillSchema,
    transitionIn: reelTransitionInSchema,
  })
  .strict();
export type ReelBackgroundLayer = z.infer<typeof reelBackgroundLayerSchema>;

export const reelClipLayerSchema = z
  .object({
    ...timing,
    kind: z.literal("clip"),
    z: zIndex,
    url: mediaUrl,
    chroma: reelChromaSchema,
    fit: reelFitSchema,
    rect: reelRectSchema,
    /** Desde dónde del archivo arranca. */
    mediaStartSec: seconds,
    /** Volumen del audio propio del clip (0 = mudo). */
    volume: z.number().min(0).max(1),
    /** Un meme de 2 s en una capa de 8 s se repite en vez de congelarse. */
    loop: z.boolean(),
  })
  .strict();
export type ReelClipLayer = z.infer<typeof reelClipLayerSchema>;

export const reelImageLayerSchema = z
  .object({
    ...timing,
    kind: z.literal("image"),
    z: zIndex,
    url: mediaUrl,
    fit: reelFitSchema,
    rect: reelRectSchema,
    animation: reelMediaAnimationSchema,
    exit: reelExitSchema,
  })
  .strict();
export type ReelImageLayer = z.infer<typeof reelImageLayerSchema>;

export const reelFontSchema = z
  .object({
    family: fontFamilySchema,
    weight: z.number().int(),
    size: z.number().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX),
  })
  .strict()
  .refine((f) => isWeightAllowed(f.family, f.weight), {
    path: ["weight"],
    message: "weight is not available for this font family",
  });
export type ReelFont = z.infer<typeof reelFontSchema>;

export const reelStrokeSchema = z
  .object({ width: z.number().min(0).max(STROKE_WIDTH_MAX), color: hexColorSchema })
  .strict();

export const reelTextBackgroundSchema = z
  .object({
    color: hexColorSchema,
    opacity: z.number().min(0).max(1),
    style: textBackgroundStyleSchema,
  })
  .strict()
  .nullable();

export const reelTextLayerSchema = z
  .object({
    ...timing,
    kind: z.literal("text"),
    z: zIndex,
    text: z.string().trim().min(1).max(REEL_TEXT_MAX_LENGTH),
    font: reelFontSchema,
    color: hexColorSchema,
    stroke: reelStrokeSchema,
    background: reelTextBackgroundSchema,
    position: z
      .object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) })
      .strict(),
    widthPercent: z.number().min(TEXT_WIDTH_PERCENT_MIN).max(TEXT_WIDTH_PERCENT_MAX),
    animation: reelTextAnimationSchema,
    exit: reelExitSchema,
    /** Color del barrido de `highlight-sweep`. Sin él, el `accent` del tema. */
    highlightColor: hexColorSchema.optional(),
  })
  .strict();
export type ReelTextLayer = z.infer<typeof reelTextLayerSchema>;

/** Una palabra transcripta, en segundos **del reel** (no del archivo). */
export const reelCaptionWordSchema = z
  .object({
    text: z.string().trim().min(1).max(REEL_CAPTION_WORD_MAX_LENGTH),
    start: seconds,
    end: seconds,
  })
  .strict()
  .refine((w) => w.end > w.start, { path: ["end"], message: "end must be after start" });
export type ReelCaptionWord = z.infer<typeof reelCaptionWordSchema>;

export const reelCaptionsLayerSchema = z
  .object({
    ...timing,
    kind: z.literal("captions"),
    z: zIndex,
    /** La capa (clip o voz) cuya habla se subtitula. */
    sourceLayerId: reelLayerIdSchema,
    /**
     * Ausente = el render transcribe la fuente (whisper/parakeet) en el idioma
     * del spec. Presente = se usan éstas tal cual (el editor las corrige).
     * Vacía = la fuente no tiene habla: no hay subtítulos.
     */
    words: z.array(reelCaptionWordSchema).max(REEL_MAX_CAPTION_WORDS).optional(),
    style: reelCaptionStyleSchema,
    font: reelFontSchema,
    color: hexColorSchema,
    activeColor: hexColorSchema,
    stroke: reelStrokeSchema,
    /** Altura del renglón: centro en % del alto, como `FR-051`. */
    positionY: z.number().min(0).max(100),
    wordsPerChunk: z
      .number()
      .int()
      .min(REEL_CAPTION_WORDS_PER_CHUNK_MIN)
      .max(REEL_CAPTION_WORDS_PER_CHUNK_MAX),
  })
  .strict();
export type ReelCaptionsLayer = z.infer<typeof reelCaptionsLayerSchema>;

export const reelAudioLayerSchema = z
  .object({
    ...timing,
    kind: z.literal("audio"),
    /** `music` se atenúa bajo el habla si `mix.duckMusic`; `voice` no. */
    role: z.enum(["music", "voice"]),
    url: mediaUrl,
    volume: z.number().min(0).max(1),
    mediaStartSec: seconds,
    fadeInSec: z.number().min(0).max(REEL_AUDIO_FADE_MAX_SEC),
    fadeOutSec: z.number().min(0).max(REEL_AUDIO_FADE_MAX_SEC),
    loop: z.boolean(),
  })
  .strict();
export type ReelAudioLayer = z.infer<typeof reelAudioLayerSchema>;

export const reelLayerSchema = z.discriminatedUnion("kind", [
  reelBackgroundLayerSchema,
  reelClipLayerSchema,
  reelImageLayerSchema,
  reelTextLayerSchema,
  reelCaptionsLayerSchema,
  reelAudioLayerSchema,
]);
export type ReelLayer = z.infer<typeof reelLayerSchema>;
export type ReelLayerKind = ReelLayer["kind"];

export const reelThemeSchema = z
  .object({
    background: hexColorSchema,
    primary: hexColorSchema,
    accent: hexColorSchema,
    text: hexColorSchema,
  })
  .strict();
export type ReelTheme = z.infer<typeof reelThemeSchema>;

export const REEL_DEFAULT_THEME: ReelTheme = {
  background: "#111111",
  primary: "#FFFFFF",
  accent: "#FFE14D",
  text: "#FFFFFF",
};

export const reelMixSchema = z
  .object({
    /** Baja la música mientras suena un clip con audio o una voz. */
    duckMusic: z.boolean(),
    /** A qué fracción de su volumen baja (0,3 ≈ −10 dB). */
    duckLevel: z.number().min(0).max(1),
  })
  .strict();
export type ReelMix = z.infer<typeof reelMixSchema>;

// --- El spec -----------------------------------------------------------------------

const reelSpecBaseSchema = z
  .object({
    version: z.literal(1),
    durationSec: z.number().min(REEL_DURATION_MIN_SEC).max(REEL_DURATION_MAX_SEC),
    canvas: z
      .object({
        width: z.literal(REEL_CANVAS.width),
        height: z.literal(REEL_CANVAS.height),
      })
      .strict(),
    fps: z.literal(REEL_FPS),
    /** ISO 639-1 del habla (idioma de la marca). Sin él, se autodetecta. */
    language: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
    theme: reelThemeSchema,
    mix: reelMixSchema,
    layers: z.array(reelLayerSchema).min(1).max(REEL_MAX_LAYERS),
  })
  .strict();

type ReelSpecShape = z.infer<typeof reelSpecBaseSchema>;

/** Las reglas que cruzan capas. Exportada para que `core` y el render digan lo mismo. */
export function reelSpecIssues(
  spec: ReelSpecShape,
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const ids = new Map<string, ReelLayer>();
  let text = 0;
  let media = 0;
  let clips = 0;
  let music = 0;
  let voice = 0;
  spec.layers.forEach((layer, i) => {
    if (ids.has(layer.id)) {
      issues.push({
        path: ["layers", i, "id"],
        message: `duplicate layer id ${layer.id}`,
      });
    }
    ids.set(layer.id, layer);
    if (layer.end - layer.start < REEL_MIN_LAYER_SEC - 1e-9) {
      issues.push({
        path: ["layers", i, "end"],
        message: `a layer lasts at least ${String(REEL_MIN_LAYER_SEC)}s`,
      });
    }
    if (layer.end > spec.durationSec + 1e-6) {
      issues.push({ path: ["layers", i, "end"], message: "layer ends after the reel" });
    }
    if (layer.kind === "text") text += 1;
    if (layer.kind === "clip") clips += 1;
    if (
      layer.kind === "clip" ||
      layer.kind === "image" ||
      (layer.kind === "background" &&
        (layer.fill.type === "image" || layer.fill.type === "video"))
    ) {
      media += 1;
    }
    if (layer.kind === "audio" && layer.role === "music") music += 1;
    if (layer.kind === "audio" && layer.role === "voice") voice += 1;
    if (
      layer.kind === "audio" &&
      layer.fadeInSec + layer.fadeOutSec > layer.end - layer.start
    ) {
      issues.push({
        path: ["layers", i, "fadeOutSec"],
        message: "fades longer than the layer",
      });
    }
    if (layer.kind === "captions" && layer.words !== undefined) {
      let last = -1;
      layer.words.forEach((w, j) => {
        if (w.start < last - 1e-6) {
          issues.push({
            path: ["layers", i, "words", j, "start"],
            message: "caption words must be in order",
          });
        }
        if (w.end > spec.durationSec + 1e-6) {
          issues.push({
            path: ["layers", i, "words", j, "end"],
            message: "word after the reel",
          });
        }
        last = w.start;
      });
    }
  });
  if (text > REEL_MAX_TEXT_LAYERS) {
    issues.push({
      path: ["layers"],
      message: `at most ${String(REEL_MAX_TEXT_LAYERS)} text layers`,
    });
  }
  if (media > REEL_MAX_MEDIA_LAYERS) {
    issues.push({
      path: ["layers"],
      message: `at most ${String(REEL_MAX_MEDIA_LAYERS)} media layers`,
    });
  }
  if (clips > REEL_MAX_CLIP_LAYERS) {
    issues.push({
      path: ["layers"],
      message: `at most ${String(REEL_MAX_CLIP_LAYERS)} clips`,
    });
  }
  if (music > 1) issues.push({ path: ["layers"], message: "at most one music layer" });
  if (voice > 1) issues.push({ path: ["layers"], message: "at most one voice layer" });
  spec.layers.forEach((layer, i) => {
    if (layer.kind !== "captions") return;
    const source = ids.get(layer.sourceLayerId);
    if (
      source === undefined ||
      !(source.kind === "clip" || (source.kind === "audio" && source.role === "voice"))
    ) {
      issues.push({
        path: ["layers", i, "sourceLayerId"],
        message: "captions must point at a clip or a voice layer",
      });
    }
  });
  return issues;
}

export const reelSpecSchema = reelSpecBaseSchema.superRefine((spec, ctx) => {
  for (const issue of reelSpecIssues(spec)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: issue.path,
      message: issue.message,
    });
  }
});
export type ReelSpec = z.infer<typeof reelSpecSchema>;

// --- Requests del servicio ------------------------------------------------------

/** `draft` para previews/iterar, `delivery` para la pieza final (`D-20`). */
export const reelQualitySchema = z.enum(["draft", "delivery"]);
export type ReelQuality = z.infer<typeof reelQualitySchema>;

export const reelRenderRequestSchema = z
  .object({
    spec: reelSpecSchema,
    grant: mediaGrantSchema.optional(),
    quality: reelQualitySchema.default("delivery"),
  })
  .strict();
export type ReelRenderRequestInput = z.input<typeof reelRenderRequestSchema>;

export const reelPreviewRequestSchema = z
  .object({ spec: reelSpecSchema, grant: mediaGrantSchema.optional() })
  .strict();

/** Todas las URLs de media del spec, en orden de capa. */
export function reelMediaUrls(spec: Pick<ReelSpec, "layers">): string[] {
  const urls: string[] = [];
  for (const layer of spec.layers) {
    if (layer.kind === "background") {
      if (layer.fill.type === "image" || layer.fill.type === "video")
        urls.push(layer.fill.url);
    } else if (
      layer.kind === "clip" ||
      layer.kind === "image" ||
      layer.kind === "audio"
    ) {
      urls.push(layer.url);
    }
  }
  return urls;
}
