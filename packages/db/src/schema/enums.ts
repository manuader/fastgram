/**
 * Enums de Postgres.
 *
 * Los valores literales salen del PRD §8 y §6 **tal cual están escritos ahí**, incluido
 * el mayúsculas/minúsculas mezclado (`BUILDING` en `Content` vs `ready` en `Media` vs
 * `A_oauth` en `BrandSource`). No se normalizan: son parte del contrato público de la
 * API v1 y cualquier "arreglo" cosmético rompe a los integradores.
 *
 * Cada `as const` de valores se exporta además como array de TS para poder fijarlo en
 * un test: si alguien agrega un estado al enum sin pasar por el PRD, el test lo ve.
 */

import { pgEnum } from "drizzle-orm/pg-core";

// ───────────────────────── DATA-001 · User ─────────────────────────

export const USER_DELETION_STATUS = ["none", "in_progress", "rejected"] as const;
export const userDeletionStatusEnum = pgEnum(
  "user_deletion_status",
  USER_DELETION_STATUS,
);

// ───────────────────────── DATA-002 · Company ─────────────────────────

export const COMPANY_STATUS = ["draft", "preparing", "active", "soft_deleted"] as const;
export const companyStatusEnum = pgEnum("company_status", COMPANY_STATUS);

export const SUBSCRIPTION_STATUS = [
  "trialing",
  "active",
  "past_due",
  "canceled",
] as const;
export const subscriptionStatusEnum = pgEnum("subscription_status", SUBSCRIPTION_STATUS);

// ───────────────────────── DATA-003 · WorkspaceMembership ─────────────────────────

export const MEMBERSHIP_ROLE = ["owner", "member"] as const;
export const membershipRoleEnum = pgEnum("membership_role", MEMBERSHIP_ROLE);

export const MEMBERSHIP_STATUS = ["invited", "active", "removed"] as const;
export const membershipStatusEnum = pgEnum("membership_status", MEMBERSHIP_STATUS);

// ───────────────────────── DATA-004 · CompanyProfile ─────────────────────────

export const COMPANY_PROFILE_STATUS = ["pending", "ready", "failed", "partial"] as const;
export const companyProfileStatusEnum = pgEnum(
  "company_profile_status",
  COMPANY_PROFILE_STATUS,
);

// ───────────────────────── DATA-006 · BlitzPreferences ─────────────────────────

/** `genderFilter` ∈ {`man`, `woman`, `null`}. El `null` es la ausencia de fila. */
export const GENDER_FILTER = ["man", "woman"] as const;
export const genderFilterEnum = pgEnum("gender_filter", GENDER_FILTER);

// ───────────────────────── DATA-007 · Suggestion ─────────────────────────

/**
 * FR-050 (Validation) acota el `contentType` de una sugerencia a cuatro valores:
 * `custom` existe en `Content` (DATA-008) pero **no** puede salir de la cola de
 * discovery. Por eso son dos enums y no uno.
 */
export const SUGGESTION_CONTENT_TYPE = [
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
] as const;
export const suggestionContentTypeEnum = pgEnum(
  "suggestion_content_type",
  SUGGESTION_CONTENT_TYPE,
);

export const SUGGESTION_STATUS = ["queued", "popped", "discarded"] as const;
export const suggestionStatusEnum = pgEnum("suggestion_status", SUGGESTION_STATUS);

// ───────────────────────── DATA-008 · Content ─────────────────────────

export const CONTENT_TYPE = [
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
  "custom",
] as const;
export const contentTypeEnum = pgEnum("content_type", CONTENT_TYPE);

export const CONTENT_STATUS = ["BUILDING", "CREATED", "FAILED"] as const;
export const contentStatusEnum = pgEnum("content_status", CONTENT_STATUS);

// ───────────────────────── DATA-009 · ContentTextBox ─────────────────────────

export const TEXT_BOX_BACKGROUND_STYLE = ["pill", "full-width"] as const;

// ───────────────────────── DATA-010 · Media ─────────────────────────

export const MEDIA_TYPE = ["image", "video"] as const;
export const mediaTypeEnum = pgEnum("media_type", MEDIA_TYPE);

export const MEDIA_STATUS = ["processing", "ready", "failed"] as const;
export const mediaStatusEnum = pgEnum("media_status", MEDIA_STATUS);

/**
 * `brand_kit` (migración `0013`, `PU-MEDIA-002`): fondos de marca generados por
 * `services/render`. A diferencia de `generated`, **se listan** en el Media Bank.
 */
export const MEDIA_ORIGIN = [
  "manual_upload",
  "generated",
  "demo",
  "internal",
  "brand_kit",
] as const;
export const mediaOriginEnum = pgEnum("media_origin", MEDIA_ORIGIN);

// ───────────────────────── DATA-011 · MediaSet ─────────────────────────

