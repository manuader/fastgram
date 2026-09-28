/**
 * Anuncios pagos — sprint 9 (R), `D-21`, migración `0040_ads.sql` (donde está
 * el porqué de cada restricción).
 *
 * Todo por marca y bajo RLS. Los importes son **unidades mínimas** de la
 * moneda de la cuenta (`bigint`, modo número: el tope de cordura del dominio,
 * 10^10, entra holgado en un `number`).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { contents } from "./content.js";
import { companyRef } from "./identity.js";
import { createdAtOnly, timestamps, tsColumn } from "./_shared.js";

const money = () => bigint({ mode: "number" });

export const AD_ACCOUNT_STATUSES = ["pending", "active", "expired", "revoked"] as const;
export type AdAccountStatus = (typeof AD_ACCOUNT_STATUSES)[number];

/** Conexión de anuncios de una marca: una por marca. */
export const adAccounts = pgTable(
  "ad_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    /** `meta` o `fake` (modo demo, sin gasto posible). */
    provider: text().notNull(),
    status: text().$type<AdAccountStatus>().notNull().default("pending"),
    /** Ciphertext del token de usuario. Nunca sale por la API. */
    accessToken: text(),
    tokenExpiresAt: tsColumn(),
    metaUserId: text(),
    /** `act_…`; `null` mientras no se eligió. */
    adAccountId: text(),
    adAccountName: text(),
    currency: text(),
    timezoneName: text(),
    pageId: text(),
    pageName: text(),
    instagramUserId: text(),
    instagramUsername: text(),
    connectedAt: tsColumn(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("ad_accounts_company_uq").on(t.companyId)],
);

export const AD_CAMPAIGN_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type AdCampaignStatus = (typeof AD_CAMPAIGN_STATUSES)[number];
export const AD_PAUSE_REASONS = ["created", "manual", "daily_cap", "total_cap"] as const;
export type AdPauseReason = (typeof AD_PAUSE_REASONS)[number];

export const adCampaigns = pgTable(
  "ad_campaigns",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    adAccountRowId: uuid()
      .notNull()
      .references(() => adAccounts.id, { onDelete: "cascade" }),
    name: text().notNull(),
    objective: text().notNull(),
    status: text().$type<AdCampaignStatus>().notNull().default("PAUSED"),
    pausedReason: text().$type<AdPauseReason>().default("created"),
    dailyCapMinor: money().notNull(),
    totalCapMinor: money().notNull(),
    currency: text().notNull(),
    /** "Reel de prueba": campaña chica de una pieza. Sólo cambia cómo se muestra. */
    isTest: boolean().notNull().default(false),
    startDate: date({ mode: "string" }).notNull(),
    endTime: tsColumn(),
    targeting: jsonb().notNull(),
    destinationUrl: text(),
    resultActionType: text(),
    platformCampaignId: text().notNull(),
    pausedAt: tsColumn(),
    activatedAt: tsColumn(),
    lastSyncedAt: tsColumn(),
    lastSyncError: text(),
    ...timestamps(),
  },
  (t) => [
    index("ad_campaigns_company_created_idx").on(t.companyId, t.createdAt),
    check(
      "ad_campaigns_caps_check",
      sql`${t.dailyCapMinor} > 0 and ${t.totalCapMinor} >= ${t.dailyCapMinor}`,
    ),
  ],
);

export const adSets = pgTable(
  "ad_sets",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    campaignId: uuid()
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** `A`, `B`… en un A/B; `null` sin experimento. */
    variantLabel: text(),
    dailyBudgetMinor: money().notNull(),
    platformAdSetId: text().notNull(),
    ...timestamps(),
  },
  (t) => [index("ad_sets_campaign_idx").on(t.companyId, t.campaignId)],
);

export const ads = pgTable(
  "ads",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    campaignId: uuid()
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    adSetId: uuid()
      .notNull()
      .references(() => adSets.id, { onDelete: "cascade" }),
    /** La pieza de la Library. `null` si después se borró. */
    contentId: uuid().references(() => contents.id, { onDelete: "set null" }),
    name: text().notNull(),
    mediaKind: text().$type<"video" | "image">().notNull(),
    message: text().notNull(),
    platformAdId: text().notNull(),
    platformCreativeId: text().notNull(),
    ...timestamps(),
  },
  (t) => [
    index("ads_campaign_idx").on(t.companyId, t.campaignId),
    uniqueIndex("ads_platform_uq").on(t.companyId, t.platformAdId),
  ],
);

export const adExperiments = pgTable(
  "ad_experiments",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    campaignId: uuid()
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    metric: text().$type<"ctr" | "cvr">().notNull(),
    /** Id del `ad_study` de Meta, si se pudo crear. */
    platformStudyId: text(),
    /** Por qué no hay estudio en Meta (sin dueño, rechazo): el A/B igual corre. */
    platformStudyError: text(),
    winnerAdSetId: uuid().references(() => adSets.id, { onDelete: "set null" }),
    decidedAt: tsColumn(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("ad_experiments_campaign_uq").on(t.companyId, t.campaignId)],
);

export const adInsightsDaily = pgTable(
  "ad_insights_daily",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    campaignId: uuid()
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    adId: uuid()
      .notNull()
      .references(() => ads.id, { onDelete: "cascade" }),
    /** Día en la zona de la cuenta (`date_start`). */
    date: date({ mode: "string" }).notNull(),
    spendMinor: money().notNull().default(0),
    impressions: money().notNull().default(0),
    clicks: money().notNull().default(0),
    reach: money(),
    actions: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    actionValuesMinor: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    syncedAt: tsColumn().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_insights_daily_ad_date_uq").on(t.companyId, t.adId, t.date),
    index("ad_insights_daily_campaign_date_idx").on(t.companyId, t.campaignId, t.date),
  ],
);

export const AD_ACTION_KINDS = [
  "create",
  "activation_preview",
  "activate",
  "pause",
  "budget_change",
  "cap_pause",
  "cap_pause_failed",
] as const;
export type AdActionKind = (typeof AD_ACTION_KINDS)[number];

/** Auditoría: cada activación, cambio de presupuesto y corte, con el máximo mostrado. */
export const adActions = pgTable(
  "ad_actions",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    campaignId: uuid()
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    kind: text().$type<AdActionKind>().notNull(),
    /** `owner` (la app, con la credencial del dueño) o `guard` (el job). */
    actor: text().$type<"owner" | "guard">().notNull(),
    /** En un preview: qué se va a confirmar (`activate` / `budget_increase`). */
    previewAction: text(),
    confirmationToken: text(),
    /** El preview que se consumió para esta acción. */
    previewId: uuid(),
    dailyCapMinor: money(),
    totalCapMinor: money(),
    maxSpendMinor: money(),
    expiresAt: tsColumn(),
    consumedAt: tsColumn(),
    detail: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...createdAtOnly(),
  },
  (t) => [
    index("ad_actions_campaign_created_idx").on(t.companyId, t.campaignId, t.createdAt),
    uniqueIndex("ad_actions_token_uq")
      .on(t.confirmationToken)
      .where(sql`${t.confirmationToken} is not null`),
  ],
);
