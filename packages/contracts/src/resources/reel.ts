/**
 * Reel · formato `reel` (`PU-S9-009`, `PU-S9-010`, decisión `D-20`).
 *
 * Un reel es una **composición por capas con tiempo**: cada capa tiene
 * `start`/`end` en segundos del reel y un `z` (orden de apilado). El motor
 * (`services/render`, HyperFrames) compila el spec a una composición HTML y la
 * renderiza; el editor muestra **esa misma** composición en un iframe. Por eso
 * el spec es el único estado editable: no hay `textBoxes` aparte como en los
 * cuatro formatos base.
 *
 * Todo número de acá abajo es un tope elegido por nosotros (el PRD no los fija)
 * y está clavado en `reel.test.ts`. La razón de cada uno va al lado.
 *
 * El texto usa **las mismas unidades que `FR-051`**: `position.x/y` es el
 * centro de la caja en % del lienzo, `widthPercent` su ancho, y `font.size` /
 * `stroke.width` son unidades de editor que se pasan a píxeles con
 * `canvas.width / 360`. Un reel no inventa otro sistema de coordenadas.
 *
 * Este archivo NO importa `content.ts` (que sí importa a éste para la unión de
 * payloads): un ciclo de módulos con `const` de zod revienta en el orden de
 * evaluación. Los topes de `FR-051` se repiten acá con su cita.
 */
import { z } from "zod";
import {
  FONT_WEIGHTS,
  fontFamilySchema,
  hexColorSchema,
  textBackgroundStyleSchema,
} from "../primitives/enums.js";

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

/**
 * Sprint 9 (U, `PU-S9-014`): una familia del design system de la marca por su
 * id estable (`brand:rotis-semi-sans`). Mismo patrón que el render
 * (`services/render/src/domain/fonts.ts`, M). Sus archivos van en
 * `spec.brandFonts`; que la licencia esté tildada lo decide quien arma el spec.
 */
export const REEL_BRAND_FAMILY_PREFIX = "brand:";
const REEL_BRAND_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export type ReelBrandFamily = `brand:${string}`;

export function isReelBrandFamily(value: string): value is ReelBrandFamily {
  return (
    value.startsWith(REEL_BRAND_FAMILY_PREFIX) &&
    REEL_BRAND_ID_RE.test(value.slice(REEL_BRAND_FAMILY_PREFIX.length))
  );
}

export const reelFontFamilySchema = z.union([
  fontFamilySchema,
  z
    .string()
    .refine(isReelBrandFamily, "expected a registered family or brand:<id>")
    .transform((v) => v as ReelBrandFamily),
]);

export const reelFontSchema = z
  .object({
    family: reelFontFamilySchema,
    weight: z.number().int(),
    size: z.number().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX),
  })
  .strict()
  .refine(
    (f) =>
      isReelBrandFamily(f.family)
        ? f.weight >= 100 && f.weight <= 900 && f.weight % 100 === 0
        : FONT_WEIGHTS[f.family as keyof typeof FONT_WEIGHTS].includes(f.weight),
    {
      path: ["weight"],
      message: "weight is not available for this font family",
    },
  );
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

/** Tope de caras de marca por spec: el del render (`MAX_BRAND_FONTS`). */
export const REEL_MAX_BRAND_FONTS = 16;

/** Una cara de una familia de marca (OTF/TTF en nuestro storage, `fonts/{companyId}/`). */
export const reelBrandFontSchema = z
  .object({
    id: z.string().regex(REEL_BRAND_ID_RE),
    weight: z.number().int().min(100).max(900),
    style: z.enum(["normal", "italic"]),
    url: mediaUrl,
  })
  .strict();
export type ReelBrandFont = z.infer<typeof reelBrandFontSchema>;

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
    /** Sprint 9 (U): las caras que usan las capas `brand:<id>`. Ausente = ninguna. */
    brandFonts: z.array(reelBrandFontSchema).max(REEL_MAX_BRAND_FONTS).optional(),
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
  // Sprint 9 (U): una capa `brand:<id>` necesita al menos una cara de ese id.
  const brandIds = new Set((spec.brandFonts ?? []).map((f) => f.id));
  spec.layers.forEach((layer, i) => {
    if (layer.kind !== "text" && layer.kind !== "captions") return;
    const family = layer.font.family;
    if (isReelBrandFamily(family) && !brandIds.has(family.slice(REEL_BRAND_FAMILY_PREFIX.length))) {
      issues.push({
        path: ["layers", i, "font", "family"],
        message: "brand font family without a file in brandFonts",
      });
    }
  });
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

/**
 * Payload de build del formato `reel`. La clave `reel` es la que lo distingue
 * por forma en la unión `contentBuildPayloadSchema` (el PRD no trae
 * discriminante, ver `content.ts`): ningún otro payload tiene `reel`.
 */
export const reelBuildPayloadSchema = z.object({ reel: reelSpecSchema }).strict();
export type ReelBuildPayload = z.infer<typeof reelBuildPayloadSchema>;

/**
 * Las URLs de las fuentes de marca del spec (sprint 9, U). Van al grant del
 * render aparte de {@link reelMediaUrls}: no son media del Media Bank (viven
 * en `fonts/{companyId}/`) y el chequeo de «media ajena» no las mira.
 */
export function reelFontUrls(spec: Pick<ReelSpec, "brandFonts">): string[] {
  return [...new Set((spec.brandFonts ?? []).map((f) => f.url))];
}

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

// --- API del editor ----------------------------------------------------------------

/** `GET /content/:id/reel` — el spec vigente (con las ediciones aplicadas). */
export const editableReelSchema = z
  .object({ revision: z.number().int().nonnegative(), reel: reelSpecSchema })
  .strict();
