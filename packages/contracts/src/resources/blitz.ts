/**
 * Blitz · `POST /blitz` y `GET|PATCH /blitz/preferences` (PRD:2264, 2265).
 *
 * `GET /blitz/queue` la muestra y `POST /blitz/queue/:id/discard` descarta sin
 * cobrar (PU-BLITZ-002).
 *
 * `POST /blitz` saca una sugerencia lista de la discovery queue, descuenta
 * 1 swipe + 1 content save y lanza el build (FR-050, PRD:1108). Devuelve `202`
 * inmediatamente (NFR-001, PRD:2951) y **no es idempotente** (FR-050 PRD:1112,
 * NFR-005 PRD:2955): nunca se reintenta solo. Cola vacía → `404 not_found`
 * (ERR-E11, PRD:3103).
 */
import { z } from "zod";
import {
  aspectRatioSchema,
  blitzContentTypeSchema,
  genderFilterSchema,
} from "../primitives/enums.js";

/**
 * Body de `POST /blitz`. Todos los campos son opcionales: sin `contentType` la cola
 * decide según los pesos; con él se fuerza un tipo (AI-002, PRD:2584).
 * `aspectRatio` sólo aplica a slideshow (FR-050 Validation, PRD:1129).
 *
 * `suggestionId` (`PU-BLITZ-002`): acepta **esa** sugerencia de `GET /blitz/queue`
 * y no "la de turno". Sin él, aceptar es sacar la más nueva de la cola, y un
 * refill que entre entre el render del deck y el swipe cambiaría cuál es. Una
 * sugerencia que ya no está `queued` → `409 conflict`; ajena o inexistente → `404`.
 */
export const runBlitzRequestSchema = z
  .object({
    contentType: blitzContentTypeSchema.optional(),
    aspectRatio: aspectRatioSchema.optional(),
    suggestionId: z.string().min(1).optional(),
  })
  .strict();
export type RunBlitzRequest = z.infer<typeof runBlitzRequestSchema>;

// --- La cola, vista · `GET /blitz/queue` (PU-BLITZ-002) ----------------------
//
// La forma la fijó el consumidor antes que el servidor: `deckSuggestionSchema` en
// `apps/web/src/lib/blitz/deck/suggestion.ts`, que es **tolerante** (nullable,
// sin `.strict()`). Acá es la misma forma **estricta**: el servidor omite lo que
// no tiene en vez de mandar `null`, y no manda claves que el deck no conozca. Lo
// que el servidor emite siempre valida contra el schema del cliente.

/** De dónde sale un remix. Sólo viaja si la sugerencia tiene URL de origen. */
export const blitzSuggestionRemixSourceSchema = z
  .object({
    url: z.string().url(),
    thumbnailUrl: z.string().url().optional(),
    likes: z.number().int().nonnegative().optional(),
    views: z.number().int().nonnegative().optional(),
  })
  .strict();

export const blitzSuggestionSlideSchema = z
  .object({
    imageUrl: z.string().url().optional(),
    text: z.string().optional(),
  })
  .strict();

/**
 * La preview de la tarjeta, armada con la media que eligió el refill
 * (`build_plan`) y la URL **de hoy** de cada asset (la misma `r2Url` que devuelve
 * `GET /media`). Un asset borrado después de planificar simplemente no aparece.
 */
export const blitzSuggestionPreviewSchema = z
  .object({
    /** Slideshow: una por slide, con su texto. */
    slides: z.array(blitzSuggestionSlideSchema).optional(),
    /** Fondo de los tipos de video: el video (o la imagen de fondo del green screen). */
    backgroundUrl: z.string().url().optional(),
    audioUrl: z.string().url().optional(),
    aspectRatio: aspectRatioSchema.optional(),
  })
  .strict();

