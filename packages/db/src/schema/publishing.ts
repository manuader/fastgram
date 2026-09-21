/**
 * Publicación — `DATA-016` Connection, `DATA-017` WarmedAccount,
 * `DATA-018` WarmedSlotBalance, `DATA-019` ReplacementDecision, `DATA-020` Post.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAtOnly, tsColumn, timestamps } from "./_shared.js";
import { companyRef, users } from "./identity.js";
import { contents } from "./content.js";
import { automationSlots } from "./automations.js";
import {
  captionAdjustmentReasonEnum,
  connectionStatusEnum,
  instagramSlideshowFormatEnum,
  postAccountTypeEnum,
  postPlatformEnum,
  postStatusEnum,
  postingAvailabilityEnum,
  postingModeEnum,
  privacyLevelEnum,
  replacementDecisionStatusEnum,
  socialPlatformEnum,
  tiktokSoundModeEnum,
  warmedCountryEnum,
  warmedPlatformEnum,
} from "./enums.js";

/**
 * DATA-016 — `Connection` (OAuth).
 *
 * `accessToken` / `refreshToken` guardan **ciphertext**, nunca el token en claro: el
 * PRD los marca *"cifrados, nunca expuestos"*. El cifrado es responsabilidad del
 * adaptador de identidad social, no de esta capa; acá son `text` opaco.
 */
export const connections = pgTable(
  "connections",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    platform: socialPlatformEnum().notNull(),
    platformUserId: text().notNull(),
    platformUsername: text().notNull(),
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    publishable: boolean().notNull().default(false),
    tokenExpiry: tsColumn(),
    /** Ciphertext. NUNCA se devuelve por API. */
    accessToken: text(),
    /** Ciphertext. NUNCA se devuelve por API. */
    refreshToken: text(),
    status: connectionStatusEnum().notNull().default("active"),
    ...timestamps(),
  },
  (t) => [
    index("connections_company_created_idx").on(t.companyId, t.createdAt),
    index("connections_company_platform_idx").on(t.companyId, t.platform, t.status),
  ],
);

/**
 * DATA-017 — `WarmedAccount`. PK `warmedAccountId` (nombre literal del PRD/API).
 *
 * `status` queda como `text`: el PRD lista el campo pero **no enumera sus valores**
 * (sólo los de `postingAvailability`). No se inventa un enum. PENDIENTE.
 */
export const warmedAccounts = pgTable(
  "warmed_accounts",
  {
    warmedAccountId: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    /** Literal `"warmed"` en el PRD; es el discriminador que ve el cliente. */
    accountType: text().notNull().default("warmed"),
    platform: warmedPlatformEnum().notNull(),
    username: text().notNull(),
    displayName: text(),
    profilePictureUrl: text(),
    status: text().notNull(),
    postable: boolean().notNull().default(false),
    postingAvailability: postingAvailabilityEnum().notNull().default("checking"),
    /** FR-060: el lead time es **de la cuenta**, no global. */
    minLeadTimeMs: bigint({ mode: "number" }).notNull(),
    country: warmedCountryEnum().notNull(),
    niche: text(),
    keywords: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    approvedAt: tsColumn(),
    ...timestamps(),
  },
  (t) => [
    index("warmed_accounts_company_created_idx").on(t.companyId, t.createdAt),
    check("warmed_accounts_account_type", sql`${t.accountType} = 'warmed'`),
  ],
);

/** DATA-018 — `WarmedSlotBalance`. Una fila por company. */
export const warmedSlotBalances = pgTable(
  "warmed_slot_balances",
  {
    companyId: companyRef().primaryKey(),
    slotBalance: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("warmed_slot_balances_company_created_idx").on(t.companyId, t.createdAt),
    check("warmed_slot_balances_non_negative", sql`${t.slotBalance} >= 0`),
  ],
);

/** DATA-019 — `ReplacementDecision`. */
export const replacementDecisions = pgTable(
  "replacement_decisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    warmedAccountId: uuid()
      .notNull()
      .references(() => warmedAccounts.warmedAccountId, { onDelete: "cascade" }),
    options: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: replacementDecisionStatusEnum().notNull().default("pending"),
    decidedByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    ...createdAtOnly(),
  },
  (t) => [
    index("replacement_decisions_company_created_idx").on(t.companyId, t.createdAt),
  ],
);

/**
 * DATA-020 — `Post`.
 *
 * `caption` guarda **siempre** la copy original del usuario; `publishedCaption` la copy
 * que efectivamente salió si la plataforma obligó a ajustarla (FR-060). Confundirlas
 * hace que el usuario vea reescrito lo que escribió.
 */
export const posts = pgTable(
  "posts",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    contentId: uuid()
      .notNull()
      .references(() => contents.id, { onDelete: "restrict" }),
    platform: postPlatformEnum().notNull(),
    accountType: postAccountTypeEnum().notNull(),
    connectionId: uuid().references(() => connections.id, { onDelete: "set null" }),
    warmedAccountId: uuid().references(() => warmedAccounts.warmedAccountId, {
      onDelete: "set null",
    }),
    connectionUsername: text(),
    scheduledAtUtc: tsColumn().notNull(),
    caption: text(),
    description: text(),
    publishedCaption: text(),
    captionAdjustmentReason: captionAdjustmentReasonEnum(),
    postingMode: postingModeEnum(),
    privacyLevel: privacyLevelEnum(),
    discloseAsAds: boolean(),
    aiContentDisclaimer: boolean(),
    instagramSlideshowFormat: instagramSlideshowFormatEnum(),
    tiktokSoundMode: tiktokSoundModeEnum(),
    tiktokSoundId: text(),
    status: postStatusEnum().notNull().default("SCHEDULED"),
    cancellationPending: boolean().notNull().default(false),
    tiktokProcessingDelayed: boolean().notNull().default(false),
    /** Neutral respecto al proveedor (PRD §10). Nunca el código crudo de la plataforma. */
    errorCode: text(),
    errorMessage: text(),
    postUrl: text(),
    postedAt: tsColumn(),
    views: integer().notNull().default(0),
    likes: integer().notNull().default(0),
    comments: integer().notNull().default(0),
    automationSlotId: uuid().references(() => automationSlots.id, {
      onDelete: "set null",
    }),
    ...timestamps(),
  },
  (t) => [
    index("posts_company_created_idx").on(t.companyId, t.createdAt),
    index("posts_company_scheduled_idx").on(t.companyId, t.scheduledAtUtc),
    index("posts_content_idx").on(t.contentId),
    /**
     * *"`connectionId` y `warmedAccountId` son **mutuamente excluyentes**"* (DATA-020,
     * FR-060). Exactamente uno de los dos.
     */
    check(
      "posts_account_exclusive",
      sql`num_nonnulls(${t.connectionId}, ${t.warmedAccountId}) = 1`,
    ),
    /** El discriminador tiene que coincidir con la columna que está poblada. */
    check(
      "posts_account_type_matches",
      sql`(${t.accountType} = 'oauth' and ${t.connectionId} is not null)
          or (${t.accountType} = 'warmed' and ${t.warmedAccountId} is not null)`,
    ),
    /** FR-060: *"Warmed accounts sólo soportan `tiktok` e `instagram`"*. */
    check(
      "posts_warmed_platform_supported",
      sql`${t.accountType} <> 'warmed' or ${t.platform} in ('tiktok', 'instagram')`,
    ),
  ],
);
