/**
 * Blitz · `POST /blitz` y `GET|PATCH /blitz/preferences` (PRD:2264, 2265).
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
 * Body de `POST /blitz`. Ambos campos son opcionales: sin `contentType` la cola
 * decide según los pesos; con él se fuerza un tipo (AI-002, PRD:2584).
 * `aspectRatio` sólo aplica a slideshow (FR-050 Validation, PRD:1129).
 */
export const runBlitzRequestSchema = z
  .object({
    contentType: blitzContentTypeSchema.optional(),
    aspectRatio: aspectRatioSchema.optional(),
  })
  .strict();
export type RunBlitzRequest = z.infer<typeof runBlitzRequestSchema>;

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
