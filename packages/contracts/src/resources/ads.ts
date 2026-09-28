/**
 * Anuncios pagos (Meta) — sprint 9 (agente R), `PU-S9-012`/`013`, `D-21`.
 *
 *   GET    /ads/connection                     estado de la conexión de anuncios
 *   GET    /ads/connection/authorize           → URL de Facebook Login (permisos de ads)
 *   POST   /ads/connection/callback            code + state (lo llama la web)
 *   GET    /ads/connection/options             cuentas publicitarias y Páginas para elegir
 *   PUT    /ads/connection                     elegir cuenta + Página (+ IG)
 *   DELETE /ads/connection                     desconectar (borra el token)
 *   POST   /ads/connection/demo                modo demo (adaptador fake, sin gasto)
 *   GET    /ads/campaigns                      lista con gasto vs tope
 *   POST   /ads/campaigns                      crear (siempre PAUSED en Meta)
 *   GET    /ads/campaigns/{id}                 detalle con métricas y A/B
 *   POST   /ads/campaigns/{id}/activation-preview   máximo posible + token (5 min)
 *   POST   /ads/campaigns/{id}/activate        exige el token; sin él → 409
 *   POST   /ads/campaigns/{id}/pause
 *   PATCH  /ads/campaigns/{id}/budget          subir exige token; bajar no
 *   POST   /ads/sync                           sincronizar ya (insights + guardia)
 *   GET    /ads/dashboard                      orgánico + pago por período
 *
 * ## Plata
 *
 * Todos los importes son **enteros en unidades mínimas** (`…Minor`) de la
 * moneda de la cuenta (`currency`): centavos en USD, yenes en JPY. La web
 * formatea. Fechas en ms epoch, como el resto del contrato de la marca.
 *
 * ## Por qué `409` con `details.reason`
 *
 * El contrato de errores es cerrado (`errorCodeSchema`). Los rechazos de
 * confirmación viajan como `409 conflict` con `details.reason` en
 * {@link ADS_CONFIRMATION_REJECTIONS}; los de Meta, con el código neutro del
 * puerto y `details.reason` en {@link ADS_PLATFORM_REASONS}.
 */
import { z } from "zod";

import { msEpochSchema } from "../primitives/ids.js";

export const AD_OBJECTIVE_VALUES = [
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
] as const;
export const adObjectiveSchema = z.enum(AD_OBJECTIVE_VALUES);
export type AdObjectiveId = z.infer<typeof adObjectiveSchema>;

export const ADS_CONFIRMATION_REJECTIONS = [
  "preview_required",
  "preview_expired",
  "preview_used",
  "preview_mismatch",
] as const;

export const ADS_PLATFORM_REASONS = [
  "unauthorized",
  "permission_missing",
  "rate_limited",
  "invalid_parameter",
  "budget_too_low",
  "account_disabled",
  "media_rejected",
  "not_found",
  "provider_unavailable",
  "unexpected_response",
] as const;

const minor = z.number().int().nonnegative();
const positiveMinor = z.number().int().positive().max(10_000_000_000);

/* ------------------------------------------------------------------------ *
 * Conexión
 * ------------------------------------------------------------------------ */

export const adConnectionStatusSchema = z.enum([
  "none",
  "pending",
  "active",
  "expired",
  "revoked",
]);

export const adConnectionSchema = z
  .object({
    status: adConnectionStatusSchema,
    /** `true`: adaptador en memoria, ningún gasto es posible. */
    demo: z.boolean(),
    adAccount: z
      .object({
        id: z.string(),
        name: z.string(),
        currency: z.string(),
        timezoneName: z.string().nullable(),
      })
      .strict()
      .nullable(),
    page: z.object({ id: z.string(), name: z.string() }).strict().nullable(),
    instagram: z
      .object({ id: z.string(), username: z.string().nullable() })
      .strict()
      .nullable(),
    tokenExpiresAt: msEpochSchema.nullable(),
    /** La URL que hay que cargar en la app de Meta (Valid OAuth Redirect URIs). */
    redirectUri: z.string(),
    /** Si están las credenciales de la app de Meta (Settings → Integrations → Facebook). */
    appConfigured: z.boolean(),
  })
  .strict();
export type AdConnection = z.infer<typeof adConnectionSchema>;

export const adConnectionOptionsSchema = z
  .object({
    adAccounts: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          currency: z.string(),
          timezoneName: z.string().nullable(),
          /** `1` = activa (referencia de Ad Account). */
          accountStatus: z.number().int(),
        })
        .strict(),
    ),
    pages: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          instagramUserId: z.string().nullable(),
          instagramUsername: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type AdConnectionOptions = z.infer<typeof adConnectionOptionsSchema>;

export const selectAdAccountRequestSchema = z
  .object({
    adAccountId: z.string().regex(/^act_\d+$/u),
    pageId: z.string().min(1).max(64),
  })
  .strict();
export type SelectAdAccountRequest = z.infer<typeof selectAdAccountRequestSchema>;

