/**
 * Automations (campañas multi-semana) — `FR-150`, `MOD-015` (`F-210…F-220`),
 * `DATA-021`, `DATA-022`, `AI-012`.
 *
 * | Operación (tool MCP del PRD)      | Ruta                                              |
 * |-----------------------------------|---------------------------------------------------|
 * | `list_automations`                | `GET /automations`                                |
 * | `create_automation`               | `POST /automations`                               |
 * | `get_automation`                  | `GET /automations/{automationId}`                 |
 * | `update_automation`               | `PATCH /automations/{automationId}`               |
 * | `delete_automation`               | `DELETE /automations/{automationId}`              |
 * | `generate_automation`             | `POST /automations/{automationId}/generate`       |
 * | `list_automation_slots`           | `GET /automations/{automationId}/slots`           |
 * | `update_automation_slot`          | `PATCH /automations/{automationId}/slots/{slotId}`|
 * | `reroll_automation_slot`          | `POST …/slots/{slotId}/reroll`                    |
 * | «Remove suggestion»               | `DELETE …/slots/{slotId}`                         |
 * | editar en el editor (`Edit post`) | `POST …/slots/{slotId}/content`                   |
 * | `launchValidation`                | `GET /automations/{automationId}/launch-validation` |
 * | `launch_automation`               | `POST /automations/{automationId}/launch`         |
 * | `cancel_automation`               | `POST /automations/{automationId}/cancel`         |
 *
 * El PRD pone esto en MCP (`AI-015`); acá es REST v1 porque la web lo usa. Los
 * nombres de campo son los de `DATA-021`/`DATA-022`; lo que no está en el PRD
 * está marcado.
 */
import { z } from "zod";

import { blitzContentTypeSchema, postStatusSchema } from "../primitives/enums.js";
import { msEpochSchema } from "../primitives/ids.js";
import { strategyNetworkSchema, timeOfDaySchema, timeZoneSchema } from "./strategy.js";

export const AUTOMATION_NAME_MAX = 100;
export const AUTOMATION_PER_ACCOUNT_PER_DAY_MIN = 1;
export const AUTOMATION_PER_ACCOUNT_PER_DAY_MAX = 3;
export const AUTOMATION_DURATION_WEEKS_MIN = 1;
export const AUTOMATION_DURATION_WEEKS_MAX = 4;
/** Número nuestro (el PRD no acota los temas). */
export const AUTOMATION_TOPICS_MAX = 10;
export const AUTOMATION_TOPIC_MAX_CHARS = 200;
export const AUTOMATION_POSTING_TIMES_MAX = 3;
/** Una cuenta por red: 7 redes. */
export const AUTOMATION_ACCOUNTS_MAX = 7;
/** Tope de la lista (una marca tiene pocas campañas). */
export const AUTOMATION_LIST_MAX = 100;

export const AUTOMATION_STATUSES = [
  "DRAFT",
  "GENERATING",
  "REVIEW",
  "BUILDING",
  "ACTIVE",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;
export const automationStatusSchema = z.enum(AUTOMATION_STATUSES);
export type AutomationStatus = z.infer<typeof automationStatusSchema>;

export const AUTOMATION_SLOT_STATUSES = [
  "PENDING_GEN",
  "GENERATING",
  "READY",
  "REROLLING",
  "FAILED_GEN",
  "QUEUED_BUILD",
  "BUILDING",
  "SCHEDULED",
  "FAILED",
  "CANCELLED",
] as const;
export const automationSlotStatusSchema = z.enum(AUTOMATION_SLOT_STATUSES);
export type AutomationSlotStatus = z.infer<typeof automationSlotStatusSchema>;

export const automationSlotFailureReasonSchema = z.enum([
  "no_unique_content",
  "no_demo_video",
]);

/** `inbox` \| `direct` (TikTok). */
export const automationPostingModeSchema = z.enum(["inbox", "direct"]);
/** `public` \| `private` \| `unlisted` (YouTube). */
export const youtubePrivacyStatusSchema = z.enum(["public", "private", "unlisted"]);

/**
 * Un destino. `oauth` = una conexión de la marca. `planned` NO ESTÁ EN EL PRD
 * (`warmed` no existe en uso personal): una red sin conexión todavía; el launch
 * reserva un slot planificado y se publica cuando la marca la conecta.
 */
export const automationAccountSchema = z.discriminatedUnion("accountType", [
  z
    .object({
      platform: strategyNetworkSchema,
      accountType: z.literal("oauth"),
      connectionId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      platform: strategyNetworkSchema,
      accountType: z.literal("planned"),
    })
    .strict(),
]);
export type AutomationAccount = z.infer<typeof automationAccountSchema>;

const weight = z.number().int().min(0).max(100);
const percentage = z.number().min(0).max(100);

/** `prefsSnapshot` — `F-212`. `topics` NO ESTÁ EN EL PRD (ángulos/temas libres). */
export const automationPrefsSchema = z
  .object({
    slideshowWeight: weight,
    wallOfTextWeight: weight,
    greenScreenWeight: weight,
    videoHookWeight: weight,
    remixPercentage: percentage,
    ownMediaPercentage: percentage,
    mentionBusinessPercentage: percentage,
    influencerChance: percentage,
    angleWeights: z.record(z.number().min(0)),
    textStyleWeights: z.record(z.number().min(0)),
    topics: z
      .array(z.string().trim().min(1).max(AUTOMATION_TOPIC_MAX_CHARS))
      .max(AUTOMATION_TOPICS_MAX),
  })
  .strict();
export type AutomationPrefs = z.infer<typeof automationPrefsSchema>;

/** Lo que el wizard pisa sobre las preferencias de Blitz de la marca. */
export const automationPrefsOverridesSchema = automationPrefsSchema.partial();

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Use YYYY-MM-DD.");

export const createAutomationRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(AUTOMATION_NAME_MAX),
    accounts: z.array(automationAccountSchema).max(AUTOMATION_ACCOUNTS_MAX).default([]),
    perAccountPerDay: z
      .number()
      .int()
      .min(AUTOMATION_PER_ACCOUNT_PER_DAY_MIN)
      .max(AUTOMATION_PER_ACCOUNT_PER_DAY_MAX),
    durationWeeks: z
      .number()
      .int()
      .min(AUTOMATION_DURATION_WEEKS_MIN)
      .max(AUTOMATION_DURATION_WEEKS_MAX),
    /** Primer día, en `timezone`. */
    startDate: localDateSchema,
    /** IANA. Default: la de la marca. */
    timezone: timeZoneSchema.optional(),
    /** NO ESTÁ EN EL PRD. `null`/ausente = los horarios de la estrategia. */
    postingTimes: z
      .array(timeOfDaySchema)
      .max(AUTOMATION_POSTING_TIMES_MAX)
      .nullable()
      .optional(),
    postingMode: automationPostingModeSchema.optional(),
    youtubePrivacyStatus: youtubePrivacyStatusSchema.optional(),
    discloseAsAds: z.boolean().optional(),
    aiContentDisclaimer: z.boolean().optional(),
    prefs: automationPrefsOverridesSchema.optional(),
  })
  .strict();
