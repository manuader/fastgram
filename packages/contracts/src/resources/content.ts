/**
 * Content · `POST /content`, `GET /content`, `GET /content/:id`,
 * `GET /content/:id/editable`, `PATCH /content/:id`,
 * `POST /content/:id/regenerate`, `DELETE /content/:id`,
 * `POST /content/custom/video/upload-url`, `POST /content/custom/video`
 * (PRD:2276-2284).
 *
 * Fuente: FR-070 payloads de build (PRD:1450-1459), FR-051 edición
 * (PRD:1177-1188), DATA-008 (PRD:2070) y DATA-009 (PRD:2090).
 *
 * `POST /content`, `PATCH /content/:id` y `POST /content/:id/regenerate` exigen
 * `Idempotency-Key` (§9.3, PRD:2288).
 */
import { z } from "zod";
import {
  aspectRatioSchema,
  contentStatusSchema,
  contentTypeSchema,
  fontFamilySchema,
  hexColorSchema,
  textAlignSchema,
  textBackgroundStyleSchema,
  FONT_WEIGHTS,
} from "../primitives/enums.js";
import {
  contentIdSchema,
  msEpochSchema,
  textBoxIdSchema,
  uploadIdSchema,
} from "../primitives/ids.js";
import { cursorQuerySchema } from "../primitives/pagination.js";

// --- Números del PRD ---------------------------------------------------------

/** FR-070 (PRD:1450) — "Máximo **20 slides** por slideshow". */
export const SLIDESHOW_MAX_SLIDES = 20;
/** FR-051 (PRD:1183) / DATA-009 (PRD:2090) — `text` ≤ 5 000, puede estar vacío. */
export const TEXT_BOX_MAX_LENGTH = 5000;
/** FR-051 (PRD:1184) — `position.x` / `position.y` ∈ [0, 100]. */
export const TEXT_POSITION_MIN = 0;
export const TEXT_POSITION_MAX = 100;
/** FR-051 (PRD:1184) — `widthPercent` ∈ [25, 100]. */
export const TEXT_WIDTH_PERCENT_MIN = 25;
export const TEXT_WIDTH_PERCENT_MAX = 100;
/** FR-051 (PRD:1184) — `font.size` ∈ [8, 72]. */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 72;
/** FR-051 (PRD:1184) — `stroke.width` ∈ [0, 8]. */
export const STROKE_WIDTH_MIN = 0;
export const STROKE_WIDTH_MAX = 8;
/** FR-051 (PRD:1185) — `background.opacity` ∈ [0, 1]. */
export const BACKGROUND_OPACITY_MIN = 0;
export const BACKGROUND_OPACITY_MAX = 1;
/** FR-051 (PRD:1187) / AI-004 (PRD:2603) — prompt de regeneración ≤ 500. */
export const REGENERATE_PROMPT_MAX = 500;
/** DATA-008 (PRD:2079) — `generatedText` normalizado ≤ 2 000. */
export const GENERATED_TEXT_MAX = 2000;
/** FR-070 (PRD:1453) — `fontWeight` del payload de build. */
export const BUILD_FONT_WEIGHT_MIN = 100;
export const BUILD_FONT_WEIGHT_MAX = 900;
/** ERR-P02 (PRD:3184) — un contenido `BUILDING` se puede borrar pasados 15 min. */
export const CONTENT_BUILD_DELETE_GRACE_MINUTES = 15;

// --- Caja de texto editable · DATA-009 (PRD:2090) ----------------------------

export const textFontSchema = z
  .object({
    family: fontFamilySchema,
    weight: z.number().int(),
    size: z.number().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX),
  })
  .strict()
  .refine((f) => FONT_WEIGHTS[f.family].includes(f.weight), {
    path: ["weight"],
    message: "weight is not available for this font family",
  });
export type TextFont = z.infer<typeof textFontSchema>;

export const textStrokeSchema = z
  .object({
    width: z.number().min(STROKE_WIDTH_MIN).max(STROKE_WIDTH_MAX),
    color: hexColorSchema,
  })
  .strict();
export type TextStroke = z.infer<typeof textStrokeSchema>;

/** `null` elimina el fondo (FR-051, PRD:1185). */
export const textBackgroundSchema = z
  .object({
    color: hexColorSchema,
    opacity: z.number().min(BACKGROUND_OPACITY_MIN).max(BACKGROUND_OPACITY_MAX),
    style: textBackgroundStyleSchema,
  })
  .strict()
  .nullable();
