/**
 * Engagement (Reddit) — `FR-140`, `MOD-014` (F-190…F-201), `P4-ENGAGE-001…012`.
 *
 *   GET    /engagement/overview                   configuración, app, cuenta, descubrimiento y ban meter
 *   PUT    /engagement/settings                   subreddits, palabras clave y reglas de respuesta
 *   PUT    /engagement/reddit-app                 credenciales de la app de Reddit (sin devolver el secret)
 *   DELETE /engagement/reddit-app
 *   GET    /engagement/reddit/authorize           → URL de Reddit con `state` firmado
 *   POST   /engagement/reddit/callback            lo llama la web con `code` + `state`
 *   DELETE /engagement/reddit/account             desconectar (tokens borrados)
 *   POST   /engagement/discover                   descubrir ahora (encola)
 *   GET    /engagement/leads                      lista con vistas y filtros (F-193)
 *   POST   /engagement/leads                      agregar un post a mano (modo sin API)
 *   GET    /engagement/leads/{leadId}             detalle (F-194)
 *   DELETE /engagement/leads/{leadId}             descartar (F-201)
 *   POST   /engagement/leads/{leadId}/seen
 *   POST   /engagement/leads/{leadId}/reply/generate   generar o regenerar (encola, F-195)
 *   PUT    /engagement/leads/{leadId}/reply            guardar el borrador editado
 *   POST   /engagement/leads/{leadId}/send             publicar por la API — sólo con `confirm: true`
 *   POST   /engagement/leads/{leadId}/mark-sent        «Copy & open thread»: lo publiqué yo a mano
 *   POST   /engagement/leads/{leadId}/sync             Sync with Reddit (F-199, encola)
 *   POST   /engagement/ban-meter/refresh               Refresh ban meter (recalcula ya, en código)
 *
 * Ninguna ruta está en la §9.3 del PRD: el PRD describe la UI de Fastlane y
 * no su API.
 *
 * ## Los enums están duplicados de `core`, a propósito
 *
 * Este paquete es standalone (no importa `core`); los tests de la API
 * comparan las listas.
 */
import { z } from "zod";

export const LEAD_VIEWS = ["all", "top", "engaged"] as const;
export const leadViewSchema = z.enum(LEAD_VIEWS);
export type LeadView = z.infer<typeof leadViewSchema>;

export const leadTierSchema = z.enum(["top", "general", "hidden", "vetoed"]);
export const leadScoreStatusSchema = z.enum([
  "pending",
  "scored",
  "failed",
  "no_judgment",
]);
export const leadReplyStatusSchema = z.enum(["none", "generating", "ready", "failed"]);
export const threadStateSchema = z.enum(["new", "tracking", "comment_missing", "locked"]);
export const replyToneSchema = z.enum(["value_add", "subtle_mention", "direct_promo"]);
export const replyToneStyleSchema = z.enum(["casual", "professional", "friendly_expert"]);
export const banRiskLevelSchema = z.enum(["safe", "caution", "warning", "danger"]);
export const replyIssueSchema = z.enum([
  "empty",
  "too_long",
  "brand_without_disclosure",
  "contains_link",
]);

/** Motivos estables de rechazo (`error.details.reason`). La web los traduce. */
export const ENGAGEMENT_ERROR_REASONS = [
  "reddit_app_not_configured",
  "reddit_not_connected",
  "reddit_reconnect_required",
  "reddit_rejected",
  "reddit_rate_limited",
  "reddit_unavailable",
  "oauth_state_invalid",
  "oauth_state_wrong_brand",
  "oauth_denied",
  "invalid_subreddits",
  "invalid_keywords",
  "invalid_reddit_url",
  "ban_meter_danger",
  "reply_blocked",
  "confirmation_required",
  "lead_locked",
] as const;
export const engagementErrorReasonSchema = z.enum(ENGAGEMENT_ERROR_REASONS);
export type EngagementErrorReason = z.infer<typeof engagementErrorReasonSchema>;

/* ------------------------------------------------------------------------ *
 * Configuración
 * ------------------------------------------------------------------------ */