export const blitzSuggestionSchema = z
  .object({
    id: z.string().min(1),
    contentType: blitzContentTypeSchema,
    generatedText: z.string().optional(),
    /** FR-050 criterio 3: el racional **almacenado**, nunca uno generado al vuelo. */
    aiExplanation: z.string().optional(),
    influencer: z
      .object({ id: z.string(), name: z.string().min(1) })
      .strict()
      .optional(),
    angle: z
      .object({ id: z.string(), title: z.string().min(1) })
      .strict()
      .optional(),
    remixSource: blitzSuggestionRemixSourceSchema.optional(),
    preview: blitzSuggestionPreviewSchema.optional(),
    /**
     * `PU-BLITZ-003`: el pedido de «crear desde prompt» que la produjo. Sólo
     * viaja si salió de uno; es lo que dibuja el chip «From your prompt». Las
     * que lo traen van primeras en la cola.
     */
    promptRequestId: z.string().min(1).optional(),
    /**
     * Sprint 7: el meme lo encontró solo «crear desde prompt» (YouTube) porque
     * el Media Bank no tenía uno para el tema. Dibuja el chip «Auto-found
     * meme»; `sourceUrl` es de dónde salió (D-12: el dueño decide).
     */
    autoFoundMeme: z.object({ sourceUrl: z.string().url() }).strict().optional(),
  })
  .strict();
export type BlitzSuggestion = z.infer<typeof blitzSuggestionSchema>;

/**
 * `GET /blitz/queue` → `200 { data: BlitzSuggestion[] }`, en el **mismo orden en
 * que `POST /blitz` sin `suggestionId` las consume** (la primera es la que saldría).
 */
export const blitzQueueSchema = z.array(blitzSuggestionSchema);
export type BlitzQueue = z.infer<typeof blitzQueueSchema>;

/**
 * `GET /blitz/queue/counts?brands=current|all` → cuántas tarjetas esperan en
 * cada marca del dueño ("Today", `PU-UI-002`). Sólo lee: **no** pide relleno
 * (al revés que `GET /blitz/queue`) y no cobra. En `standard`, "all" es la
 * marca de la request.
 */
export const BLITZ_QUEUE_COUNT_SCOPES = ["current", "all"] as const;
export const blitzQueueCountsQuerySchema = z
  .object({ brands: z.enum(BLITZ_QUEUE_COUNT_SCOPES).default("current") })
  .strict();
export type BlitzQueueCountsQuery = z.infer<typeof blitzQueueCountsQuerySchema>;

export const blitzQueueCountSchema = z
  .object({
    brandId: z.string().uuid(),
    queued: z.number().int().nonnegative(),
  })
  .strict();
export type BlitzQueueCount = z.infer<typeof blitzQueueCountSchema>;
export const blitzQueueCountsSchema = z.array(blitzQueueCountSchema);
export type BlitzQueueCounts = z.infer<typeof blitzQueueCountsSchema>;

// --- Crear desde prompt · `POST /blitz/generate` (PU-BLITZ-003, EXT-009) ------
//
// El usuario escribe un tema y, si quiere, fuerza el formato y la cantidad. La
// API encola un job y devuelve `202 { requestId }`; la web pregunta por el
// estado con `GET /blitz/generate/:requestId` hasta `done` o `failed`. Las
// sugerencias que produce entran **primeras** en `GET /blitz/queue`.
//
// Los límites (3–500 caracteres, 1–5 piezas) son de la tarea, no del PRD; la
// base los repite en CHECKs (migración `0012`).

export const BLITZ_PROMPT_MIN_CHARS = 3;
export const BLITZ_PROMPT_MAX_CHARS = 500;
export const BLITZ_PROMPT_MAX_COUNT = 5;

/** Body de `POST /blitz/generate`. Requiere `Idempotency-Key`. */
export const generateBlitzRequestSchema = z
  .object({
    /** El tema. Se recorta antes de medir: tres espacios no son un tema. */
    prompt: z.string().trim().min(BLITZ_PROMPT_MIN_CHARS).max(BLITZ_PROMPT_MAX_CHARS),
    /** Fuerza el formato. Sin él, lo decide el content mix. */
    contentType: blitzContentTypeSchema.optional(),
    /** Cuántas piezas. Default 1. */
    count: z.number().int().min(1).max(BLITZ_PROMPT_MAX_COUNT).optional(),
  })
  .strict();
export type GenerateBlitzRequest = z.infer<typeof generateBlitzRequestSchema>;

/** `202 { data: { requestId } }`. */
export const generateBlitzAcceptedSchema = z
  .object({ requestId: z.string().min(1) })
  .strict();
export type GenerateBlitzAccepted = z.infer<typeof generateBlitzAcceptedSchema>;

export const BLITZ_PROMPT_STATUSES = ["queued", "running", "done", "failed"] as const;
/** Sprint 7: las fases de un pedido `running` (`PROMPT_PHASES` de `core`). */
export const BLITZ_PROMPT_PHASES = ["searching_meme"] as const;
export const blitzPromptStatusSchema = z.enum(BLITZ_PROMPT_STATUSES);
export type BlitzPromptStatus = z.infer<typeof blitzPromptStatusSchema>;