export type TextBackground = z.infer<typeof textBackgroundSchema>;

export const contentTextBoxSchema = z
  .object({
    id: textBoxIdSchema,
    slideIndex: z.number().int().nonnegative().optional(),
    text: z.string().max(TEXT_BOX_MAX_LENGTH),
    position: z
      .object({
        x: z.number().min(TEXT_POSITION_MIN).max(TEXT_POSITION_MAX),
        y: z.number().min(TEXT_POSITION_MIN).max(TEXT_POSITION_MAX),
      })
      .strict(),
    widthPercent: z.number().min(TEXT_WIDTH_PERCENT_MIN).max(TEXT_WIDTH_PERCENT_MAX),
    font: textFontSchema,
    color: hexColorSchema,
    stroke: textStrokeSchema,
    background: textBackgroundSchema,
  })
  .strict();
export type ContentTextBox = z.infer<typeof contentTextBoxSchema>;

// --- Payloads de build · FR-070 (PRD:1453-1460) ------------------------------

/** `canvas` = `{width, height}` en píxeles (p. ej. 1080×1920). */
export const canvasSchema = z
  .object({ width: z.number().int().positive(), height: z.number().int().positive() })
  .strict();
export type Canvas = z.infer<typeof canvasSchema>;

/** Canvas de slide: añade `aspectRatio` (FR-070, PRD:1458). */
export const slideCanvasSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    aspectRatio: aspectRatioSchema,
  })
  .strict();
export type SlideCanvas = z.infer<typeof slideCanvasSchema>;

/**
 * Elemento de media. "Cada elemento de media lleva `drawX/drawY/drawW/drawH`"
 * (FR-070, PRD:1454). La URL debe pertenecer al Media Bank del workspace o a la
 * librería compartida; una URL arbitraria es `400 bad_request` **antes** del
 * build (PRD:1459). Esa pertenencia la valida el servidor, no el schema.
 */
export const mediaElementSchema = z
  .object({
    url: z.string().url(),
    drawX: z.number(),
    drawY: z.number(),
    drawW: z.number(),
    drawH: z.number(),
  })
  .strict();
export type MediaElement = z.infer<typeof mediaElementSchema>;

/** "El audio sólo puede venir de la librería compartida" (FR-070, PRD:1459). */
export const audioElementSchema = z.object({ url: z.string().url() }).strict();
export type AudioElement = z.infer<typeof audioElementSchema>;

/** Objeto de texto común del payload de build (FR-070, PRD:1453). */
export const buildTextSchema = z
  .object({
    content: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    fontSize: z.number().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX),
    color: hexColorSchema,
    textAlign: textAlignSchema,
    fontWeight: z
      .number()
      .int()
      .min(BUILD_FONT_WEIGHT_MIN)
      .max(BUILD_FONT_WEIGHT_MAX)
      .optional(),
    strokeWidth: z.number().min(STROKE_WIDTH_MIN).max(STROKE_WIDTH_MAX).optional(),
    strokeColor: hexColorSchema.optional(),
    backgroundColor: hexColorSchema.optional(),
  })
  .strict();
export type BuildText = z.infer<typeof buildTextSchema>;

/** `wall-of-text`: `{canvas, video{url,draw…}, audio{url}, text}` (PRD:1455). */
export const wallOfTextBuildPayloadSchema = z
  .object({
    canvas: canvasSchema,
    video: mediaElementSchema,
    audio: audioElementSchema.optional(), // FR-053.1 (PRD:1234): `No audio` omite el bloque
    text: buildTextSchema,
  })
  .strict();
export type WallOfTextBuildPayload = z.infer<typeof wallOfTextBuildPayloadSchema>;

/**
 * `green-screen`: `{canvas, image{url,draw…}, video{url,draw…}, text}` — el
 * video con croma se compone **sobre** la imagen de fondo (PRD:1456).
 */
export const greenScreenBuildPayloadSchema = z
  .object({
    canvas: canvasSchema,
    image: mediaElementSchema,
    video: mediaElementSchema,
    // Sprint 7 (audio): música de la biblioteca de la marca, mezclada con el
    // audio del clip. Ausente = sólo el audio del clip, como siempre.
    audio: audioElementSchema.optional(),
    text: buildTextSchema,
  })
  .strict();
export type GreenScreenBuildPayload = z.infer<typeof greenScreenBuildPayloadSchema>;