export const engagementSettingsSchema = z.object({
  subreddits: z.array(z.string()),
  keywords: z.array(z.string()),
  replyTone: replyToneStyleSchema,
  customRules: z.string(),
  allowLinks: z.boolean(),
  discoveryEnabled: z.boolean(),
});
export type EngagementSettings = z.infer<typeof engagementSettingsSchema>;

export const updateEngagementSettingsRequestSchema = z
  .object({
    subreddits: z.array(z.string().max(200)).max(50),
    keywords: z.array(z.string().max(200)).max(100),
    replyTone: replyToneStyleSchema,
    customRules: z.string().max(2_000),
    allowLinks: z.boolean(),
    discoveryEnabled: z.boolean(),
  })
  .strict();
export type UpdateEngagementSettingsRequest = z.infer<
  typeof updateEngagementSettingsRequestSchema
>;

export const redditAppSchema = z.object({
  configured: z.boolean(),
  clientId: z.string().nullable(),
  hasSecret: z.boolean(),
  developerUsername: z.string().nullable(),
  /** La que hay que cargar en reddit.com/prefs/apps. */
  redirectUri: z.string(),
  scopes: z.array(z.string()),
  consoleUrl: z.string(),
  policyUrl: z.string(),
});
export type RedditApp = z.infer<typeof redditAppSchema>;

export const updateRedditAppRequestSchema = z
  .object({
    clientId: z.string().trim().min(1).max(256),
    /** Ausente = conservar el guardado. */
    clientSecret: z.string().trim().min(1).max(1024).optional(),
    developerUsername: z.string().trim().min(1).max(64),
  })
  .strict();
export type UpdateRedditAppRequest = z.infer<typeof updateRedditAppRequestSchema>;

export const redditAccountSchema = z.object({
  username: z.string(),
  status: z.enum(["active", "expired", "revoked"]),
  statusReason: z.string().nullable(),
  scopes: z.array(z.string()),
  connectedAt: z.string(),
});
export type RedditAccount = z.infer<typeof redditAccountSchema>;

export const banMeterSchema = z.object({
  level: banRiskLevelSchema,
  /** (sutiles + directas) / etiquetadas. `null` sin respuestas etiquetadas. */
  promoRatio: z.number().nullable(),
  counts: z.object({
    valueAdd: z.number().int(),
    subtle: z.number().int(),
    direct: z.number().int(),
    unlabeled: z.number().int(),
  }),
  sampleSize: z.number().int(),
  smallSample: z.boolean(),
  windowDays: z.number().int(),
  /** `danger` bloquea "Send" (lo decide el código, no el modelo). */
  sendBlocked: z.boolean(),
  computedAt: z.string().nullable(),
});
export type BanMeter = z.infer<typeof banMeterSchema>;

export const engagementOverviewSchema = z.object({
  settings: engagementSettingsSchema,
  /** `false` hasta que se guarde la configuración por primera vez. */
  configured: z.boolean(),
  redditApp: redditAppSchema,
  account: redditAccountSchema.nullable(),
  discovery: z.object({
    /** Hay cuenta activa, subreddits y el descubrimiento prendido. */
    available: z.boolean(),
    lastRunAt: z.string().nullable(),
    lastOutcome: z.string().nullable(),
    pausedUntil: z.string().nullable(),
  }),
  banMeter: banMeterSchema,
});
export type EngagementOverview = z.infer<typeof engagementOverviewSchema>;

/* ------------------------------------------------------------------------ *
 * OAuth
 * ------------------------------------------------------------------------ */

export const redditAuthorizeResponseSchema = z.object({ url: z.string() });

export const redditCallbackRequestSchema = z
  .object({
    state: z.string().min(1).max(2048),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().max(256).optional(),
    errorDescription: z.string().max(1024).optional(),
  })
  .strict();
export type RedditCallbackRequest = z.infer<typeof redditCallbackRequestSchema>;

export const redditCallbackResultSchema = z.object({ username: z.string() });

/* ------------------------------------------------------------------------ *
 * Leads
 * ------------------------------------------------------------------------ */

