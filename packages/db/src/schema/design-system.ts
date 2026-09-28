/**
 * Design system de una marca — sprint 9 (agente M), migración `0035`,
 * `PU-S9-001…004`.
 *
 * NO ESTÁ EN EL PRD como tabla. Una fila por import (o derivado); **una sola
 * activa por marca** (índice único parcial). Los tokens, el resumen de estilo,
 * las fuentes subidas y los generados pendientes van en `jsonb`: la forma la
 * valida `core/design-system/document.ts` al leer (este paquete no depende de
 * `core`), así que acá se tipan `unknown`.
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps } from "./_shared.js";
import { companyRef } from "./identity.js";

export const DESIGN_SYSTEM_STATUSES = ["importing", "ready", "failed"] as const;
export type DesignSystemStatus = (typeof DESIGN_SYSTEM_STATUSES)[number];

export const DESIGN_SYSTEM_SOURCES = ["zip", "derived"] as const;
export type DesignSystemSourceColumn = (typeof DESIGN_SYSTEM_SOURCES)[number];

export const brandDesignSystems = pgTable(
  "brand_design_systems",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    status: text().$type<DesignSystemStatus>().notNull().default("importing"),
    source: text().$type<DesignSystemSourceColumn>().notNull(),
    /** La que usa Blitz. A lo sumo una por marca. */
    active: boolean().notNull().default(false),
    /** 1, 2, 3… por marca: cada import o derivado es una versión nueva. */
    version: integer().notNull(),
    name: text().notNull(),
    description: text(),
    /** `DesignSystemTokens` (paleta, familias con licencia, roles, spacing). */
    tokens: jsonb()
      .$type<unknown>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** `DesignSystemStyle` (voz, valores, tagline, reglas, do/don't). */
    style: jsonb().$type<unknown>(),
    /** Assets importados: `[{mediaId, kind, path}]` (el archivo vive en `media`). */
    assets: jsonb()
      .$type<unknown>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Archivos de fuente subidos: `[{familyId, weight, style, storageKey, url, bytes}]`. */
    fonts: jsonb()
      .$type<unknown>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Generados pendientes de aprobación (`PU-S9-004`). */
    pendingAssets: jsonb()
      .$type<unknown>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    warnings: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** La clave del zip subido (reserva de §9.8). `null` en un derivado. */
    zipKey: text(),
    zipBytes: integer(),
    failureCode: text(),
    failureMessage: text(),
    ...timestamps(),
  },
  (t) => [
    index("brand_design_systems_company_created_idx").on(t.companyId, t.createdAt),
    uniqueIndex("brand_design_systems_one_active_uq")
      .on(t.companyId)
      .where(sql`${t.active}`),
    uniqueIndex("brand_design_systems_company_version_uq").on(t.companyId, t.version),
    check(
      "brand_design_systems_status_check",
      sql`${t.status} in ('importing', 'ready', 'failed')`,
    ),
    check("brand_design_systems_source_check", sql`${t.source} in ('zip', 'derived')`),
    check("brand_design_systems_version_check", sql`${t.version} >= 1`),
    check(
      "brand_design_systems_active_ready_check",
      sql`not ${t.active} or ${t.status} = 'ready'`,
    ),
  ],
);