/** `video-hook`: `{canvas, hook_video{…}, demo_video{…}, audio{url}, text}` (PRD:1457). */
export const videoHookBuildPayloadSchema = z
  .object({
    canvas: canvasSchema,
    hook_video: mediaElementSchema,
    demo_video: mediaElementSchema,
    audio: audioElementSchema.optional(), // FR-053.1 (PRD:1234)
    text: buildTextSchema,
  })
  .strict();
export type VideoHookBuildPayload = z.infer<typeof videoHookBuildPayloadSchema>;

export const slideshowSlideSchema = z
  .object({
    canvas: slideCanvasSchema,
    image: mediaElementSchema,
    texts: z.array(buildTextSchema),
  })
  .strict();
export type SlideshowSlide = z.infer<typeof slideshowSlideSchema>;

/**
 * `slideshow`: `{num_images, images:[…]}` con `num_images` igual a la longitud
 * de `images` (PRD:1458) y máximo 20 slides (PRD:1450).
 */
export const slideshowBuildPayloadSchema = z
  .object({
    num_images: z.number().int().positive().max(SLIDESHOW_MAX_SLIDES),
    images: z.array(slideshowSlideSchema).min(1).max(SLIDESHOW_MAX_SLIDES),
  })
  .strict()
  .refine((p) => p.num_images === p.images.length, {
    path: ["num_images"],
    message: "num_images must match images.length",
  });
export type SlideshowBuildPayload = z.infer<typeof slideshowBuildPayloadSchema>;

/**
 * El PRD define los cuatro payloads pero **no** un campo discriminante ni un
 * envoltorio para `POST /content`: el body *es* el payload. Con `.strict()` en
 * cada rama la unión discrimina por forma sin inventar una clave `type`.
 */
export const contentBuildPayloadSchema = z.union([
  wallOfTextBuildPayloadSchema,
  greenScreenBuildPayloadSchema,
  videoHookBuildPayloadSchema,
  slideshowBuildPayloadSchema,
]);
export type ContentBuildPayload = z.infer<typeof contentBuildPayloadSchema>;

export const createContentRequestSchema = contentBuildPayloadSchema;
export type CreateContentRequest = z.infer<typeof createContentRequestSchema>;

// --- Recurso -----------------------------------------------------------------

/**
 * Representación pública. `buildPayload` y `studioState` **nunca** se devuelven
 * por API (DATA-008, PRD:2082-2083) y por eso no están en el schema.
 * `lastEdit` sí es público (FR-051, PRD:1197) pero el PRD no enumera sus
 * campos: se contrata como objeto opaco y queda anotado como abierto.
 */
export const contentSchema = z
  .object({
    _id: contentIdSchema,
    type: contentTypeSchema,
    status: contentStatusSchema,
    files: z.array(z.string().url()),
    /**
     * **Opcional**, y el contrato decía que no.
     *
     * Una pieza en `BUILDING` **todavía no tiene thumbnail**, así que el caso
     * ausente no es excepcional: es el estado de toda pieza recién creada
     * mientras el worker la construye. Con el campo obligatorio, cualquier
     * cliente que valide la respuesta rechaza **cada build en curso** como
     * `invalid_response` — y tira el listado entero mientras el backend hace
     * exactamente lo que debe.
     *
     * `apps/api` ya lo tenía anotado como desajuste y lo resolvía omitiendo el
     * campo con un `Omit<Content, "thumbnailUrl">`; `apps/web` tuvo que poner un
     * schema local para poder pintar la Library. Dos parches del mismo lado
     * equivocado: el que estaba mal era el contrato.
     */
    thumbnailUrl: z.string().url().optional(),
    generatedText: z.string().max(GENERATED_TEXT_MAX).nullable().optional(),
    remixSourceUrl: z.string().url().nullable().optional(),
    revision: z.number().int().nonnegative(),
    lastEdit: z.record(z.unknown()).optional(),
    deletedAt: msEpochSchema.optional(),
  })
  .strict();
export type Content = z.infer<typeof contentSchema>;

/** Parser de listas separadas por comas, como las usa `GET /content` (§12, PRD:2721). */
const commaSeparated = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .min(1)
    .transform((raw) => raw.split(","))
    .pipe(z.array(item).min(1));

/**
 * `GET /content` · §12 (PRD:2721): filtros por `type` y `status`, ambos como
 * lista separada por comas; orden newest first.
 */
export const listContentQuerySchema = cursorQuerySchema
  .extend({
    type: commaSeparated(contentTypeSchema).optional(),
    status: commaSeparated(contentStatusSchema).optional(),
  })
  .strict();