export const leadListQuerySchema = z.object({
  view: leadViewSchema.default("all"),
  unseen: z.enum(["true", "false"]).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

export const leadSchema = z.object({
  id: z.string(),
  source: z.enum(["discovery", "manual"]),
  redditPostId: z.string(),
  subreddit: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  author: z.string().nullable(),
  /** `https://www.reddit.com/...`, o `null` si no se conoce. */
  url: z.string().nullable(),
  redditScore: z.number().int(),
  numComments: z.number().int(),
  postedAt: z.string().nullable(),
  matchedKeywords: z.array(z.string()),
  scoreStatus: leadScoreStatusSchema,
  /** [0, 1], compuesto en código (JV-2). */
  leadScore: z.number().nullable(),
  tier: leadTierSchema.nullable(),
  /** Componentes normalizados del score, para `Why this lead?`. */
  scoreComponents: z
    .object({
      buyingSignal: z.number(),
      fitToAudience: z.number(),
      hasProblem: z.number(),
      replyWelcome: z.number(),
      alreadyAnswered: z.number(),
    })
    .nullable(),
  whyThisLead: z.string().nullable(),
  engagementScore: z.number().nullable(),
  seen: z.boolean(),
  newActivity: z.boolean(),
  replied: z.boolean(),
  repliedAt: z.string().nullable(),
  threadState: threadStateSchema.nullable(),
  ourComments: z.number().int(),
  repliesToUs: z.number().int(),
  lastSyncedAt: z.string().nullable(),
  replyStatus: leadReplyStatusSchema,
  replyDraft: z.string().nullable(),
  createdAt: z.string(),
});
export type Lead = z.infer<typeof leadSchema>;

export const leadListSchema = z.object({
  items: z.array(leadSchema),
  hasMore: z.boolean(),
});
export type LeadList = z.infer<typeof leadListSchema>;

export const sentReplySchema = z.object({
  id: z.string(),
  text: z.string(),
  channel: z.enum(["api", "manual"]),
  url: z.string().nullable(),
  sentAt: z.string(),
  /** Etiqueta JV-5; `null` = todavía sin clasificar. */
  tone: replyToneSchema.nullable(),
});
export type SentReply = z.infer<typeof sentReplySchema>;

export const leadDetailSchema = z.object({
  lead: leadSchema,
  contextComments: z.array(z.string()),
  replies: z.array(sentReplySchema),
  /** Revisión determinística del borrador actual. */
  draftIssues: z.array(replyIssueSchema),
  /** Hay issues que bloquean, o el ban meter está en `danger`, o no hay cuenta. */
  canSend: z.boolean(),
  /** Por qué no, si `canSend` es `false`. */
  sendBlockedReason: engagementErrorReasonSchema.nullable(),
});
export type LeadDetail = z.infer<typeof leadDetailSchema>;

export const createManualLeadRequestSchema = z
  .object({
    url: z.string().trim().min(1).max(2_000),
    title: z.string().trim().min(1).max(300),
    body: z.string().max(10_000).optional(),
  })
  .strict();
export type CreateManualLeadRequest = z.infer<typeof createManualLeadRequestSchema>;

export const generateReplyRequestSchema = z
  .object({ regenerate: z.boolean().default(false) })
  .strict();

export const saveReplyDraftRequestSchema = z
  .object({ text: z.string().max(10_000) })
  .strict();

export const sendReplyRequestSchema = z
  .object({
    text: z.string().min(1).max(10_000),
    /** Tiene que ser `true`: la UI lo manda sólo desde el diálogo de confirmación. */
    confirm: z.literal(true),
  })
  .strict();
export type SendReplyRequest = z.infer<typeof sendReplyRequestSchema>;

export const markSentRequestSchema = z
  .object({
    text: z.string().min(1).max(10_000),
    /** URL del comentario publicado a mano, si el usuario la pega. */
    commentUrl: z.string().max(2_000).optional(),
  })
  .strict();

export const sendReplyResultSchema = z.object({
  reply: sentReplySchema,
  lead: leadSchema,
});
export type SendReplyResult = z.infer<typeof sendReplyResultSchema>;

export const engagementQueuedSchema = z.object({ queued: z.boolean() });
