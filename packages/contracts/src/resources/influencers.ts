/**
 * Influencers · `GET /influencers`, `POST /influencers/base-image/upload-url`,
 * `POST /influencers`, `GET /influencers/:id` (PRD:2269-2272).
 *
 * Fuente: FR-080 (PRD:1481-1522), DATA-013 (PRD:2102), AI-007 (PRD:2630).
 *
 * `POST /influencers` es **facturable e idempotente**: exige `Idempotency-Key`
 * (PRD:2288, FR-080 PRD:1514) para que un reintento no duplique el personaje ni
 * reserve créditos dos veces.
 */
import { z } from "zod";
import { influencerStatusSchema } from "../primitives/enums.js";
import { influencerIdSchema, msEpochSchema, uploadIdSchema } from "../primitives/ids.js";
import {
  budgetSummarySchema,
  costEstimateSchema,
  generationErrorCodeSchema,
  generationMediaSchema,
  genModelSpecSchema,
} from "./genai.js";

// --- Números del PRD ---------------------------------------------------------

/** FR-080 (PRD:1496) — slider de edad 18–60. */
export const INFLUENCER_AGE_MIN = 18;
export const INFLUENCER_AGE_MAX = 60;
/** FR-080 (PRD:1496) — default del slider. */
export const INFLUENCER_AGE_DEFAULT = 25;
/** FR-080 (PRD:1513) / DATA-013 (PRD:2102) — cap de activos por workspace. */
export const MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE = 50;
/** DATA-013 (PRD:2102) — `progress` entero 0–100. */
export const INFLUENCER_PROGRESS_MIN = 0;
export const INFLUENCER_PROGRESS_MAX = 100;

/**
 * Costes en créditos, CONFIRMED en UI (FR-080, PRD:1517).
 * Viven en el contrato porque el 402 de créditos insuficientes devuelve
 * `details.required` y el cliente necesita el mismo número para anticiparlo.
 */
export const INFLUENCER_CREDITS_BASE_IMAGE = 4;
export const INFLUENCER_CREDITS_CREATE = 250;
export const INFLUENCER_CREDITS_IMAGE_GENERATION = 4;
export const INFLUENCER_CREDITS_VIDEO_GENERATION = 60;

// --- Recurso -----------------------------------------------------------------

/**
 * El PRD no enumera valores de `gender` ni de `ethnicity`: la UI los describe
 * como select con placeholder `Select…` y campo de texto respectivamente
 * (FR-080, PRD:1496), sin listar opciones. Se contratan como strings libres y
 * queda anotado como abierto.
 */
// --- Personaje del proveedor — `PU-LATER-004` ---------------------------------

/**
 * Fotos de referencia para crear el personaje. Higgsfield acepta 1–100
 * (`/docs/models/soul-id/create-character`); 4–20 es decisión nuestra
 * (`INFLUENCER_REFERENCE_LIMITS` en `core`, que el test de rutas compara).
 */
export const INFLUENCER_REFERENCES_MIN = 4;
export const INFLUENCER_REFERENCES_MAX = 20;

/** SOUL V2 ∩ los formatos de la app, y su `batch_size` (1 o 4). */
export const influencerImageAspectRatioSchema = z.enum([
  "9:16",
  "3:4",
  "1:1",
  "4:3",
  "16:9",
]);
export const INFLUENCER_IMAGE_COUNTS = [1, 4] as const;

/** Por qué un influencer quedó `failed`. Cada código tiene su copy en la UI. */
export const influencerFailureCodeSchema = z.enum([
  "not_configured",
  "references_missing",
  "upload_failed",
  "training_failed",
  "quota_exceeded",
  "unauthorized",
  "rate_limited",
  "provider_unavailable",
  "bad_request",
  "timeout",
  "provider_contract_violation",
]);
export type InfluencerFailureCode = z.infer<typeof influencerFailureCodeSchema>;

/**
 * `gender`, `age` y `ethnicity` son opcionales desde `PU-LATER-004`: con fotos de
 * referencia el personaje sale de las fotos, y los rasgos son etiquetas.
 */
export const influencerSchema = z
  .object({
    _id: influencerIdSchema,
    name: z.string().min(1),
    gender: z.string().min(1).optional(),
    age: z.number().int().min(INFLUENCER_AGE_MIN).max(INFLUENCER_AGE_MAX).optional(),
    ethnicity: z.string().min(1).optional(),
    baseImageUrl: z.string().url(),
    status: influencerStatusSchema,
    progress: z.number().int().min(INFLUENCER_PROGRESS_MIN).max(INFLUENCER_PROGRESS_MAX),
    isActive: z.boolean(),
    /** Las fotos del Media Bank con que se creó el personaje. */
    referenceMediaIds: z.array(z.string().uuid()).optional(),
    /** Con `status: "failed"`: por qué, con un código estable. */
    failure: z
      .object({ code: influencerFailureCodeSchema, message: z.string() })
      .strict()
      .optional(),
    /** Sprint 7 (`F-093`): de qué personaje salió éste al regenerar. */
    regeneratedFromId: z.string().uuid().optional(),
    createdAt: msEpochSchema,
    updatedAt: msEpochSchema,
  })
  .strict();
