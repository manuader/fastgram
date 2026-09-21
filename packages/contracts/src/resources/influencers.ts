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
export const influencerSchema = z
  .object({
    _id: influencerIdSchema,
    name: z.string().min(1),
    gender: z.string().min(1),
    age: z.number().int().min(INFLUENCER_AGE_MIN).max(INFLUENCER_AGE_MAX),
    ethnicity: z.string().min(1),
    baseImageUrl: z.string().url(),
    status: influencerStatusSchema,
    progress: z.number().int().min(INFLUENCER_PROGRESS_MIN).max(INFLUENCER_PROGRESS_MAX),
    isActive: z.boolean(),
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
    name: z.string().min(1),
    gender: z.string().min(1),
    age: z
      .number()
      .int()
      .min(INFLUENCER_AGE_MIN)
      .max(INFLUENCER_AGE_MAX)
      .default(INFLUENCER_AGE_DEFAULT),
    ethnicity: z.string().min(1),
    additionalDetails: z.string().optional(),
    baseImageUploadId: uploadIdSchema.optional(),
  })
  .strict();
export type CreateInfluencerRequest = z.infer<typeof createInfluencerRequestSchema>;