export type ListContentQuery = z.infer<typeof listContentQuerySchema>;

// --- Media del editor · FR-051 `ASSETS`, FR-052, FR-053, FR-071 --------------

/**
 * La media vigente de una pieza (`GET /content/:id/editable`, `assets`).
 *
 * **No es `buildPayload`** (DATA-008 lo prohíbe): es la vista de sus elementos
 * de media, con los mismos nombres de `FR-070`, igual que `canvas` ya lo era.
 * El bloque `media` de `?include=media` (§9.7) es otra cosa y sigue sin
 * contratarse; por eso este campo se llama distinto.
 *
 * `audio` sólo aparece en los formatos de video (`wall-of-text`,
 * `video-hook` y, desde el sprint 7, `green-screen`); `null` = sin música
 * (`FR-053.1`).
 */
export const contentAssetsSchema = z
  .object({
    slides: z.array(mediaElementSchema).max(SLIDESHOW_MAX_SLIDES).optional(),
    image: mediaElementSchema.optional(),
    video: mediaElementSchema.optional(),
    hook_video: mediaElementSchema.optional(),
    demo_video: mediaElementSchema.optional(),
    audio: audioElementSchema.nullable().optional(),
  })
  .strict();
export type ContentAssets = z.infer<typeof contentAssetsSchema>;

/**
 * Parche sobre un elemento de media: `url` para el swap (`Swap Video`,
 * `Swap Image`), `draw*` para el zoom y la posición del video del green-screen
 * (`FR-051`, `Zoom`, `Drag video to reposition`). Lo que no viene se conserva.
 */
export const mediaElementPatchSchema = z
  .object({
    url: z.string().url().optional(),
    drawX: z.number().finite().optional(),
    drawY: z.number().finite().optional(),
    drawW: z.number().finite().positive().optional(),
    drawH: z.number().finite().positive().optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "media patch must change something",
  });
export type MediaElementPatch = z.infer<typeof mediaElementPatchSchema>;

/**
 * `assets` de `PATCH /content/:id`. Cada clave ausente = sin cambio.
 *
 * - `slides[]`: `Swap image for slide N` (`FR-071`), por índice; sólo slideshow.
 * - `audio: null`: `No audio` (`FR-053.1`); sólo `wall-of-text` y `video-hook`.
 * - Un slot que el formato no tiene, o un slide que no existe, es `400`.
 * - Toda URL **nueva** tiene que ser del Media Bank del workspace (imagen o
 *   video, del tipo que pide el slot) o, el audio, del catálogo compartido:
 *   si no, `400` antes del build (`FR-070`).
 */
export const contentAssetsPatchSchema = z
  .object({
    slides: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            image: mediaElementPatchSchema,
          })
          .strict(),
      )
      .min(1)
      .max(SLIDESHOW_MAX_SLIDES)
      .refine((s) => new Set(s.map((x) => x.index)).size === s.length, {
        message: "slide indexes must be unique",
      })
      .optional(),
    image: mediaElementPatchSchema.optional(),
    video: mediaElementPatchSchema.optional(),
    hook_video: mediaElementPatchSchema.optional(),
    demo_video: mediaElementPatchSchema.optional(),
    audio: audioElementSchema.nullable().optional(),
  })
  .strict();
export type ContentAssetsPatch = z.infer<typeof contentAssetsPatchSchema>;

// --- Edición · FR-051 --------------------------------------------------------

/**
 * `PATCH /content/:id`.
 *
 * `revision` es concurrencia optimista: si no coincide, `409 stale_revision`
 * (FR-051, PRD:1180). `textBoxes` vacío se rechaza **sin aplicar ningún cambio**
 * (PRD:1188), igual que los ids duplicados.
 */
export const updateContentRequestSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    textBoxes: z
      .array(contentTextBoxSchema)
      .min(1, "textBoxes must not be empty")
      .refine((boxes) => new Set(boxes.map((b) => b.id)).size === boxes.length, {
        message: "textBox ids must be unique",
      }),
    /** Swap de media del editor (`PU-EDIT-003`). Ver {@link contentAssetsPatchSchema}. */
    assets: contentAssetsPatchSchema.optional(),
  })
  .strict();
export type UpdateContentRequest = z.infer<typeof updateContentRequestSchema>;