export const adsAuthorizeResponseSchema = z
  .object({ url: z.string().url(), redirectUri: z.string(), expiresAt: msEpochSchema })
  .strict();

export const adsCallbackRequestSchema = z
  .object({
    state: z.string().min(1).max(2048),
    code: z.string().max(4096).optional(),
    error: z.string().max(256).optional(),
    /** Lo manda la web tal cual (`callbackBodyFrom`); la API no lo repite. */
    errorDescription: z.string().max(1024).optional(),
  })
  .strict();

/* ------------------------------------------------------------------------ *
 * Campañas
 * ------------------------------------------------------------------------ */

export const adTargetingSchema = z
  .object({
    /** ISO 3166-1 alpha-2. */
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/u))
      .min(1)
      .max(25),
    ageMin: z.number().int().min(18).max(65).optional(),
    ageMax: z.number().int().min(18).max(65).optional(),
    /** Ids de intereses de Meta (opcional; sin buscador en la app todavía). */
    interestIds: z
      .array(z.string().regex(/^\d{1,20}$/u))
      .max(10)
      .optional(),
  })
  .strict();
export type AdTargetingInput = z.infer<typeof adTargetingSchema>;

export const AB_METRICS = ["ctr", "cvr"] as const;

export const createAdCampaignRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    objective: adObjectiveSchema,
    /** Piezas de la Library (`contents` en `CREATED`). Con A/B, una variante por pieza. */
    contentIds: z.array(z.string().uuid()).min(1).max(5),
    message: z.string().max(2200),
    title: z.string().max(255).optional(),
    /** Destino del clic. Obligatorio con OUTCOME_TRAFFIC o con piezas de imagen. */
    destinationUrl: z.string().url().max(2000).optional(),
    targeting: adTargetingSchema,
    dailyCapMinor: positiveMinor,
    totalCapMinor: positiveMinor,
    /** Fin programado (ms). Sin fin: corre hasta el tope total o una pausa. */
    endTime: msEpochSchema.optional(),
    abTest: z
      .object({ metric: z.enum(AB_METRICS) })
      .strict()
      .optional(),
    /** "Reel de prueba". */
    isTest: z.boolean().optional(),
    /** `action_type` que cuenta como resultado (CPA/ROAS). Default por objetivo. */
    resultActionType: z.string().max(100).nullable().optional(),
  })
  .strict();
export type CreateAdCampaignRequest = z.infer<typeof createAdCampaignRequestSchema>;

export const adCampaignStatusSchema = z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]);
export const adPauseReasonSchema = z.enum([
  "created",
  "manual",
  "daily_cap",
  "total_cap",
]);

export const adCampaignSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    objective: z.string(),
    status: adCampaignStatusSchema,
    pausedReason: adPauseReasonSchema.nullable(),
    isTest: z.boolean(),
    currency: z.string(),
    dailyCapMinor: minor,
    totalCapMinor: minor,
    spentTodayMinor: minor,
    spentTotalMinor: minor,
    endTime: msEpochSchema.nullable(),
    hasExperiment: z.boolean(),
    lastSyncedAt: msEpochSchema.nullable(),
    lastSyncError: z.string().nullable(),
    createdAt: msEpochSchema,
  })
  .strict();
export type AdCampaignSummary = z.infer<typeof adCampaignSummarySchema>;

export const adMetricsSchema = z
  .object({
    spendMinor: minor,
    impressions: minor,
    clicks: minor,
    results: minor.nullable(),
    resultValueMinor: minor.nullable(),
    cpmMinor: minor.nullable(),
    ctr: z.number().nonnegative().nullable(),
    cpcMinor: minor.nullable(),
    cpaMinor: minor.nullable(),
    roas: z.number().nonnegative().nullable(),
  })
  .strict();
export type AdMetrics = z.infer<typeof adMetricsSchema>;

export const adDayPointSchema = z
  .object({
    date: z.string(),
    spendMinor: minor,
    impressions: minor,
    clicks: minor,
    results: minor.nullable(),
  })
  .strict();