/**
 * Por qué falló un pedido — **códigos estables**, los `PROMPT_FAILURE_REASONS`
 * de `core`. La web traduce cada uno a qué hacer (`llm_not_configured` →
 * Settings → Models; `no_media_for_format` / `no_media` → Library).
 */
export const BLITZ_PROMPT_FAILURE_REASONS = [
  "llm_not_configured",
  "no_media_for_format",
  "no_media",
  "copy_rejected",
  "llm_failed",
  "invalid_state",
  /** Sprint 7: era green-screen, no había meme para el tema y la búsqueda no encontró uno. */
  "meme_not_found",
] as const;
export const blitzPromptFailureReasonSchema = z.enum(BLITZ_PROMPT_FAILURE_REASONS);
export type BlitzPromptFailureReason = z.infer<typeof blitzPromptFailureReasonSchema>;

/** `GET /blitz/generate/:requestId` → `200 { data }`. */
export const blitzPromptRequestSchema = z
  .object({
    requestId: z.string().min(1),
    status: blitzPromptStatusSchema,
    /** Las sugerencias que produjo, en el orden de la cola. Vacío hasta `done`. */
    suggestionIds: z.array(z.string().min(1)),
    /** Sólo con `status: failed`. */
    failureReason: blitzPromptFailureReasonSchema.optional(),
    /** El formato forzado, si hubo. */
    contentType: blitzContentTypeSchema.optional(),
    count: z.number().int().min(1).max(BLITZ_PROMPT_MAX_COUNT),
    /**
     * Sprint 7: en qué anda un pedido `running`. `searching_meme` = buscando e
     * importando un meme (tarda más que escribir la copy). Ausente = lo de siempre.
     */
    phase: z.enum(BLITZ_PROMPT_PHASES).optional(),
  })
  .strict();
export type BlitzPromptRequest = z.infer<typeof blitzPromptRequestSchema>;

// --- Preferences · FR-055 (PRD:1285-1300) ------------------------------------

/** FR-055 (PRD:1269) — "Los cuatro juntos o ninguno; suma exacta = 100". */
export const CONTENT_MIX_WEIGHT_SUM = 100;

const percentage = z.number().min(0).max(100);

/**
 * Los cuatro pesos del content mix. Se validan **como unidad**: un set parcial
 * es `400 bad_request` (FR-055 Validation, PRD:1292). Por eso viven en su propio
 * objeto y el PATCH lo acepta entero o no lo acepta.
 */
export const contentMixWeightsSchema = z
  .object({
    slideshowWeight: percentage,
    wallOfTextWeight: percentage,
    greenScreenWeight: percentage,
    videoHookWeight: percentage,
  })
  .strict()
  .refine(
    (w) =>
      w.slideshowWeight + w.wallOfTextWeight + w.greenScreenWeight + w.videoHookWeight ===
      CONTENT_MIX_WEIGHT_SUM,
    { message: `content mix weights must sum to exactly ${CONTENT_MIX_WEIGHT_SUM}` },
  );
export type ContentMixWeights = z.infer<typeof contentMixWeightsSchema>;

/**
 * `angleWeights` · FR-055 (PRD:1276): mapa `{angleId: peso}` que cubre **todos**
 * los ángulos activos y suma 100. El mapa vacío es el caso "0 ángulos activos",
 * en el que el auto-reconcile lo limpia (FR-055, PRD:1288).
 */
export const angleWeightsSchema = z.record(z.string().min(1), percentage).refine(
  (map) => {
    const values = Object.values(map);
    if (values.length === 0) return true;
    return values.reduce((a, b) => a + b, 0) === CONTENT_MIX_WEIGHT_SUM;
  },
  { message: `angleWeights must sum to exactly ${CONTENT_MIX_WEIGHT_SUM}` },
);
export type AngleWeights = z.infer<typeof angleWeightsSchema>;

/** Los siete presets, como array, para poder validar claves de mapa. */
export const TEXT_STYLE_PRESET_IDS: readonly string[] = [
  "tiktok-classic",
  "bold-impact",
  "snapchat",
  "white-box",
  "yellow-pop",
  "clean-karaoke",
  "script-playful",
];

/**
 * `textStyleWeights` · FR-055 (PRD:1277): mapa `{presetId: peso entero}` que
 * suma 100, **o `{}` para desactivar**. Un preset desconocido → `400`
 * (FR-055 Validation, PRD:1292), de ahí el `superRefine` sobre las claves.
 */
