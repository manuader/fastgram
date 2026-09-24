/**
 * Analytics · `POST /analytics/posts` (PRD:2286).
 *
 * Fuente: F-176 (PRD:643), ERR-F02 (PRD:3201), NFR-012 (PRD:2962),
 * NFR-016 (PRD:2966).
 */
import { z } from "zod";
import { msEpochSchema, postIdSchema } from "../primitives/ids.js";
import { batchPostIdsSchema } from "./posts.js";

/** Mismo lote que cancel/delete: dedup y luego cap de 100 (NFR-012, PRD:2962). */
export const postAnalyticsRequestSchema = z
  .object({ postIds: batchPostIdsSchema })
  .strict();
export type PostAnalyticsRequest = z.infer<typeof postAnalyticsRequestSchema>;

/**
 * F-176 (PRD:643) — métricas por post.
 *
 * NFR-016 (PRD:2966): las métricas reflejan la **última sincronización**. Un
 * post recién publicado puede devolver ceros; `postedAt` es lo que distingue un
 * cero real de un pre-sync, y por eso no es opcional por comodidad.
 */
export const postAnalyticsItemSchema = z
  .object({
    _id: postIdSchema,
    views: z.number().int().nonnegative(),
    likes: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative(),
    postUrl: z.string().url().optional(),
    postedAt: msEpochSchema.optional(),
  })
  .strict();
export type PostAnalyticsItem = z.infer<typeof postAnalyticsItemSchema>;

/**
 * ERR-F02 (PRD:3201) — éxito parcial: un id desconocido vuelve como
 * `{"_id":"…","notFound":true}`. Los ids **malformados** son otra cosa: fallan
 * toda la request con `invalidIds`, y eso no es una fila de la respuesta.
 */
export const postAnalyticsNotFoundSchema = z
  .object({ _id: postIdSchema, notFound: z.literal(true) })
  .strict();
export type PostAnalyticsNotFound = z.infer<typeof postAnalyticsNotFoundSchema>;

export const postAnalyticsResultSchema = z.union([
  postAnalyticsItemSchema,
  postAnalyticsNotFoundSchema,
]);
export type PostAnalyticsResult = z.infer<typeof postAnalyticsResultSchema>;

/** ERR-F02 (PRD:3201) — `details.invalidIds` del error que aborta el lote entero. */
export const invalidIdsDetailsSchema = z
  .object({ invalidIds: z.array(z.string()) })
  .strict();
export type InvalidIdsDetails = z.infer<typeof invalidIdsDetailsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// `/analytics` — `P3-ANALYT-001` (FR-120, rango), `P3-ANALYT-002` (F-171, F-172),
// `PU-AUTO-004` (auto-tune del mix). Rutas del plan de uso personal, fuera de
// la §9.3 del PRD:
//
//   GET /analytics/summary?days&brands   totales, desglose y top posts
//   GET /analytics/mix                   pesos, auto-tune y su historial
//   PUT /analytics/mix/autotune          prende o apaga el auto-tune
//   POST /analytics/sync                 pide un sync ya (para la marca activa)
// ─────────────────────────────────────────────────────────────────────────────

/** Los rangos que ofrece la pantalla. El contrato acepta 1–90. */
export const ANALYTICS_RANGE_DAYS = [7, 30, 90] as const;
export const ANALYTICS_RANGE_MAX_DAYS = 90;
export const ANALYTICS_DEFAULT_DAYS = 30;

export const analyticsSummaryQuerySchema = z
  .object({
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(ANALYTICS_RANGE_MAX_DAYS)
      .default(ANALYTICS_DEFAULT_DAYS),
    brands: z.enum(["current", "all"]).default("current"),
  })
  .strict();
export type AnalyticsSummaryQuery = z.infer<typeof analyticsSummaryQuerySchema>;

/** Una métrica sumable, o `null` si ningún post medido la trae. */
const metricCount = z.number().int().nonnegative();

/**
 * Totales. `NFR-016` en cada campo: sólo suman los posts **sincronizados**
 * (`syncedPosts`); los pre-sync cuentan en `pendingSync` y nada más.
 * `metricCoverage` dice cuántos posts medidos trajeron cada métrica — una red
 * que no reporta `shares` no aporta un «0 shares».
 */
export const analyticsTotalsSchema = z
  .object({
    posts: metricCount,
    syncedPosts: metricCount,
    pendingSync: metricCount,
    views: metricCount,
    likes: metricCount,
    comments: metricCount,
    shares: metricCount,
    metricCoverage: z
      .object({
        views: metricCount,
        likes: metricCount,
        comments: metricCount,
        shares: metricCount,
      })
      .strict(),
    /** (likes + comments + shares) / views sobre los posts con views > 0. */
    engagementRate: z.number().nonnegative().nullable(),
  })
  .strict();