export const MEDIA_SET_KIND = ["SLIDESHOW", "VIDEO", "CURATED"] as const;
export const mediaSetKindEnum = pgEnum("media_set_kind", MEDIA_SET_KIND);

// ───────────────────────── DATA-012 · AudioTrack ─────────────────────────

export const AUDIO_LIBRARY = ["wall-of-text", "video-hook"] as const;
export const audioLibraryEnum = pgEnum("audio_library", AUDIO_LIBRARY);

// ───────────────────────── DATA-013 · Influencer ─────────────────────────

export const INFLUENCER_STATUS = [
  "generating_variations",
  "training",
  "ready",
  "failed",
  "inactive",
] as const;
export const influencerStatusEnum = pgEnum("influencer_status", INFLUENCER_STATUS);

// ───────────────────────── DATA-014 · InfluencerAsset ─────────────────────────

export const INFLUENCER_ASSET_KIND = ["image", "video"] as const;
export const influencerAssetKindEnum = pgEnum(
  "influencer_asset_kind",
  INFLUENCER_ASSET_KIND,
);

// ───────────────────────── DATA-016 · Connection ─────────────────────────

export const SOCIAL_PLATFORM = [
  "tiktok",
  "instagram",
  "youtube",
  "linkedin",
  "reddit",
] as const;
export const socialPlatformEnum = pgEnum("social_platform", SOCIAL_PLATFORM);

export const CONNECTION_STATUS = ["active", "expired", "paused", "revoked"] as const;
export const connectionStatusEnum = pgEnum("connection_status", CONNECTION_STATUS);

// ───────────────────────── DATA-017 · WarmedAccount ─────────────────────────

/** FR-060: *"Warmed accounts sólo soportan `tiktok` e `instagram`"*. */
export const WARMED_PLATFORM = ["tiktok", "instagram"] as const;
export const warmedPlatformEnum = pgEnum("warmed_platform", WARMED_PLATFORM);

export const POSTING_AVAILABILITY = [
  "available",
  "checking",
  "replacement_needed",
] as const;
export const postingAvailabilityEnum = pgEnum(
  "posting_availability",
  POSTING_AVAILABILITY,
);

export const WARMED_COUNTRY = ["US", "EU"] as const;
export const warmedCountryEnum = pgEnum("warmed_country", WARMED_COUNTRY);

// ───────────────────────── DATA-019 · ReplacementDecision ─────────────────────────

export const REPLACEMENT_DECISION_STATUS = ["pending", "resolved"] as const;
export const replacementDecisionStatusEnum = pgEnum(
  "replacement_decision_status",
  REPLACEMENT_DECISION_STATUS,
);

// ───────────────────────── DATA-020 · Post ─────────────────────────

/** `linkedin` entra por automations (DATA-020, nota de la columna `platform`). */
export const POST_PLATFORM = [
  "tiktok",
  "instagram",
  "youtube",
  "reddit",
  "linkedin",
] as const;
export const postPlatformEnum = pgEnum("post_platform", POST_PLATFORM);

export const POST_ACCOUNT_TYPE = ["oauth", "warmed"] as const;
export const postAccountTypeEnum = pgEnum("post_account_type", POST_ACCOUNT_TYPE);

/** Enum normativo de FR-060 — incluido `CANCELLED`, que el PRD marca entre paréntesis. */
export const POST_STATUS = [
  "BUILDING",
  "CREATED",
  "SCHEDULED",
  "UPLOADING_TO_TIKTOK",
  "IN_USER_INBOX",
  "POSTED",
  "FAILED",
  "DELETED",
  "AWAITING_RECONNECT",
  "CANCELLED",
] as const;
export const postStatusEnum = pgEnum("post_status", POST_STATUS);

/** *"`captionAdjustmentReason` actualmente sólo vale `repeated_mention`"* (FR-060). */
export const CAPTION_ADJUSTMENT_REASON = ["repeated_mention"] as const;
export const captionAdjustmentReasonEnum = pgEnum(
  "caption_adjustment_reason",
  CAPTION_ADJUSTMENT_REASON,
);

export const POSTING_MODE = ["inbox", "direct"] as const;
export const postingModeEnum = pgEnum("posting_mode", POSTING_MODE);

export const PRIVACY_LEVEL = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;
export const privacyLevelEnum = pgEnum("privacy_level", PRIVACY_LEVEL);

export const INSTAGRAM_SLIDESHOW_FORMAT = ["carousel", "reel"] as const;
export const instagramSlideshowFormatEnum = pgEnum(
  "instagram_slideshow_format",
  INSTAGRAM_SLIDESHOW_FORMAT,
);

export const TIKTOK_SOUND_MODE = ["audible", "silent"] as const;
export const tiktokSoundModeEnum = pgEnum("tiktok_sound_mode", TIKTOK_SOUND_MODE);

