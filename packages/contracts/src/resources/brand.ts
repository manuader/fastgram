/**
 * Brand Sources y Company Profile — **EXTENSION · EXT-001** (§9.14, PRD:2356-2374).
 *
 * No existe en Fastlane: es una extensión del clon. Los endpoints están
 * enumerados en el PRD como "propuestos" con la misma convención de envelope,
 * cursor e idempotencia que el resto:
 *
 *   POST   /brand/sources/resolve      barato, no crea nada
 *   POST   /brand/sources              202 + `brandSourceId`, exige Idempotency-Key
 *   GET    /brand/sources[/:id]        listado y polling de estado
 *   POST   /brand/sources/:id/reanalyse
 *   PATCH  /brand/sources/:id          sólo `isPrimary`
 *   DELETE /brand/sources/:id
 *   GET|PATCH /brand/profile
 *
 * Fuente: DATA-031 (PRD:2183), DATA-032 (PRD:2200), DATA-004 (PRD:2036),
 * AI-016 (PRD:2560).
 */
import { z } from "zod";
import { brandSourceIdSchema, msEpochSchema } from "../primitives/ids";

// --- Números del PRD ---------------------------------------------------------

/** §9.14 (PRD:2377) / AI-016 (PRD:2572) — máx. 5 fuentes por workspace. */
export const MAX_BRAND_SOURCES_PER_WORKSPACE = 5;
/** §9.14 (PRD:2378) — re-análisis por fuente y día; configurable por plan, default 3. */
export const BRAND_SOURCE_REANALYSES_PER_DAY_DEFAULT = 3;
/** §9.14 (PRD:2380) / AI-016 (PRD:2572) — ítems analizados por fuente. */
export const BRAND_SOURCE_ITEMS_PER_ANALYSIS_DEFAULT = 24;
/** DATA-031 (PRD:2193) — una fuente pasa a `stale` a los 90 días. */
export const BRAND_SOURCE_STALE_AFTER_DAYS = 90;
/** §9.14 (PRD:2385) — seguimiento de link-in-bio: 1 nivel, 5 destinos. */
export const BRAND_SOURCE_LINK_FOLLOW_DEPTH = 1;
export const BRAND_SOURCE_LINK_FOLLOW_MAX_TARGETS = 5;
/** AI-001 (PRD:2545) — descripción libre de la marca ≤ 4 000 caracteres por respuesta. */
export const BRAND_FREE_TEXT_ANSWER_MAX = 4000;

// --- Enums · DATA-031 --------------------------------------------------------

export const brandSourceTypeSchema = z.enum([
  "website",
  "instagram",
  "tiktok",
  "x",
  "youtube",
  "linkedin",
  "other_url",
  "manual",
]);
export type BrandSourceType = z.infer<typeof brandSourceTypeSchema>;

/** FR-011.4 — orden de adquisición B → C → A → D (PRD:2189). */
export const acquisitionTierSchema = z.enum([
  "A_oauth",
  "B_public_api",
  "C_page_fetch",
  "D_assisted",
]);
export type AcquisitionTier = z.infer<typeof acquisitionTierSchema>;

export const brandSourceStatusSchema = z.enum([
  "pending",
  "analyzing",
  "ready",
  "partial",
  "failed",
  "stale",
]);
export type BrandSourceStatus = z.infer<typeof brandSourceStatusSchema>;

export const brandSourceFailureReasonSchema = z.enum([
  "not_found",
  "private",
  "insufficient_content",
  "rate_limited",
  "provider_unavailable",
  "unsupported_platform",
  "already_registered",
]);
export type BrandSourceFailureReason = z.infer<typeof brandSourceFailureReasonSchema>;

// --- Recurso -----------------------------------------------------------------

