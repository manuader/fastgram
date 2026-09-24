/**
 * Descubrimiento y engagement — `DATA-023` TrendingItem, `DATA-024` Lead (Reddit),
 * `DATA-025` BanRiskAssessment.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAtOnly, softDelete, tsColumn, timestamps } from "./_shared.js";
import { companies, companyRef } from "./identity.js";
import { banRiskLevelEnum, socialPlatformEnum } from "./enums.js";

/** `0022`: de dónde sale una fila de `trending_items`. */
export const TRENDING_ORIGIN = ["catalog", "owner"] as const;
export type TrendingOrigin = (typeof TRENDING_ORIGIN)[number];

/** `0022`: el formato de una referencia. `null` = no se supo. */
export const TRENDING_FORMAT = ["video", "slideshow", "image", "text"] as const;
export type TrendingFormat = (typeof TRENDING_FORMAT)[number];

/** `0022`: en qué quedó la lectura de metadata sin login (`yt-dlp`). */
export const TRENDING_INGEST_STATE = ["pending", "ready", "failed"] as const;
export type TrendingIngestState = (typeof TRENDING_INGEST_STATE)[number];

/**
 * DATA-023 — `TrendingItem`.
 *
 * Nació **global** (el PRD la dibuja como el catálogo de Fastlane, sin
 * `companyId`). `OQ-13`: el clon no replica ese catálogo de terceros. Desde
 * `0022_inspiration_references.sql` también guarda las **referencias del
 * dueño** (Inspiration de uso personal): `origin = 'owner'` con `companyId`,
 * bajo una política RLS que deja ver el catálogo y sólo lo propio. El CHECK
 * `trending_items_origin_company` ata las dos columnas.
 *
 * El PRD no enumera los valores de `platform` para esta entidad; se reusa
 * `social_platform`, que es el único conjunto de plataformas que el PRD define.
 * `platform`, `permalink`, `views` y `likes` son nullable desde `0022`: un clip
 * subido no tiene link, y un sitio que no da likes no tiene "0 likes".
 */
export const trendingItems = pgTable(
  "trending_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** `null` = fila del catálogo global; con valor = referencia del dueño. */
    companyId: uuid().references(() => companies.id, { onDelete: "cascade" }),
    origin: text({ enum: TRENDING_ORIGIN }).notNull().default("catalog"),
    platform: socialPlatformEnum(),
    permalink: text(),
    thumbnailUrl: text(),
    mediaUrls: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isSlideshow: boolean().notNull().default(false),
    slideCount: integer().notNull().default(0),
    views: integer().default(0),
    likes: integer().default(0),
    comments: integer(),
    niches: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    textOverlays: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Texto de terceros: dato, nunca instrucción. */
    title: text(),
    author: text(),
    caption: text(),
    hashtags: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    format: text({ enum: TRENDING_FORMAT }),
    durationSeconds: integer(),
    ingestState: text({ enum: TRENDING_INGEST_STATE }).notNull().default("ready"),
    /** Un `MediaImportFailureCode` estable. Nunca el stderr de `yt-dlp`. */
    ingestError: text(),
    /** El import por link del clip (`PU-MEME-001`), si se pidió guardarlo. */
    importId: uuid(),
    /** El clip en el Media Bank: importado por link o subido. */
    mediaId: uuid(),
    fetchedAt: tsColumn().notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index("trending_items_platform_fetched_idx").on(t.platform, t.fetchedAt),
    index("trending_items_created_idx").on(t.createdAt),
    index("trending_items_company_created_idx").on(t.companyId, t.createdAt),
    check("trending_items_origin", sql`${t.origin} in ('catalog', 'owner')`),
    check(
      "trending_items_origin_company",
      sql`(${t.origin} = 'owner') = (${t.companyId} IS NOT NULL)`,
    ),
    check(
      "trending_items_catalog_source",
      sql`${t.origin} = 'owner' OR (${t.platform} IS NOT NULL AND ${t.permalink} IS NOT NULL)`,
    ),
    check(
      "trending_items_owner_source",
      sql`${t.origin} = 'catalog' OR ${t.permalink} IS NOT NULL OR ${t.mediaId} IS NOT NULL`,
    ),
    check(
      "trending_items_format",
      sql`${t.format} IS NULL OR ${t.format} in ('video', 'slideshow', 'image', 'text')`,
    ),
    check(
      "trending_items_ingest_state",
      sql`${t.ingestState} in ('pending', 'ready', 'failed')`,
    ),
  ],
);

/**
 * DATA-024 — `Lead` (Reddit).
 * El PRD no enumera los valores de `threadState`; texto hasta que lo haga.
 *
 * `0021_engagement.sql` agrega lo que el motor necesita (`P4-ENGAGE-001…011`):
 * de dónde vino, el snapshot del post, las respuestas **crudas** del juicio
 * `JV-2` (`scoreAnswers`, para recalcular sin reinferir) y el score/tier
 * compuestos en código, el estado del borrador y el seguimiento del hilo. El
 * porqué de cada columna está en la migración.
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
    // ── 0021 ──
    source: text().notNull().default("discovery"),
    permalink: text(),
    postCreatedAt: tsColumn(),
    numComments: integer().notNull().default(0),
    matchedKeywords: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    contextComments: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subredditRules: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    scoreStatus: text().notNull().default("pending"),
    scoreAnswers: jsonb().$type<Record<string, unknown>>(),
    scoreVersion: text(),
    leadScore: numeric({ precision: 10, scale: 4 }),
    leadTier: text(),
    scoredAt: tsColumn(),
    replyStatus: text().notNull().default("none"),
    replyError: text(),
    replyGeneratedAt: tsColumn(),
    lastSyncedAt: tsColumn(),
    ourComments: integer().notNull().default(0),
    repliesToUs: integer().notNull().default(0),
    newActivity: boolean().notNull().default(false),
  },
  (t) => [
    index("leads_company_created_idx").on(t.companyId, t.createdAt),
    index("leads_company_live_created_idx")
      .on(t.companyId, t.createdAt)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex("leads_company_post_uq").on(t.companyId, t.redditPostId),
    check("leads_source_check", sql`${t.source} in ('discovery', 'manual')`),
    check(
      "leads_score_status_check",
      sql`${t.scoreStatus} in ('pending', 'scored', 'failed', 'no_judgment')`,
    ),
    check(
      "leads_tier_check",
      sql`${t.leadTier} is null or ${t.leadTier} in ('top', 'general', 'hidden', 'vetoed')`,
    ),
    check(
      "leads_reply_status_check",
      sql`${t.replyStatus} in ('none', 'generating', 'ready', 'failed')`,
    ),
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
    // ── 0021: lo que el medidor contó (DP-003: calculado en código) ──
    sampleSize: integer().notNull().default(0),
    counts: jsonb()
      .$type<{ valueAdd: number; subtle: number; direct: number; unlabeled: number }>()
      .notNull()
      .default(sql`'{"valueAdd":0,"subtle":0,"direct":0,"unlabeled":0}'::jsonb`),
    windowDays: integer().notNull().default(30),
    smallSample: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [index("ban_risk_assessments_company_created_idx").on(t.companyId, t.createdAt)],
);