/**
 * `GET /content/:id/editable`. ERR-F04 (PRD:3203): si el manifest legacy no se
 * puede parsear "se omite `media`, se mantienen `canvas` y texto editable" — de
 * ahí que estos dos sean los campos garantizados.
 *
 * El bloque `media` (sólo con `?include=media`, capacidad Partner · §9.7
 * PRD:2335) no se contrata: el PRD nombra únicamente su modo degradado
 * (`status: "unavailable"`, ERR-F03 PRD:3202), no su forma normal.
 */
export const editableContentSchema = z
  .object({
    canvas: canvasSchema,
    textBoxes: z.array(contentTextBoxSchema),
    /**
     * La media vigente —el payload original con los swaps del editor
     * aplicados—, para que el editor dibuje lo que va a salir (`PU-EDIT-003`).
     * Opcional: se omite cuando el payload no se puede leer (ERR-F04).
     */
    assets: contentAssetsSchema.optional(),
  })
  .strict();
export type EditableContent = z.infer<typeof editableContentSchema>;

/** ERR-F03 (PRD:3202) — layer de media no resoluble. */
export const unavailableMediaLayerSchema = z
  .object({ status: z.literal("unavailable") })
  .strict();
export type UnavailableMediaLayer = z.infer<typeof unavailableMediaLayerSchema>;

/**
 * `POST /content/:id/regenerate` · AI-004 (PRD:2602-2610).
 * Reescribe todas las cajas de texto preservando media, estructura y layout.
 */
export const regenerateContentRequestSchema = z
  .object({
    prompt: z.string().max(REGENERATE_PROMPT_MAX).optional(),
    mentionBusiness: z.boolean().optional(),
  })
  .strict();
export type RegenerateContentRequest = z.infer<typeof regenerateContentRequestSchema>;

/**
 * `POST /content/custom/video` — finalización de la subida de un video propio
 * (§9.8, PRD:2338). MP4/MOV, ≤ 50 MB; MOV se normaliza a MP4 en servidor
 * (FR-070, PRD:1463). El PRD no enumera más campos del body.
 */
export const createCustomVideoContentRequestSchema = z
  .object({ uploadId: uploadIdSchema })
  .strict();
export type CreateCustomVideoContentRequest = z.infer<
  typeof createCustomVideoContentRequestSchema
>;

// --- Content Studio · `F-071`…`F-083`, `P2-STUDIO-002/003/007/008` ----------

/** Los cuatro formatos base que el Studio arma a mano (los de Blitz). */
export const studioFormatSchema = z.enum([
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
]);
export type StudioFormat = z.infer<typeof studioFormatSchema>;

/** Tope del brief para la IA. Mismo que `REGENERATE_PROMPT_MAX` (AI-004). */
export const STUDIO_AI_PROMPT_MAX = REGENERATE_PROMPT_MAX;

/**
 * `POST /content/studio` — «Create New» del Content Studio.
 *
 * El cliente manda **qué** eligió (ids del Media Bank, textos, estilo) y el
 * servidor arma el payload de `FR-070` con la misma geometría que Blitz
 * (`composeBlitzBuildPayload`): el Studio y Blitz producen piezas iguales.
 *
 * - `media`: por formato — `slides` (slideshow, 1–20 imágenes), `video`
 *   (wall-of-text: fondo; green-screen: el clip), `image` (green-screen:
 *   fondo), `hookVideo` + `demoVideo` (video-hook).
 * - `texts`: uno por slide en slideshow; uno en el resto.
 * - `ai`: el texto lo escribe el modelo de la tarea `text` en el worker,
 *   **antes** de renderizar, con `prompt` como brief. `texts` queda como
 *   borrador/estructura. Sin modelo la pieza cierra `FAILED` con
 *   `llm_not_configured` y el save se devuelve.
 */
export const studioContentRequestSchema = z
  .object({
    format: studioFormatSchema,
    media: z
      .object({
        slides: z.array(z.string().uuid()).min(1).max(SLIDESHOW_MAX_SLIDES).optional(),
        video: z.string().uuid().optional(),
        image: z.string().uuid().optional(),
        hookVideo: z.string().uuid().optional(),
        demoVideo: z.string().uuid().optional(),
      })
      .strict(),
    texts: z.array(z.string().max(TEXT_BOX_MAX_LENGTH)).min(1).max(SLIDESHOW_MAX_SLIDES),
    textStylePresetId: z.string().min(1).optional(),
    aspectRatio: aspectRatioSchema.optional(),
    ai: z
      .object({
        prompt: z.string().trim().min(1).max(STUDIO_AI_PROMPT_MAX),
        mentionBusiness: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type StudioContentRequest = z.infer<typeof studioContentRequestSchema>;