// ───────────────────────── DATA-021 · Automation ─────────────────────────

export const AUTOMATION_STATUS = [
  "DRAFT",
  "GENERATING",
  "REVIEW",
  "BUILDING",
  "ACTIVE",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;
export const automationStatusEnum = pgEnum("automation_status", AUTOMATION_STATUS);

// ───────────────────────── DATA-022 · AutomationSlot ─────────────────────────

export const AUTOMATION_SLOT_STATUS = [
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
export const automationSlotStatusEnum = pgEnum(
  "automation_slot_status",
  AUTOMATION_SLOT_STATUS,
);

export const AUTOMATION_SLOT_FAILURE_REASON = [
  "no_unique_content",
  "no_demo_video",
] as const;
export const automationSlotFailureReasonEnum = pgEnum(
  "automation_slot_failure_reason",
  AUTOMATION_SLOT_FAILURE_REASON,
);

// ───────────────────────── DATA-025 · BanRiskAssessment ─────────────────────────

export const BAN_RISK_LEVEL = ["safe", "caution", "warning", "danger"] as const;
export const banRiskLevelEnum = pgEnum("ban_risk_level", BAN_RISK_LEVEL);

// ───────────────────────── DATA-026 · ApiKey ─────────────────────────

export const API_KEY_KIND = ["workspace", "partner"] as const;
export const apiKeyKindEnum = pgEnum("api_key_kind", API_KEY_KIND);

// ───────────────────────── DATA-027 · IdempotencyRecord ─────────────────────────

export const IDEMPOTENCY_STATE = ["in_flight", "completed", "released"] as const;
export const idempotencyStateEnum = pgEnum("idempotency_state", IDEMPOTENCY_STATE);

// ───────────────────────── DATA-028 · UploadReservation ─────────────────────────

export const UPLOAD_RESERVATION_STATE = [
  "reserved",
  "finalizing",
  "committed",
  "failed",
  "expired",
] as const;
export const uploadReservationStateEnum = pgEnum(
  "upload_reservation_state",
  UPLOAD_RESERVATION_STATE,
);

// ───────────────────────── DATA-031 · BrandSource ─────────────────────────

export const BRAND_SOURCE_TYPE = [
  "website",
  "instagram",
  "tiktok",
  "x",
  "youtube",
  "linkedin",
  "other_url",
  "manual",
] as const;
export const brandSourceTypeEnum = pgEnum("brand_source_type", BRAND_SOURCE_TYPE);

/** Tiers de adquisición de `FR-011.4`. */
export const ACQUISITION_TIER = [
  "A_oauth",
  "B_public_api",
  "C_page_fetch",
  "D_assisted",
] as const;
export const acquisitionTierEnum = pgEnum("acquisition_tier", ACQUISITION_TIER);

export const BRAND_SOURCE_STATUS = [
  "pending",
  "analyzing",
  "ready",
  "partial",
  "failed",
  "stale",
] as const;
export const brandSourceStatusEnum = pgEnum("brand_source_status", BRAND_SOURCE_STATUS);

export const BRAND_SOURCE_FAILURE_REASON = [
  "not_found",
  "private",
  "insufficient_content",
  "rate_limited",
  "provider_unavailable",
  "unsupported_platform",
  "already_registered",
] as const;
export const brandSourceFailureReasonEnum = pgEnum(
  "brand_source_failure_reason",
  BRAND_SOURCE_FAILURE_REASON,
);

// ───────────────────────── FR-050 · Content save bucket ─────────────────────────

/**
 * De qué bucket salió el content save. Los tres tienen precios distintos
 * (§16.2), así que reembolsar sin saber cuál fue no es reembolsar.
 */
export const SAVE_BUCKET = ["included", "purchased", "overage"] as const;
export const saveBucketEnum = pgEnum("save_bucket", SAVE_BUCKET);

// ───────────────────────── DATA-033 · JudgmentRecord ─────────────────────────

export const DECISION_POINT = [
  "DP-001",
  "DP-002",
  "DP-003",
  "DP-004",
  "DP-005",
  "DP-006",
  "DP-007",
] as const;
export const decisionPointEnum = pgEnum("decision_point", DECISION_POINT);

export const JUDGMENT_ADAPTER = ["llm", "jev", "stub"] as const;
export const judgmentAdapterEnum = pgEnum("judgment_adapter", JUDGMENT_ADAPTER);

// ───────────────────────── Entitlements (DATA-002) ─────────────────────────

/**
 * El PRD los introduce con *"p. ej."*: la lista **no es cerrada**, por eso la columna
 * `entitlements` es `text[]` y no un enum. Estos cinco son los únicos nombrados.
 */
export const KNOWN_ENTITLEMENTS = [
  "tiktokDirect",
  "autoCaptions",
  "warmedPosting",
  "automations",
  "aiStudio",
] as const;