export type CreateAutomationRequest = z.input<typeof createAutomationRequestSchema>;

/**
 * `name` en cualquier estado; el resto sólo en `DRAFT` (`FR-150`: *"la config
 * se bloquea al empezar a generar"*). `aiContentDisclaimer` tampoco después.
 */
export const updateAutomationRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(AUTOMATION_NAME_MAX).optional(),
    accounts: z.array(automationAccountSchema).max(AUTOMATION_ACCOUNTS_MAX).optional(),
    perAccountPerDay: z
      .number()
      .int()
      .min(AUTOMATION_PER_ACCOUNT_PER_DAY_MIN)
      .max(AUTOMATION_PER_ACCOUNT_PER_DAY_MAX)
      .optional(),
    durationWeeks: z
      .number()
      .int()
      .min(AUTOMATION_DURATION_WEEKS_MIN)
      .max(AUTOMATION_DURATION_WEEKS_MAX)
      .optional(),
    startDate: localDateSchema.optional(),
    timezone: timeZoneSchema.optional(),
    postingTimes: z
      .array(timeOfDaySchema)
      .max(AUTOMATION_POSTING_TIMES_MAX)
      .nullable()
      .optional(),
    postingMode: automationPostingModeSchema.optional(),
    youtubePrivacyStatus: youtubePrivacyStatusSchema.optional(),
    discloseAsAds: z.boolean().optional(),
    aiContentDisclaimer: z.boolean().optional(),
    prefs: automationPrefsOverridesSchema.optional(),
  })
  .strict();
export type UpdateAutomationRequest = z.input<typeof updateAutomationRequestSchema>;

export const LAUNCH_GATE_CODES = [
  "not_in_review",
  "content_generating",
  "no_ready_slots",
  "no_destinations",
  "destination_unavailable",
  "schedule_in_past",
  "posting_limit_conflicts",
  "youtube_slideshow",
  "content_budget",
  "ai_label_unsupported",
] as const;
export const launchGateCodeSchema = z.enum(LAUNCH_GATE_CODES);
export type LaunchGateCode = z.infer<typeof launchGateCodeSchema>;

/** `launchValidation` — `F-216`. Enumera **todos** los gates incumplidos. */
export const launchValidationSchema = z.object({
  ok: z.boolean(),
  checkedAt: msEpochSchema,
  gates: z.array(
    z.object({ code: launchGateCodeSchema, details: z.record(z.unknown()) }),
  ),
  summary: z.object({
    readySlots: z.number().int().nonnegative(),
    destinations: z.number().int().nonnegative(),
    posts: z.number().int().nonnegative(),
    contentSaves: z.number().int().nonnegative(),
  }),
});
export type LaunchValidation = z.infer<typeof launchValidationSchema>;