export type Influencer = z.infer<typeof influencerSchema>;

/**
 * `POST /influencers`. Dos rutas mutuamente excluyentes (FR-080, PRD:1494):
 * describir el personaje para que se genere la imagen base, o subir la propia
 * (`uploadId` de `POST /influencers/base-image/upload-url`).
 */
export const createInfluencerRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    gender: z.string().trim().min(1).max(40).optional(),
    /**
     * Sin default desde `PU-LATER-004`: el 25 del PRD es el valor inicial del
     * slider (la UI lo pone), no una edad que el servidor le asigne a un
     * personaje que salió de fotos.
     */
    age: z.number().int().min(INFLUENCER_AGE_MIN).max(INFLUENCER_AGE_MAX).optional(),
    ethnicity: z.string().trim().min(1).max(60).optional(),
    additionalDetails: z.string().max(500).optional(),
    baseImageUploadId: uploadIdSchema.optional(),
    /**
     * `PU-LATER-004`: 4–20 imágenes del Media Bank. Con esto el personaje se
     * crea en Higgsfield (Soul ID). Excluyente con `baseImageUploadId`.
     */
    referenceMediaIds: z
      .array(z.string().uuid())
      .min(INFLUENCER_REFERENCES_MIN)
      .max(INFLUENCER_REFERENCES_MAX)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "referenceMediaIds must be unique",
      })
      .optional(),
    /**
     * Sprint 7 (`P4-INFL-003`, `F-091`): la imagen base **generada por texto**
     * (una generación de AI Studio ya en el Media Bank). El personaje se crea
     * en Higgsfield desde esa sola foto (Soul ID acepta 1–100). Excluyente
     * con `referenceMediaIds` y `baseImageUploadId`.
     */
    generatedBaseMediaId: z.string().uuid().optional(),
    /** Sprint 7 (`F-093`): regenerar = persona nueva; el viejo se conserva. */
    regeneratedFromId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (b) =>
      [b.referenceMediaIds, b.baseImageUploadId, b.generatedBaseMediaId].filter(
        (x) => x !== undefined,
      ).length <= 1,
    {
      path: ["referenceMediaIds"],
      message: "Use reference photos, a generated base image or an upload — only one",
    },
  );
export type CreateInfluencerRequest = z.infer<typeof createInfluencerRequestSchema>;

// --- Setup, imágenes del personaje — `PU-LATER-004`, `FR-081` ------------------

/**
 * `GET /influencers/setup`: si se puede crear un personaje y con qué.
 * `trainingCost` es `null` a propósito: Higgsfield no publica el precio de
 * crear un personaje ni un estimador para ese endpoint. Se crea sólo si el
 * mes tiene saldo (`budget.remainingUsd > 0`).
 */
export const influencerSetupSchema = z.object({
  configured: z.boolean(),
  provider: z.literal("higgsfield").nullable(),
  references: z.object({ min: z.number().int(), max: z.number().int() }),
  trainingCost: costEstimateSchema.nullable(),
  canCreate: z.boolean(),
  budget: budgetSummarySchema,
  /**
   * Sprint 7 (`FR-082`, `F-099`): los modelos de Higgsfield que animan una
   * imagen (image-to-video). Vacío si Higgsfield no está configurado.
   */
  videoModels: z.array(genModelSpecSchema).default([]),
  /** Sprint 7 (`P4-INFL-003`): hay un modelo de imagen para la base por texto. */
  canGenerateBase: z.boolean().default(false),
});
export type InfluencerSetup = z.infer<typeof influencerSetupSchema>;

export const influencerImageRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    aspectRatio: influencerImageAspectRatioSchema.default("9:16"),
    count: z
      .number()
      .int()
      .refine((n) => (INFLUENCER_IMAGE_COUNTS as readonly number[]).includes(n), {
        message: "count must be 1 or 4",
      })
      .default(1),
  })
  .strict();
export type InfluencerImageRequest = z.input<typeof influencerImageRequestSchema>;

export const influencerImageEstimateSchema = z.object({
  model: z.string(),
  estimate: costEstimateSchema,
  budget: budgetSummarySchema,
  fits: z.boolean(),
});
export type InfluencerImageEstimate = z.infer<typeof influencerImageEstimateSchema>;