export const brandSourceSchema = z
  .object({
    _id: brandSourceIdSchema,
    sourceType: brandSourceTypeSchema,
    handle: z.string().nullable(),
    canonicalUrl: z.string().url().nullable(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    isPrimary: z.boolean(),
    acquisitionTier: acquisitionTierSchema,
    status: brandSourceStatusSchema,
    failureReason: brandSourceFailureReasonSchema.nullable().optional(),
    lastAnalysedAt: msEpochSchema.nullable(),
    analysisCount: z.number().int().nonnegative(),
    createdAt: msEpochSchema,
    updatedAt: msEpochSchema,
  })
  .strict();
export type BrandSource = z.infer<typeof brandSourceSchema>;

/**
 * `POST /brand/sources/resolve` — "Dado un texto libre, devuelve
 * `{sourceType, handle, canonicalUrl, displayName, avatarUrl, available}` sin
 * crear nada" (PRD:2366). Forma literal.
 */
export const resolveBrandSourceRequestSchema = z.object({ input: z.string().min(1) }).strict();
export type ResolveBrandSourceRequest = z.infer<typeof resolveBrandSourceRequestSchema>;

export const resolveBrandSourceResponseSchema = z
  .object({
    sourceType: brandSourceTypeSchema,
    handle: z.string().nullable(),
    canonicalUrl: z.string().url().nullable(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    available: z.boolean(),
  })
  .strict();
export type ResolveBrandSourceResponse = z.infer<typeof resolveBrandSourceResponseSchema>;

/** `POST /brand/sources` — crea y encola el análisis; exige `Idempotency-Key`. */
export const createBrandSourceRequestSchema = z
  .object({
    sourceType: brandSourceTypeSchema,
    handle: z.string().min(1).optional(),
    canonicalUrl: z.string().url().optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.handle !== undefined || b.canonicalUrl !== undefined, {
    message: "handle or canonicalUrl is required",
  });
export type CreateBrandSourceRequest = z.infer<typeof createBrandSourceRequestSchema>;

/** `PATCH /brand/sources/:id` — "Sólo `isPrimary`" (PRD:2370). */
export const updateBrandSourceRequestSchema = z.object({ isPrimary: z.boolean() }).strict();
export type UpdateBrandSourceRequest = z.infer<typeof updateBrandSourceRequestSchema>;

// --- Company Profile · DATA-004 ---------------------------------------------

/** DATA-004 (PRD:2048) — `fieldMeta` por campo del perfil. */
export const fieldConfidenceSchema = z.enum(["high", "medium", "low"]);
export type FieldConfidence = z.infer<typeof fieldConfidenceSchema>;

export const fieldMetaSchema = z
  .object({
    confidence: fieldConfidenceSchema,
    sourceId: brandSourceIdSchema,
    excerptRef: z.string(),
    editedByUser: z.boolean(),
    conflictsWith: z.array(brandSourceIdSchema).optional(),
  })
  .strict();
export type FieldMeta = z.infer<typeof fieldMetaSchema>;

/** DATA-004 (PRD:2047) — `partial` es EXTENSION. */
export const companyProfileStatusSchema = z.enum(["pending", "ready", "failed", "partial"]);
export type CompanyProfileStatus = z.infer<typeof companyProfileStatusSchema>;

/**
 * Los cinco campos estructurados que produce AI-001 (PRD:2547), más los del
 * cuestionario de onboarding (DATA-004, PRD:2045). El PRD no fija longitudes
 * máximas para los campos del perfil: no se inventan.
 */
export const companyProfileSchema = z
  .object({
    coreIdentity: z.string(),
    productOffering: z.string(),
    uniqueBenefits: z.string(),
    problemSolution: z.string(),
    marketAndCompetition: z.string(),
    toneOfVoice: z.string().optional(),
    targetAudience: z.string().optional(),
    businessModel: z.string().optional(),
    businessCategories: z.array(z.string()).optional(),
    monthlyRevenueBand: z.string().optional(),
    teamSize: z.string().optional(),
    ownerRole: z.string().optional(),
    expectations: z.array(z.string()).optional(),
    brandRevision: z.number().int().nonnegative(),
    status: companyProfileStatusSchema,
    fieldMeta: z.record(fieldMetaSchema),
  })
  .strict();
export type CompanyProfile = z.infer<typeof companyProfileSchema>;

/**
 * `PATCH /brand/profile` — "una edición manual marca `editedByUser: true`"
 * (PRD:2373). El cliente envía sólo los campos de texto; `fieldMeta`,
 * `brandRevision` y `status` los escribe el servidor.
 */
export const updateCompanyProfileRequestSchema = companyProfileSchema
  .omit({ brandRevision: true, status: true, fieldMeta: true })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "empty body is not allowed" });
export type UpdateCompanyProfileRequest = z.infer<typeof updateCompanyProfileRequestSchema>;
