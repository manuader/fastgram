/**
 * Influencers — `DATA-013` Influencer, `DATA-014` InfluencerAsset,
 * `DATA-015` InfluencerConfig.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAtOnly, timestamps } from "./_shared";
import { companyRef } from "./identity";
import { influencerAssetKindEnum, influencerStatusEnum } from "./enums";
import { INFLUENCER_LIMITS } from "../limits";

/** DATA-013 — `Influencer`. Cap: 50 activos por workspace (se aplica en el repo). */
export const influencers = pgTable(
  "influencers",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    name: text().notNull(),
    /**
     * El PRD no enumera los valores de `gender` en DATA-013 (la UI lo muestra como un
     * `select` con placeholder `Select…` pero no lista las opciones). Texto libre, no un
     * enum inventado. PENDIENTE: fijar la taxonomía cuando el PRD la dé.
     */
    gender: text().notNull(),
    age: integer().notNull(),
    ethnicity: text().notNull(),
    baseImageUrl: text(),
    status: influencerStatusEnum().notNull().default("generating_variations"),
    progress: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),

    // ── Campos internos: el PRD dice "nunca expuestos". Viven acá, no salen por API. ──
    soulId: text(),
    baseCharacterCmlId: text(),
    /**
     * NO ESTÁ EN EL PRD (como columna con nombre): DATA-013 menciona *"ids de media y de
     * job"* entre los campos internos pero **no los nombra**. Inventar nombres sería
     * peor que agruparlos; cuando el PRD los nombre, se desnormalizan.
     */
    internalRefs: jsonb(),

    ...timestamps(),
  },
  (t) => [
    index("influencers_company_created_idx").on(t.companyId, t.createdAt),
    index("influencers_company_active_idx")
      .on(t.companyId, t.createdAt)
      .where(sql`${t.isActive}`),
    check(
      "influencers_age_range",
      sql`${t.age} between ${sql.raw(String(INFLUENCER_LIMITS.ageMin))} and ${sql.raw(String(INFLUENCER_LIMITS.ageMax))}`,
    ),
    check(
      "influencers_progress_range",
      sql`${t.progress} between ${sql.raw(String(INFLUENCER_LIMITS.progressMin))} and ${sql.raw(String(INFLUENCER_LIMITS.progressMax))}`,
    ),
  ],
);

/**
 * DATA-014 — `InfluencerAsset`.
 * NO ESTÁ EN EL PRD: `companyId`. El PRD sólo da `influencerId`; hace falta para que
 * RLS cubra la tabla sin un JOIN contra `influencers` (IMPL §2.4).
 */
export const influencerAssets = pgTable(
  "influencer_assets",
  {
    id: uuid().primaryKey().defaultRandom(),
    influencerId: uuid()
      .notNull()
      .references(() => influencers.id, { onDelete: "cascade" }),
    companyId: companyRef(),
    kind: influencerAssetKindEnum().notNull(),
    url: text().notNull(),
    prompt: text(),
    model: text(),
    aspect: text(),
    resolution: text(),
    /** El PRD no tipa `batch` (sale de la UI del drawer). Texto hasta que lo haga. */
    batch: text(),
    creditsSpent: integer().notNull().default(0),
    durationSec: integer(),
    ...createdAtOnly(),
  },
  (t) => [
    index("influencer_assets_company_created_idx").on(t.companyId, t.createdAt),
    index("influencer_assets_influencer_created_idx").on(t.influencerId, t.createdAt),
  ],
);

/**
 * DATA-015 — `InfluencerConfig`. 1:1 con `Influencer`, por eso la PK es `influencerId`.
 * NO ESTÁ EN EL PRD: `companyId` (misma razón que en `influencer_assets`).
 */
export const influencerConfigs = pgTable(
  "influencer_configs",
  {
    influencerId: uuid()
      .primaryKey()
      .references(() => influencers.id, { onDelete: "cascade" }),
    companyId: companyRef(),
    angleIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** `[{platform, connectionId, enabled}]`. */
    publishingAccounts: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    slideshowSetIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    videoSetIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    ...timestamps(),
  },
  (t) => [index("influencer_configs_company_created_idx").on(t.companyId, t.createdAt)],
);
