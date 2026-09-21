/**
 * Content angles · `GET|POST /blitz/angles`, `PATCH|DELETE /blitz/angles/:id`,
 * `POST /blitz/angles/generate` (PRD:2264-2266).
 *
 * Fuente: FR-056 (PRD:1306-1322) y DATA-005 (PRD:2050).
 */
import { z } from "zod";
import { angleIdSchema, influencerIdSchema, msEpochSchema } from "../primitives/ids";

// --- Números del PRD, cada uno con su test -----------------------------------

/** FR-056 tabla de campos (PRD:1312). */
export const ANGLE_TITLE_MAX = 200;
/** FR-056 tabla de campos (PRD:1313). */
export const ANGLE_DESCRIPTION_MAX = 2000;
/** FR-056 tabla de campos (PRD:1314). */
export const ANGLE_TARGET_AUDIENCE_MAX = 500;
/** FR-056 (PRD:1318) — cap por workspace; superarlo → `MAX_ANGLES_EXCEEDED`. */
export const MAX_ANGLES_PER_WORKSPACE = 100;
/** FR-056 (PRD:1318) — cap por influencer; superarlo → `MAX_ANGLES_PER_INFLUENCER_EXCEEDED`. */
export const MAX_ANGLES_PER_INFLUENCER = 10;
/** FR-056 (PRD:1320) / AI-005 (PRD:2660) — 5 sugerencias **exitosas** por minuto. */
export const ANGLE_GENERATION_RATE_LIMIT_PER_MIN = 5;

// --- Recurso -----------------------------------------------------------------

/**
 * `influencerIds` — deben ser únicos y referir a influencers activos y
 * entrenados del workspace (FR-056, PRD:1318). La unicidad se valida acá; la
 * existencia y el estado son del servidor.
 */
const influencerIdsSchema = z
  .array(influencerIdSchema)
  .refine((ids) => new Set(ids).size === ids.length, { message: "influencerIds must be unique" });

export const contentAngleSchema = z
  .object({
    _id: angleIdSchema,
    title: z.string().min(1).max(ANGLE_TITLE_MAX),
    description: z.string().min(1).max(ANGLE_DESCRIPTION_MAX),
    targetAudience: z.string().min(1).max(ANGLE_TARGET_AUDIENCE_MAX),
    isActive: z.boolean(),
    influencerIds: influencerIdsSchema,
    createdAt: msEpochSchema,
    updatedAt: msEpochSchema,
  })
  .strict();
export type ContentAngle = z.infer<typeof contentAngleSchema>;

/**
 * `POST /blitz/angles`.
 *
 * `expectedBrandRevision` es el guardarraíl de consistencia de AI-005
 * (PRD:2663): si la marca cambió entre generar y guardar, se rechaza. Es
 * obligatorio al persistir un ángulo generado; el PRD no lo marca opcional para
 * la creación manual, así que se contrata como opcional y se anota como abierto.
 */
export const createContentAngleRequestSchema = z
  .object({
    title: z.string().min(1).max(ANGLE_TITLE_MAX),
    description: z.string().min(1).max(ANGLE_DESCRIPTION_MAX),
    targetAudience: z.string().min(1).max(ANGLE_TARGET_AUDIENCE_MAX),
    influencerIds: influencerIdsSchema.optional(),
    isActive: z.boolean().optional(),
    expectedBrandRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CreateContentAngleRequest = z.infer<typeof createContentAngleRequestSchema>;

/**
 * `PATCH /blitz/angles/:id`. Borrar es un soft-delete (desactivación) reversible
 * por PATCH (FR-056, PRD:1318), de ahí que `isActive` sea editable.
 */
export const updateContentAngleRequestSchema = createContentAngleRequestSchema
  .omit({ expectedBrandRevision: true })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "empty body is not allowed" });
export type UpdateContentAngleRequest = z.infer<typeof updateContentAngleRequestSchema>;

/**
 * `POST /blitz/angles/generate` — body vacío `{}` (AI-005, PRD:2657).
 * No idempotente: cada llamada puede devolver algo distinto (PRD:2662).
 */
export const generateContentAngleRequestSchema = z.object({}).strict();
export type GenerateContentAngleRequest = z.infer<typeof generateContentAngleRequestSchema>;

/**
 * Respuesta del generador: `{title, description, targetAudience, brandRevision}`
 * **sin persistir** (AI-005, PRD:2659). `brandRevision` se reenvía como
 * `expectedBrandRevision` al crear.
 */
export const generatedContentAngleSchema = z
  .object({
    title: z.string().max(ANGLE_TITLE_MAX),
    description: z.string().max(ANGLE_DESCRIPTION_MAX),
    targetAudience: z.string().max(ANGLE_TARGET_AUDIENCE_MAX),
    brandRevision: z.number().int().nonnegative(),
  })
  .strict();
export type GeneratedContentAngle = z.infer<typeof generatedContentAngleSchema>;
