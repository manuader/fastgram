/**
 * Marca — `DATA-004` CompanyProfile, `DATA-031` BrandSource,
 * `DATA-032` BrandSourceSnapshot (las dos últimas, EXTENSION · EXT-001).
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAtOnly, tsColumn, timestamps } from "./_shared.js";
import { companyRef } from "./identity.js";
import { connections } from "./publishing.js";
import {
  acquisitionTierEnum,
  brandSourceFailureReasonEnum,
  brandSourceStatusEnum,
  brandSourceTypeEnum,
  companyProfileStatusEnum,
} from "./enums.js";

/**
 * DATA-004 — `CompanyProfile` (Brand). 1:1 con company.
 *
 * `fieldMeta` es la EXTENSION que sostiene `FR-011.2` (badges de origen y confianza) y
 * `FR-011.6` (no sobrescribir ediciones manuales). Forma por campo del perfil:
 * `{confidence: high|medium|low, sourceId, excerptRef, editedByUser: bool,
 *   conflictsWith?: [sourceId]}`.
 */
export const companyProfiles = pgTable(
  "company_profiles",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    coreIdentity: text(),
    productOffering: text(),
    uniqueBenefits: text(),
    problemSolution: text(),
    marketAndCompetition: text(),
    toneOfVoice: text(),
    targetAudience: text(),

    // ── Cuestionario de onboarding (CONFIRMED) ──
    businessModel: text(),
    businessCategories: text().array().notNull().default(sql`'{}'::text[]`),
    monthlyRevenueBand: text(),
    teamSize: text(),
    ownerRole: text(),
    expectations: text().array().notNull().default(sql`'{}'::text[]`),

    /** Incrementa en cada guardado. */
    brandRevision: integer().notNull().default(0),
    status: companyProfileStatusEnum().notNull().default("pending"),
    fieldMeta: jsonb().notNull().default(sql`'{}'::jsonb`),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("company_profiles_company_uq").on(t.companyId),
    index("company_profiles_company_created_idx").on(t.companyId, t.createdAt),
  ],
);

/**
 * DATA-031 — `BrandSource` (EXTENSION).
 *
 * Dos unicidades distintas y las dos importan:
 *  - `(sourceType, handle)` **global** — misma regla que Fastlane aplica a `websiteUrl`;
 *    es lo que produce el `failureReason = already_registered`.
 *  - `isPrimary` — *"exactamente una por workspace"*.
 *
 * El cap de 5 por workspace vive en el repositorio (no hay CHECK de conteo en SQL).
 */
export const brandSources = pgTable(
  "brand_sources",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    sourceType: brandSourceTypeEnum().notNull(),
    /** Normalizado sin `@` ni dominio. */
    handle: text(),
    /** Forma canónica, sin parámetros de tracking. */
    canonicalUrl: text(),
    displayName: text(),
    avatarUrl: text(),
    isPrimary: boolean().notNull().default(false),
    acquisitionTier: acquisitionTierEnum().notNull(),
    /** Sólo cuando el tier es `A_oauth`. */
    connectionId: uuid().references(() => connections.id, { onDelete: "set null" }),
    status: brandSourceStatusEnum().notNull().default("pending"),
    failureReason: brandSourceFailureReasonEnum(),
    /** `stale` a los 90 días (`BRAND_SOURCE_LIMITS.staleAfterDays`). */
    lastAnalysedAt: tsColumn(),
    /** Para el límite de re-análisis por día. */
    analysisCount: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("brand_sources_company_created_idx").on(t.companyId, t.createdAt),
    uniqueIndex("brand_sources_type_handle_uq")
      .on(t.sourceType, t.handle)
      .where(sql`${t.handle} is not null`),
    uniqueIndex("brand_sources_primary_uq")
      .on(t.companyId)
      .where(sql`${t.isPrimary}`),
  ],
);

/**
 * DATA-032 — `BrandSourceSnapshot` (EXTENSION).
 *
 * NO ESTÁ EN EL PRD: `companyId`. El PRD sólo da `brandSourceId`; hace falta para que
 * RLS cubra la tabla sin JOIN (IMPL §2.4).
 *
 * **Retención.** `rawRetentionExpiresAt` fuerza la purga del material crudo
 * (`contentItems`, `profileSignals`). `derivedFields` sobrevive porque ya es dato del
 * cliente. El job 20 de §9.5 es el que lo ejecuta; el schema sólo guarda la fecha.
 * Los binarios de terceros **no se persisten** en ningún lado: no hay columna para
 * ellos y no debe agregarse (ver `OQ-16`).
 */
export const brandSourceSnapshots = pgTable(
  "brand_source_snapshots",
  {
    id: uuid().primaryKey().defaultRandom(),
    brandSourceId: uuid()
      .notNull()
      .references(() => brandSources.id, { onDelete: "cascade" }),
    companyId: companyRef(),
    capturedAt: tsColumn().notNull().defaultNow(),
    tier: acquisitionTierEnum().notNull(),
    /** `{nombre, bio, categoría, links, contadores}`. */
    profileSignals: jsonb(),
    /**
     * Por ítem: `{externalId, kind, caption, hashtags[], transcript?, ocrText?,
     * engagement{likes,comments,views}, postedAt}`. **Extractos citables**, no una copia
     * del perfil ajeno.
     */
    contentItems: jsonb().notNull().default(sql`'[]'::jsonb`),
    /** map campo → `{value, confidence, excerpt}`. */
    derivedFields: jsonb().notNull().default(sql`'{}'::jsonb`),
    conflicts: jsonb().notNull().default(sql`'[]'::jsonb`),
    rawRetentionExpiresAt: tsColumn(),
    ...createdAtOnly(),
  },
  (t) => [
    index("brand_source_snapshots_company_created_idx").on(t.companyId, t.createdAt),
    index("brand_source_snapshots_source_captured_idx").on(
      t.brandSourceId,
      t.capturedAt,
    ),
    /** El barrido de purga (job 20 de §9.5) escanea por esta columna. */
    index("brand_source_snapshots_raw_retention_idx")
      .on(t.rawRetentionExpiresAt)
      .where(sql`${t.rawRetentionExpiresAt} is not null`),
  ],
);