export const textStyleWeightsSchema = z
  .record(z.string().min(1), z.number().int().min(0).max(100))
  .superRefine((map, ctx) => {
    const entries = Object.entries(map);
    if (entries.length === 0) return; // `{}` desactiva
    for (const [key] of entries) {
      if (!TEXT_STYLE_PRESET_IDS.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown text style preset: ${key}`,
        });
      }
    }
    const sum = entries.reduce((acc, [, v]) => acc + v, 0);
    if (sum !== CONTENT_MIX_WEIGHT_SUM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `textStyleWeights must sum to exactly ${CONTENT_MIX_WEIGHT_SUM}`,
      });
    }
  });
export type TextStyleWeights = z.infer<typeof textStyleWeightsSchema>;

/** FR-055 (PRD:1273) — `influencerChance` default 50, decimales aceptados. */
export const INFLUENCER_CHANCE_DEFAULT = 50;
/** AI-014 (PRD:2688) / FR-055 (PRD:1274) — `smartTextPositioning` default `true`. */
export const SMART_TEXT_POSITIONING_DEFAULT = true;

/**
 * `settingsApplication` es **sólo de respuesta**: enviarlo en un PATCH devuelve
 * `400 bad_request` (FR-055 regla 7, PRD:1288).
 */
export const settingsApplicationSchema = z
  .object({
    mode: z.literal("future_generations"),
    targetQueuedItems: z.literal(5),
  })
  .strict();
export type SettingsApplication = z.infer<typeof settingsApplicationSchema>;

/** FR-055 (PRD:1288) — objetivo de la discovery queue. */
export const DISCOVERY_QUEUE_TARGET_ITEMS = 5;

export const blitzPreferencesSchema = z
  .object({
    slideshowWeight: percentage,
    wallOfTextWeight: percentage,
    greenScreenWeight: percentage,
    videoHookWeight: percentage,
    remixPercentage: percentage,
    ownMediaPercentage: percentage,
    mentionBusinessPercentage: percentage,
    influencerChance: percentage,
    smartTextPositioning: z.boolean(),
    genderFilter: genderFilterSchema.nullable(),
    angleWeights: angleWeightsSchema,
    textStyleWeights: textStyleWeightsSchema,
    settingsApplication: settingsApplicationSchema,
  })
  .strict();
export type BlitzPreferences = z.infer<typeof blitzPreferencesSchema>;

/**
 * Body de `PATCH /blitz/preferences`.
 *
 * Reglas del PRD que el schema hace cumplir (FR-055 Validation, PRD:1292):
 *  - body vacío `{}` → `400`;
 *  - set parcial de los cuatro pesos → `400` (los cuatro o ninguno);
 *  - `settingsApplication` en el body → `400` (es sólo de respuesta).
 * `.strict()` cubre el tercer caso rechazando la clave como desconocida.
 */
export const updateBlitzPreferencesRequestSchema = z
  .object({
    slideshowWeight: percentage,
    wallOfTextWeight: percentage,
    greenScreenWeight: percentage,
    videoHookWeight: percentage,
    remixPercentage: percentage,
    ownMediaPercentage: percentage,
    mentionBusinessPercentage: percentage,
    influencerChance: percentage,
    smartTextPositioning: z.boolean(),
    genderFilter: genderFilterSchema.nullable(),
    angleWeights: angleWeightsSchema,
    textStyleWeights: textStyleWeightsSchema,
  })
  .strict()
  .partial()
  .superRefine((body, ctx) => {
    if (Object.keys(body).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "empty body is not allowed" });
    }
    const mix = [
      body.slideshowWeight,
      body.wallOfTextWeight,
      body.greenScreenWeight,
      body.videoHookWeight,
    ];
    const present = mix.filter((v) => v !== undefined) as number[];
    if (present.length !== 0 && present.length !== mix.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content mix weights must be sent all four together or not at all",
      });
    }
    if (
      present.length === mix.length &&
      present.reduce((a, b) => a + b, 0) !== CONTENT_MIX_WEIGHT_SUM
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `content mix weights must sum to exactly ${CONTENT_MIX_WEIGHT_SUM}`,
      });
    }
  });
export type UpdateBlitzPreferencesRequest = z.infer<
  typeof updateBlitzPreferencesRequestSchema
>;