export const influencerGenerationSchema = z.object({
  id: z.string().uuid(),
  influencerId: z.string().uuid(),
  /** Sprint 7: `video` = una imagen animada (`F-099`). */
  kind: z.enum(["image", "video"]).default("image"),
  durationSeconds: z.number().int().positive().nullable().default(null),
  /** La imagen que se animó. */
  sourceMediaId: z.string().uuid().nullable().default(null),
  status: z.enum(["queued", "generating", "ready", "failed", "nsfw"]),
  model: z.string(),
  prompt: z.string(),
  aspectRatio: z.string(),
  count: z.number().int().positive(),
  estimate: costEstimateSchema,
  /** En el Media Bank, ya copiadas. Vacío hasta `ready`. */
  media: z.array(generationMediaSchema),
  error: z.object({ code: generationErrorCodeSchema, message: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InfluencerGeneration = z.infer<typeof influencerGenerationSchema>;
export const influencerGenerationListSchema = z.array(influencerGenerationSchema);

// --- Sprint 7 (agente G): Configuration, templates, base por texto y video ---

/** `blitz.ts`: el cap de ángulos es del lado del influencer. */
export const INFLUENCER_MAX_ANGLES = 10;

export const influencerPublishingAccountSchema = z
  .object({
    platform: z.string().min(1).max(40),
    connectionId: z.string().uuid(),
    enabled: z.boolean(),
  })
  .strict();

/** `FR-083` / `DATA-015`. */
export const influencerConfigSchema = z.object({
  angleIds: z.array(z.string().uuid()).max(INFLUENCER_MAX_ANGLES),
  publishingAccounts: z.array(influencerPublishingAccountSchema).max(100),
  slideshowSetIds: z.array(z.string().uuid()).max(100),
  videoSetIds: z.array(z.string().uuid()).max(100),
});
export type InfluencerConfig = z.infer<typeof influencerConfigSchema>;

/** `PUT /influencers/{id}/config`: lo que se manda se reemplaza; lo demás queda. */
export const updateInfluencerConfigRequestSchema = influencerConfigSchema
  .partial()
  .strict();
export type UpdateInfluencerConfigRequest = z.infer<
  typeof updateInfluencerConfigRequestSchema
>;

/** `GET /influencers/{id}/config`: la config y entre qué se elige. */
export const influencerConfigViewSchema = z.object({
  config: influencerConfigSchema,
  options: z.object({
    angles: z.array(z.object({ id: z.string().uuid(), title: z.string() })),
    accounts: z.array(
      z.object({
        connectionId: z.string().uuid(),
        platform: z.string(),
        username: z.string().nullable(),
        displayName: z.string().nullable(),
      }),
    ),
    sets: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        kind: z.enum(["SLIDESHOW", "VIDEO", "CURATED"]),
        mediaCount: z.number().int().nonnegative(),
      }),
    ),
  }),
  updatedAt: z.string().nullable(),
});
export type InfluencerConfigView = z.infer<typeof influencerConfigViewSchema>;

export const INFLUENCER_TEMPLATES_MAX = 30;
export const influencerTemplateSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    label: z.string().trim().min(1).max(40),
    /** `{subject}` = her / him / them. */
    prompt: z.string().trim().min(1).max(500),
  })
  .strict();
export type InfluencerTemplate = z.infer<typeof influencerTemplateSchema>;

export const influencerTemplatesViewSchema = z.object({
  templates: z.array(influencerTemplateSchema),
  /** `false` = la lista de fábrica. */
  customized: z.boolean(),
});
export type InfluencerTemplatesView = z.infer<typeof influencerTemplatesViewSchema>;

/** `PUT /influencers/templates`. `null` = volver a la lista de fábrica. */
export const updateInfluencerTemplatesRequestSchema = z
  .object({
    templates: z.array(influencerTemplateSchema).max(INFLUENCER_TEMPLATES_MAX).nullable(),
  })
  .strict();
export type UpdateInfluencerTemplatesRequest = z.infer<
  typeof updateInfluencerTemplatesRequestSchema
>;

/** `POST /influencers/base-image` (+ `/estimate`): imagen base por texto. */
export const influencerBaseImageRequestSchema = z
  .object({
    gender: z.string().trim().max(40).optional(),
    age: z.number().int().min(INFLUENCER_AGE_MIN).max(INFLUENCER_AGE_MAX).optional(),
    ethnicity: z.string().trim().max(60).optional(),
    details: z.string().max(500).optional(),
    /** «Regeneration instructions» (`FR-080` paso 2). */
    instructions: z.string().max(500).optional(),
  })
  .strict();
export type InfluencerBaseImageRequest = z.infer<typeof influencerBaseImageRequestSchema>;

export const INFLUENCER_VIDEO_PROMPT_MAX = 1000;

/** `POST /influencers/{id}/videos` (+ `/estimate`): «Animate this image». */
export const influencerVideoRequestSchema = z
  .object({
    /** Una imagen del Media Bank (de la galería del influencer). */
    sourceMediaId: z.string().uuid(),
    /** «describe the motion (optional…)» (`FR-082`). */
    prompt: z.string().max(INFLUENCER_VIDEO_PROMPT_MAX).default(""),
    model: z.string().trim().min(1).max(256),
    durationSeconds: z.number().int().positive().max(60),
  })
  .strict();
export type InfluencerVideoRequest = z.input<typeof influencerVideoRequestSchema>;