export const automationSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  status: automationStatusSchema,
  accounts: z.array(automationAccountSchema),
  perAccountPerDay: z.number().int(),
  durationWeeks: z.number().int(),
  /** `YYYY-MM-DD` en `timezone`. */
  startDate: z.string(),
  startDateUtc: msEpochSchema,
  timezone: z.string(),
  postingTimes: z.array(z.string()).nullable(),
  postingMode: automationPostingModeSchema.nullable(),
  youtubePrivacyStatus: youtubePrivacyStatusSchema.nullable(),
  discloseAsAds: z.boolean(),
  aiContentDisclaimer: z.boolean(),
  prefsSnapshot: automationPrefsSchema,
  generationQuota: z.number().int().nonnegative(),
  generationQuotaUsed: z.number().int().nonnegative(),
  /** Código estable de un `FAILED` (`llm_not_configured`, `all_builds_failed`, …). */
  failureCode: z.string().nullable(),
  launchValidation: launchValidationSchema.nullable(),
  /** Slots por estado. */
  progress: z.object({
    total: z.number().int().nonnegative(),
    byStatus: z.record(z.number().int().nonnegative()),
  }),
  /** `F-218`: totales de los posts de la campaña. Sólo en el detalle. */
  stats: z
    .object({
      posts: z.number().int().nonnegative(),
      published: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      views: z.number().int().nonnegative(),
      likes: z.number().int().nonnegative(),
      comments: z.number().int().nonnegative(),
    })
    .optional(),
  createdAt: msEpochSchema,
  updatedAt: msEpochSchema,
  launchedAt: msEpochSchema.nullable(),
  cancelledAt: msEpochSchema.nullable(),
  completedAt: msEpochSchema.nullable(),
});
export type Automation = z.infer<typeof automationSchema>;

export const automationListSchema = z.array(automationSchema);

export const platformCaptionSchema = z
  .object({
    caption: z.string().max(5_000),
    description: z.string().max(5_000).optional(),
  })
  .strict();

export const captionsByPlatformSchema = z.record(platformCaptionSchema);

export const automationSlotPostSchema = z.object({
  id: z.string().min(1),
  platform: z.string(),
  status: postStatusSchema,
  scheduledAt: msEpochSchema,
  postedAt: msEpochSchema.nullable(),
  postUrl: z.string().nullable(),
  views: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
});

export const automationSlotSchema = z.object({
  id: z.string().min(1),
  index: z.number().int().nonnegative(),
  status: automationSlotStatusSchema,
  contentType: blitzContentTypeSchema,
  scheduledAt: msEpochSchema.nullable(),
  generatedText: z.string().nullable(),
  /** Los textos de la pieza (uno por slide en un slideshow). */
  texts: z.array(z.string()),
  aiExplanation: z.string().nullable(),
  topic: z.string().nullable(),
  captionsByPlatform: captionsByPlatformSchema,
  failureReason: automationSlotFailureReasonSchema.nullable(),
  /** NO ESTÁ EN EL PRD: el motivo nuestro (`no_media`, `build_failed`, …). */
  errorCode: z.string().nullable(),
  contentId: z.string().nullable(),
  /** La media que abre la pieza (primera slide, fondo o hook), si sigue viva. */
  preview: z
    .object({ url: z.string().url(), kind: z.enum(["image", "video"]) })
    .nullable(),
  generationAttempts: z.number().int().nonnegative(),
  posts: z.array(automationSlotPostSchema),
});
export type AutomationSlot = z.infer<typeof automationSlotSchema>;
export const automationSlotListSchema = z.array(automationSlotSchema);

/**
 * `F-214`: tres grupos independientes. `captionsByPlatform` **reemplaza** el
 * mapa (una red omitida se borra). `texts` va con `generatedText` (se deriva).
 */
export const updateAutomationSlotRequestSchema = z
  .object({
    texts: z.array(z.string().min(1).max(5_000)).min(1).max(20).optional(),
    captionsByPlatform: captionsByPlatformSchema.optional(),
    scheduledAt: msEpochSchema.optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.texts !== undefined ||
      b.captionsByPlatform !== undefined ||
      b.scheduledAt !== undefined,
    { message: "Send texts, captionsByPlatform or scheduledAt." },
  );
export type UpdateAutomationSlotRequest = z.infer<
  typeof updateAutomationSlotRequestSchema
>;

/** `F-215`: re-roll, opcionalmente forzando el tipo. */
export const rerollAutomationSlotRequestSchema = z
  .object({ contentType: blitzContentTypeSchema.optional() })
  .strict();

export const automationSlotContentSchema = z.object({ contentId: z.string().min(1) });

/** Motivos de un `422` al generar (`FR-150`; los dos primeros son literales del PRD). */
export const AUTOMATION_GENERATION_ERRORS = [
  "AUTOMATION_NO_CONTENT_TYPE_SELECTED",
  "AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO",
  "AUTOMATION_YOUTUBE_REQUIRES_NO_SLIDESHOW",
  "AUTOMATION_NO_DESTINATIONS",
  "AUTOMATION_CONTENT_TYPE_NEEDS_MEDIA",
] as const;
