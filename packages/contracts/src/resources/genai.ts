/**
 * AI Studio y el tope mensual de generación — `PU-LATER-005` (FR-090 adaptado
 * al uso personal), `PU-MODEL-003`/`004`/`005`, D-14.
 *
 *   GET  /ai-studio/options              modelos configurados + presupuesto
 *   POST /ai-studio/estimate             costo estimado de un pedido
 *   POST /ai-studio/generations          reservar gasto y encolar (202)
 *   GET  /ai-studio/generations          galería de la marca
 *   GET  /ai-studio/generations/{id}     una generación (404 si es de otra marca)
 *   GET  /models/budget                  gasto del mes / tope
 *   PUT  /models/budget                  cambiar el tope
 *
 * **No está en el PRD tal cual**: FR-090 es AI Studio con créditos del plan;
 * el plan de uso personal (§4) lo cambia por proveedores del usuario
 * (Higgsfield, fal) con un tope mensual en dólares.
 *
 * ## Reglas
 *
 * 1. El costo que se muestra es **estimado**: `source: "provider"` lo calculó
 *    el proveedor para esta cuenta; `"price_list"` es el precio de lista de la
 *    página del modelo (citada en `sourceUrl`) por las unidades del pedido.
 * 2. Pasar el tope responde **402 `payment_required`** con
 *    `details.reason = "budget_exceeded"` (el 402 es el de los créditos de AI
 *    Studio, ERR-R08) y no encola nada.
 * 3. Ninguna respuesta lleva una key ni una URL del proveedor: la media
 *    generada se copia a nuestro storage y se sirve desde ahí.
 *
 * Las listas repiten las de `packages/ports`/`core` porque este paquete es
 * standalone; el test de rutas de `apps/api` las compara.
 */
import { z } from "zod";

import { modelProviderSchema } from "./models.js";

export const genAspectRatioSchema = z.enum(["1:1", "4:5", "3:4", "4:3", "9:16", "16:9"]);
export type GenAspectRatio = z.infer<typeof genAspectRatioSchema>;

export const genKindSchema = z.enum(["image", "video"]);
export type GenKind = z.infer<typeof genKindSchema>;

export const genModelSpecSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: genKindSchema,
  aspectRatios: z.array(genAspectRatioSchema),
  /** La relación sale de la imagen de entrada. */
  aspectFromImage: z.boolean(),
  counts: z.array(z.number().int().positive()),
  durationsSeconds: z.array(z.number().int().positive()),
  promptRequired: z.boolean(),
  imageInput: z.enum(["none", "optional", "required"]),
  maxReferenceImages: z.number().int().nonnegative(),
  /** De dónde salió el id y su esquema. */
  docsUrl: z.string(),
  listPrice: z.object({ summary: z.string(), sourceUrl: z.string() }).nullable(),
});
export type GenModelSpec = z.infer<typeof genModelSpecSchema>;

export const budgetSummarySchema = z.object({
  /** `YYYY-MM`, UTC. */
  month: z.string(),
  budgetUsd: z.number().nonnegative(),
  budgetSource: z.enum(["settings", "env", "default"]),
  chargedUsd: z.number().nonnegative(),
  /** Generaciones en vuelo: reservado, todavía no cobrado. */
  reservedUsd: z.number().nonnegative(),
  remainingUsd: z.number().nonnegative(),
  generations: z.number().int().nonnegative(),
});
export type BudgetSummary = z.infer<typeof budgetSummarySchema>;

/** `PUT /models/budget`. `null` = volver a `FASTGRAM_MONTHLY_BUDGET_USD` o al default. */
export const updateBudgetRequestSchema = z
  .object({ budgetUsd: z.number().nonnegative().max(100_000).nullable() })
  .strict();
export type UpdateBudgetRequest = z.infer<typeof updateBudgetRequestSchema>;

export const aiStudioTaskOptionsSchema = z.object({
  kind: genKindSchema,
  /** La tarea está completa en Settings → Models. */
  configured: z.boolean(),
  provider: modelProviderSchema.nullable(),
  /** El modelo elegido en Settings; el default del selector. */
  defaultModel: z.string().nullable(),
  /** El catálogo verificado del proveedor configurado, de esta clase. */
  models: z.array(genModelSpecSchema),
});
export type AiStudioTaskOptions = z.infer<typeof aiStudioTaskOptionsSchema>;

export const aiStudioOptionsSchema = z.object({
  image: aiStudioTaskOptionsSchema,
  video: aiStudioTaskOptionsSchema,
  budget: budgetSummarySchema,
});
export type AiStudioOptions = z.infer<typeof aiStudioOptionsSchema>;

/** Cuerpo de estimar y de generar. Sin `model` = el de Settings. */
export const generationRequestSchema = z
  .object({
    kind: genKindSchema,
    model: z.string().trim().min(1).max(256).optional(),
    prompt: z.string().max(2000),
    aspectRatio: genAspectRatioSchema,
    count: z.number().int().min(1).max(8).default(1),
    durationSeconds: z.number().int().positive().max(60).optional(),
    imageUrl: z.string().max(2048).optional(),
  })
  .strict();
export type GenerationRequest = z.input<typeof generationRequestSchema>;

export const costEstimateSchema = z.object({
  usd: z.number().nonnegative(),
  source: z.enum(["provider", "price_list"]),
  basis: z.string(),
  sourceUrl: z.string().nullable(),
});
export type CostEstimate = z.infer<typeof costEstimateSchema>;

export const generationEstimateSchema = z.object({
  provider: modelProviderSchema,
  model: z.string(),
  estimate: costEstimateSchema,
  budget: budgetSummarySchema,
  /** Entra en lo que queda del mes. */
  fits: z.boolean(),
});
export type GenerationEstimate = z.infer<typeof generationEstimateSchema>;

export const generationStatusSchema = z.enum([
  "queued",
  "generating",
  "ready",
  "failed",
  "nsfw",
  "canceled",
]);
export type GenerationStatus = z.infer<typeof generationStatusSchema>;

export const generationErrorCodeSchema = z.enum([
  "nsfw_rejected",
  "generation_failed",
  "provider_unavailable",
  "quota_exceeded",
  "budget_exceeded",
  "rate_limited",
  "unauthorized",
  "bad_request",
  "not_found",
  "timeout",
  "provider_contract_violation",
  "not_configured",
  "download_failed",
]);
export type GenerationErrorCode = z.infer<typeof generationErrorCodeSchema>;

export const generationMediaSchema = z.object({
  mediaId: z.string().uuid(),
  mediaType: genKindSchema,
  /** La URL de **nuestro** storage (la misma que usa el Media Bank). */
  url: z.string(),
});
export type GenerationMedia = z.infer<typeof generationMediaSchema>;

export const generationSchema = z.object({
  id: z.string().uuid(),
  kind: genKindSchema,
  provider: z.string(),
  model: z.string(),
  prompt: z.string(),
  aspectRatio: genAspectRatioSchema,
  count: z.number().int().positive(),
  durationSeconds: z.number().nullable(),
  imageUrl: z.string().nullable(),
  status: generationStatusSchema,
  estimate: costEstimateSchema,
  /** En el Media Bank, ya copiadas. Vacío hasta `ready`. */
  media: z.array(generationMediaSchema),
  error: z.object({ code: generationErrorCodeSchema, message: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Generation = z.infer<typeof generationSchema>;

export const generationListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
  .strict();
export type GenerationListQuery = z.infer<typeof generationListQuerySchema>;

export const generationListSchema = z.array(generationSchema);
