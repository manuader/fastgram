/**
 * Sobre de error de la API v1.
 *
 * Forma literal (PRD:2257 §9.3): `{"error": {"code": "...", "message": "...", "details": {...}}}`
 * El ejemplo canónico que fija `FR-180` (PRD:1863) no lleva `details`:
 *   {"error":{"code":"unauthorized","message":"Invalid or revoked API key"}}
 * Por eso `details` es opcional y nunca se rellena con `{}` por defecto.
 *
 * Los códigos salen TEXTUALMENTE del PRD (§19 y §6). No se inventa ninguno:
 * un código que el PRD no nombra no puede salir por la API v1.
 */
import { z } from "zod";

/**
 * Códigos de error estables. Cada entrada apunta a la línea del PRD que la fija.
 * Los dos en MAYÚSCULAS están así en el PRD (FR-056, PRD:1319) — no se normalizan:
 * el contrato copia, no mejora.
 */
export const errorCodeSchema = z.enum([
  // Transversales · PRD §9.2, §9.3, §9.6, §9.8
  "bad_request", // PRD:1129, PRD:1459
  "unauthorized", // PRD:1863 FR-180 · ERR-U06
  "forbidden", // PRD:1390 FR-060
  "not_found", // PRD:2251 §9.2 · ERR-E11
  "conflict", // PRD:2288 idempotencia · PRD:2339 §9.8
  "gone", // PRD:2339 §9.8 (reserva expirada)
  "payment_required", // PRD:1519 FR-080 · PRD:2350 §9.11
  "rate_limited", // ERR-R01 PRD:3211
  "service_unavailable", // ERR-R06 PRD:3216 · §9.6 PRD:2332

  // Cuotas · PRD §19.8
  "blitz_quota_exceeded", // ERR-R02 PRD:3212
  "content_quota_exceeded", // ERR-R03 PRD:3213

  // Ciclo de vida del contenido · PRD §19.6 y FR-051
  "content_still_building", // ERR-P02 PRD:3184
  "content_edit_in_progress", // ERR-P03 PRD:3185
  "stale_revision", // ERR-P04 PRD:3186
  "content_not_editable", // ERR-P05 PRD:3187
  "content_has_linked_posts", // ERR-P06 PRD:3188
  "content_unavailable_for_type", // ERR-P07 PRD:3189
  "company_profile_not_ready", // ERR-P08 PRD:3190
  "unsupported_content_state", // FR-051 PRD:1195
  "media_in_use", // §19.10 PRD:3226

  // Programación y publicación · FR-060 PRD:1390
  "connection_ambiguous",
  "posting_mode_not_supported_for_platform",
  "privacy_level_required",
  "invalid_privacy_level",
  "privacy_level_not_allowed_without_direct_mode",
  "tiktok_creator_info_unavailable",
  "tiktok_post_limit_exceeded", // ERR-R05 PRD:3215
  "youtube_post_limit_exceeded",
  "instagram_post_limit_exceeded",

  // Ángulos · FR-056 PRD:1319 (literales en mayúsculas en el PRD)
  "MAX_ANGLES_EXCEEDED",
  "MAX_ANGLES_PER_INFLUENCER_EXCEEDED",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** `details` es un objeto libre: el PRD sólo fija su forma en casos concretos. */
export const errorDetailsSchema = z.record(z.unknown());
export type ErrorDetails = z.infer<typeof errorDetailsSchema>;

export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: errorDetailsSchema.optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** El sobre completo. Es lo único que sale por el cuerpo de una respuesta de error. */
export const errorEnvelopeSchema = z.object({ error: apiErrorSchema });
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

// ---------------------------------------------------------------------------
// `details` tipados — sólo los que el PRD especifica campo a campo.
// ---------------------------------------------------------------------------

/** ERR-R01 · PRD:3211 — `Retry-After` + `details.retryAfterMs`. */
export const rateLimitedDetailsSchema = z.object({
  retryAfterMs: z.number().int().nonnegative(),
});
export type RateLimitedDetails = z.infer<typeof rateLimitedDetailsSchema>;

/** ERR-R02 · PRD:3212 — cap diario de swipes, con `resetAt` (00:00 UTC, PRD:1124). */
export const blitzQuotaExceededDetailsSchema = z.object({
  resetAt: z.number().int().nonnegative(),
});
export type BlitzQuotaExceededDetails = z.infer<typeof blitzQuotaExceededDetailsSchema>;

/**
 * ERR-R03 · PRD:3213 — `count`, `limit`, `resetAt`.
 * ERR-R04 (PRD:3214) es el mismo código sin `resetAt` (trial agotado), de ahí
 * que `resetAt` sea opcional.
 */
export const contentQuotaExceededDetailsSchema = z.object({
  count: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  resetAt: z.number().int().nonnegative().optional(),
});
export type ContentQuotaExceededDetails = z.infer<
  typeof contentQuotaExceededDetailsSchema
>;

/** FR-080 · PRD:1519 — créditos insuficientes incluye `balance` y `required`. */
export const insufficientCreditsDetailsSchema = z.object({
  balance: z.number().int().nonnegative(),
  required: z.number().int().nonnegative(),
});
export type InsufficientCreditsDetails = z.infer<typeof insufficientCreditsDetailsSchema>;

/**
 * ERR-F01 · PRD:3200 — motivos de fallo por id en los lotes de cancel/delete.
 * `not_cancellable_status:<status>` lleva el estado pegado, por eso no es un
 * enum plano sino una unión con un patrón.
 */
export const batchFailureReasonSchema = z.union([
  z.enum([
    "not_found",
    "invalid_id",
    "past_cutoff",
    "cancellation_pending",
    "provider_operation_in_progress",
    "past_submit_cutoff",
    "task_lookup_truncated",
    "task_running",
  ]),
  z.string().regex(/^not_cancellable_status:.+$/),
]);
export type BatchFailureReason = z.infer<typeof batchFailureReasonSchema>;

/** ERR-F01 — `details.failures` con motivo por id. */
export const batchFailuresDetailsSchema = z.object({
  failures: z.array(z.object({ id: z.string(), reason: batchFailureReasonSchema })),
});
export type BatchFailuresDetails = z.infer<typeof batchFailuresDetailsSchema>;