export const adExperimentViewSchema = z
  .object({
    metric: z.enum(AB_METRICS),
    status: z.enum(["insufficient_data", "no_winner_yet", "winner"]),
    winnerAdSetId: z.string().uuid().nullable(),
    leaderAdSetId: z.string().uuid().nullable(),
    minZ: z.number().nullable(),
    /** Si Meta aceptó el `ad_study` (reparto de audiencia sin solapamiento). */
    platformStudy: z.boolean(),
    minImpressions: z.number().int(),
    minEvents: z.number().int(),
    variants: z.array(
      z
        .object({
          adSetId: z.string().uuid(),
          label: z.string(),
          impressions: minor,
          clicks: minor,
          results: minor,
          spendMinor: minor,
          rate: z.number().nonnegative().nullable(),
          enoughData: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type AdExperimentView = z.infer<typeof adExperimentViewSchema>;

export const adActionViewSchema = z
  .object({
    kind: z.string(),
    actor: z.enum(["owner", "guard"]),
    createdAt: msEpochSchema,
    maxSpendMinor: minor.nullable(),
    dailyCapMinor: minor.nullable(),
    totalCapMinor: minor.nullable(),
    reason: z.string().nullable(),
  })
  .strict();

export const adCampaignDetailSchema = z
  .object({
    campaign: adCampaignSummarySchema,
    targeting: adTargetingSchema,
    destinationUrl: z.string().nullable(),
    resultActionType: z.string().nullable(),
    adSets: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          variantLabel: z.string().nullable(),
          dailyBudgetMinor: minor,
        })
        .strict(),
    ),
    ads: z.array(
      z
        .object({
          id: z.string().uuid(),
          name: z.string(),
          adSetId: z.string().uuid(),
          contentId: z.string().uuid().nullable(),
          mediaKind: z.enum(["video", "image"]),
          thumbnailUrl: z.string().nullable(),
          metrics: adMetricsSchema,
        })
        .strict(),
    ),
    metrics: adMetricsSchema,
    byDay: z.array(adDayPointSchema),
    experiment: adExperimentViewSchema.nullable(),
    actions: z.array(adActionViewSchema),
    guardIntervalMinutes: z.number().int().positive(),
  })
  .strict();
export type AdCampaignDetail = z.infer<typeof adCampaignDetailSchema>;

/* ------------------------------------------------------------------------ *
 * Confirmación (D-21)
 * ------------------------------------------------------------------------ */

export const activationPreviewRequestSchema = z
  .object({
    action: z.enum(["activate", "budget_increase"]),
    /** Con `budget_increase`: los topes nuevos. */
    dailyCapMinor: positiveMinor.optional(),
    totalCapMinor: positiveMinor.optional(),
  })
  .strict();
export type ActivationPreviewRequest = z.infer<typeof activationPreviewRequestSchema>;

export const activationPreviewSchema = z
  .object({
    token: z.string(),
    action: z.enum(["activate", "budget_increase"]),
    currency: z.string(),
    dailyCapMinor: minor,
    totalCapMinor: minor,
    spentTotalMinor: minor,
    /** Lo máximo que puede gastar desde ahora dentro de los topes. */
    maxSpendMinor: minor,
    remainingTotalMinor: minor,
    daysLeft: z.number().int().nonnegative().nullable(),
    bindingCap: z.enum(["total", "daily_until_end"]),
    expiresAt: msEpochSchema,
    guardIntervalMinutes: z.number().int().positive(),
    demo: z.boolean(),
  })
  .strict();
export type ActivationPreview = z.infer<typeof activationPreviewSchema>;

export const activateAdCampaignRequestSchema = z
  .object({ confirmationToken: z.string().min(1).max(200) })
  .strict();

export const updateAdBudgetRequestSchema = z
  .object({
    dailyCapMinor: positiveMinor,
    totalCapMinor: positiveMinor,
    /** Obligatorio si alguno sube y la campaña está activa. */
    confirmationToken: z.string().min(1).max(200).optional(),
  })
  .strict();
export type UpdateAdBudgetRequest = z.infer<typeof updateAdBudgetRequestSchema>;

export const adsSyncResultSchema = z
  .object({
    synced: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    pauseFailed: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    stoppedEarly: z.string().nullable(),
  })
  .strict();
export type AdsSyncResult = z.infer<typeof adsSyncResultSchema>;

/* ------------------------------------------------------------------------ *
 * Dashboard de marketing
 * ------------------------------------------------------------------------ */

export const ADS_DASHBOARD_DAYS = [7, 30, 90] as const;

export const adsDashboardQuerySchema = z
  .object({
    days: z
      .enum(["7", "30", "90"])
      .default("30")
      .transform((v) => Number(v) as 7 | 30 | 90),
  })
  .strict();

export const adsDashboardSchema = z
  .object({
    range: z
      .object({ from: z.string(), to: z.string(), days: z.number().int() })
      .strict(),
    connection: adConnectionStatusSchema,
    demo: z.boolean(),
    currency: z.string().nullable(),
    paid: z
      .object({
        metrics: adMetricsSchema,
        byDay: z.array(adDayPointSchema),
        campaigns: z.array(
          z
            .object({
              id: z.string().uuid(),
              name: z.string(),
              status: adCampaignStatusSchema,
              metrics: adMetricsSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    organic: z
      .object({
        posts: minor,
        views: minor,
        likes: minor,
        comments: minor,
        shares: minor,
        engagementRate: z.number().nonnegative().nullable(),
      })
      .strict(),
    experiments: z.array(
      z
        .object({
          campaignId: z.string().uuid(),
          campaignName: z.string(),
          status: z.enum(["insufficient_data", "no_winner_yet", "winner"]),
          metric: z.enum(AB_METRICS),
          winnerLabel: z.string().nullable(),
          leaderLabel: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type AdsDashboard = z.infer<typeof adsDashboardSchema>;