export type EditableReel = z.infer<typeof editableReelSchema>;

/** `PUT /content/:id/reel` — reemplaza el spec y reconstruye (`FR-051`: minor edit). */
export const updateReelRequestSchema = z
  .object({ revision: z.number().int().nonnegative(), reel: reelSpecSchema })
  .strict();
export type UpdateReelRequest = z.infer<typeof updateReelRequestSchema>;

/** `POST /reels/preview` — la composición HTML, idéntica a la del render. */
export const reelPreviewRequestSchema = z.object({ reel: reelSpecSchema }).strict();
export type ReelPreviewRequest = z.infer<typeof reelPreviewRequestSchema>;
export const reelPreviewResponseSchema = z
  .object({
    html: z.string(),
    durationSec: z.number(),
    warnings: z.array(z.string()),
  })
  .strict();
export type ReelPreviewResponse = z.infer<typeof reelPreviewResponseSchema>;

/** Plantillas de estructura del plan idea→spec (`packages/core/src/reels`). */
export const REEL_TEMPLATES = [
  "hook-reaction-punchline",
  "list-beats",
  "before-after",
] as const;
export const reelTemplateSchema = z.enum(REEL_TEMPLATES);
export type ReelTemplate = z.infer<typeof reelTemplateSchema>;

/** `POST /reels/from-prompt` — «Create from prompt» con formato reel. */
export const REEL_PROMPT_MAX = 500;
export const reelFromPromptRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(REEL_PROMPT_MAX),
    template: reelTemplateSchema.optional(),
  })
  .strict();
export type ReelFromPromptRequest = z.infer<typeof reelFromPromptRequestSchema>;

// --- Planificador semanal (sprint 9, U, `PU-S9-014`) ---------------------------------

/**
 * Estado de un reel del plan: `planned` (armado, esperando su día) →
 * `suggested` (entró a la cola de Blitz) → `accepted` / `discarded` →
 * `built` (la pieza quedó `CREATED`). `failed` = no se pudo armar (sin copy,
 * sin assets, spec inválido); el motivo va en `failureReason`.
 */
export const REEL_PLAN_ITEM_STATUSES = [
  "planned",
  "suggested",
  "accepted",
  "discarded",
  "built",
  "failed",
] as const;
export const reelPlanItemStatusSchema = z.enum(REEL_PLAN_ITEM_STATUSES);
export type ReelPlanItemStatus = z.infer<typeof reelPlanItemStatusSchema>;

/** Avisos del plan: códigos estables, la web los traduce. */
export const REEL_PLAN_NOTE_CODES = [
  /** Sin modelo `text`: la idea y el gancho salen del ángulo. */
  "llm_unavailable",
  /** Sin motor de subtítulos (whisper sin modelo): los reels salen sin subtítulos. */
  "captions_unavailable",
  /** El decisor no tenía juicio (Laya/Jev): eligió el ranking textual. */
  "decisor_fallback",
  /** La marca no tiene design system activo: colores y fuentes por defecto. */
  "no_design_system",
  /** Una familia de marca se reemplazó (licencia sin tildar, sin archivo). */
  "font_replaced",
  /** Sin fondos ni clips en la marca ni en la biblioteca: degradé del tema. */
  "no_media",
  /** El mix de la estrategia no pide reels. */
  "quota_zero",
] as const;
export const reelPlanNoteSchema = z
  .object({ code: z.enum(REEL_PLAN_NOTE_CODES), detail: z.string().max(300).optional() })
  .strict();
export type ReelPlanNote = z.infer<typeof reelPlanNoteSchema>;

export const reelPlanItemSchema = z
  .object({
    id: z.string().uuid(),
    /** Día local de la marca (`YYYY-MM-DD`) en que entra a la cola. */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: reelPlanItemStatusSchema,
    template: reelTemplateSchema,
    idea: z.string().nullable(),
    hook: z.string().nullable(),
    angle: z.object({ id: z.string(), title: z.string() }).strict().nullable(),
    durationSec: z.number().nullable(),
    /** Qué eligió el decisor, en una línea por rol («Background: picked …»). */
    picks: z.array(z.string()),
    posterUrl: z.string().url().nullable(),
    suggestionId: z.string().uuid().nullable(),
    contentId: z.string().uuid().nullable(),
    failureReason: z.string().nullable(),
    /** Alguna elección de este reel ignoró las preferencias (exploración). */
    explored: z.boolean(),
  })
  .strict();
export type ReelPlanItem = z.infer<typeof reelPlanItemSchema>;

export const reelWeekPlanSchema = z
  .object({
    id: z.string().uuid(),
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string(),
    quota: z.number().int().nonnegative(),
    notes: z.array(reelPlanNoteSchema),
    items: z.array(reelPlanItemSchema),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ReelWeekPlan = z.infer<typeof reelWeekPlanSchema>;

/** `GET /reels/plan` — el plan de esta semana (o `null`) y el cupo que da la estrategia. */
export const reelPlanViewSchema = z
  .object({
    plan: reelWeekPlanSchema.nullable(),
    /** Reels por semana que pide la estrategia hoy (`formatMix.reel`). */
    weeklyQuota: z.number().int().nonnegative(),
    /** El peso de `reel` en el mix (0 = apagado). */
    reelWeight: z.number().int().min(0).max(100),
  })
  .strict();
export type ReelPlanView = z.infer<typeof reelPlanViewSchema>;

/** `POST /reels/plan` → `202 { data: { requested: true } }`: rehace lo `planned` de la semana. */
export const reelPlanRequestSchema = z.object({}).strict();
export const reelPlanRequestedSchema = z.object({ requested: z.literal(true) }).strict();
