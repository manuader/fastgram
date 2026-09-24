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
  })
  .strict()
  .refine((b) => b.referenceMediaIds === undefined || b.baseImageUploadId === undefined, {
    path: ["referenceMediaIds"],
    message: "Use reference photos or a base image, not both",
  });
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