export type AnalyticsTotals = z.infer<typeof analyticsTotalsSchema>;

export const analyticsBreakdownRowSchema = analyticsTotalsSchema
  .extend({ key: z.string() })
  .strict();
export type AnalyticsBreakdownRow = z.infer<typeof analyticsBreakdownRowSchema>;

export const analyticsTopPostSchema = z
  .object({
    /** El id del post (uuid). Sin la marca de tipo de `postIdSchema`: es de lectura. */
    _id: z.string().uuid(),
    brandId: z.string().uuid(),
    network: z.string(),
    format: z.string(),
    postedAt: msEpochSchema,
    /** `null` = la red no la dio. */
    views: metricCount.nullable(),
    likes: metricCount.nullable(),
    comments: metricCount.nullable(),
    shares: metricCount.nullable(),
    engagementRate: z.number().nonnegative().nullable(),
    postUrl: z.string().url().optional(),
    caption: z.string().optional(),
  })
  .strict();
export type AnalyticsTopPost = z.infer<typeof analyticsTopPostSchema>;

/** `posts.metricsErrorCode`: por qué un post no trae métricas. Códigos estables. */
export const METRICS_SYNC_ISSUES = [
  "metrics_reconnect_required",
  "metrics_permission_missing",
  "metrics_unavailable",
  "not_found_on_platform",
] as const;
export const metricsSyncIssueSchema = z.enum(METRICS_SYNC_ISSUES);
export type MetricsSyncIssue = z.infer<typeof metricsSyncIssueSchema>;

export const analyticsSummarySchema = z
  .object({
    range: z
      .object({ from: msEpochSchema, to: msEpochSchema, days: z.number().int() })
      .strict(),
    brands: z.array(z.object({ id: z.string().uuid(), name: z.string() }).strict()),
    totals: analyticsTotalsSchema,
    byNetwork: z.array(analyticsBreakdownRowSchema),
    byFormat: z.array(analyticsBreakdownRowSchema),
    topPosts: z.array(analyticsTopPostSchema),
    /** `NFR-016`: «las métricas reflejan la última sincronización». */
    lastSyncedAt: msEpochSchema.nullable(),
    /** Posts con un problema de sync, por motivo (sólo los que tienen alguno). */
    syncIssues: z.array(
      z.object({ code: metricsSyncIssueSchema, count: metricCount }).strict(),
    ),
    /**
     * Redes con posts en el rango que **no tienen lectura de métricas** en
     * FastGram (hoy TikTok: el borrador no deja el id del video). Sus posts
     * quedan pre-sync para siempre, y la pantalla lo dice.
     */
    unsupportedNetworks: z.array(z.string()),
    /** Se leyó el tope de posts de alguna marca: los números son parciales. */
    truncated: z.boolean(),
  })
  .strict();
export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;

// --- Mix -----------------------------------------------------------------------

export const formatWeightsSchema = z
  .object({
    slideshow: z.number().int().min(0).max(100),
    "wall-of-text": z.number().int().min(0).max(100),
    "green-screen": z.number().int().min(0).max(100),
    "video-hook": z.number().int().min(0).max(100),
  })
  .strict();
export type FormatWeights = z.infer<typeof formatWeightsSchema>;

/** Lo que dejó la última corrida del auto-tune. */
export const MIX_TUNING_OUTCOMES = [
  "changed",
  "single_active_format",
  "insufficient_data",
  "no_significant_difference",
] as const;
export const mixTuningOutcomeSchema = z.enum(MIX_TUNING_OUTCOMES);

export const mixAutotuneSchema = z
  .object({
    enabled: z.boolean(),
    lastRunAt: msEpochSchema.nullable(),
    lastOutcome: mixTuningOutcomeSchema.nullable(),
  })
  .strict();
export type MixAutotune = z.infer<typeof mixAutotuneSchema>;

export const mixAdjustmentSchema = z
  .object({
    _id: z.string().uuid(),
    actor: z.enum(["autotune"]),
    from: formatWeightsSchema,
    to: formatWeightsSchema,
    createdAt: msEpochSchema,
    /** Posts medidos por formato con los que se decidió. */
    samples: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type MixAdjustment = z.infer<typeof mixAdjustmentSchema>;

export const analyticsMixSchema = z
  .object({
    weights: formatWeightsSchema,
    autotune: mixAutotuneSchema,
    adjustments: z.array(mixAdjustmentSchema),
  })
  .strict();
export type AnalyticsMix = z.infer<typeof analyticsMixSchema>;

export const mixAutotuneRequestSchema = z.object({ enabled: z.boolean() }).strict();
export type MixAutotuneRequest = z.infer<typeof mixAutotuneRequestSchema>;

export const analyticsSyncResponseSchema = z.object({ queued: z.boolean() }).strict();
export type AnalyticsSyncResponse = z.infer<typeof analyticsSyncResponseSchema>;
