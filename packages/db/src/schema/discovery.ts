/**
 * Descubrimiento y engagement — `DATA-023` TrendingItem, `DATA-024` Lead (Reddit),
 * `DATA-025` BanRiskAssessment.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAtOnly, softDelete, tsColumn, timestamps } from "./_shared";
import { companyRef } from "./identity";
import { banRiskLevelEnum, socialPlatformEnum } from "./enums";

/**
 * DATA-023 — `TrendingItem`.
 *
 * **Global, no workspace-scoped** (el PRD lo dice explícitamente en el diagrama de
 * relaciones). Sin `companyId` ni política RLS por compañía.
 *
 * El PRD no enumera los valores de `platform` para esta entidad; se reusa
 * `social_platform`, que es el único conjunto de plataformas que el PRD define.
 */
export const trendingItems = pgTable(
  "trending_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    platform: socialPlatformEnum().notNull(),
    permalink: text().notNull(),
    thumbnailUrl: text(),
    mediaUrls: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isSlideshow: boolean().notNull().default(false),
    slideCount: integer().notNull().default(0),
    views: integer().notNull().default(0),
    likes: integer().notNull().default(0),
    niches: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    textOverlays: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    fetchedAt: tsColumn().notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index("trending_items_platform_fetched_idx").on(t.platform, t.fetchedAt),
    index("trending_items_created_idx").on(t.createdAt),
  ],
);

/**
 * DATA-024 — `Lead` (Reddit).
 * El PRD no enumera los valores de `threadState`; texto hasta que lo haga.
 */
export const leads = pgTable(
  "leads",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    redditPostId: text().notNull(),
    subreddit: text().notNull(),
    title: text().notNull(),
    body: text(),
    author: text(),
    score: integer().notNull().default(0),
    engagementScore: numeric({ precision: 10, scale: 4 }),
    whyThisLead: text(),
    seenAt: tsColumn(),
    repliedAt: tsColumn(),
    threadState: text(),
    generatedReply: text(),
    ...softDelete(),
    ...createdAtOnly(),
  },
  (t) => [
    index("leads_company_created_idx").on(t.companyId, t.createdAt),
    index("leads_company_live_created_idx")
      .on(t.companyId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** DATA-025 — `BanRiskAssessment`. 1:1 por company, por eso `companyId` es la PK. */
export const banRiskAssessments = pgTable(
  "ban_risk_assessments",
  {
    companyId: companyRef().primaryKey(),
    level: banRiskLevelEnum().notNull(),
    promoRatio: numeric({ precision: 5, scale: 4 }),
    recommendation: text(),
    computedAt: tsColumn().notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [index("ban_risk_assessments_company_created_idx").on(t.companyId, t.createdAt)],
);
