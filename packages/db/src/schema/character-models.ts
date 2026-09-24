/**
 * Biblioteca de modelos del dueño — sprint 8 (agente K), migración `0033`.
 *
 * NO ESTÁ EN EL PRD como tabla: el PRD modela los influencers **por
 * workspace** (`DATA-013`). El dueño pidió (2026-09-24) guardar varios modelos
 * y usarlos de forma consistente en una o más marcas: eso es un nivel por
 * encima del tenant, igual que el directorio de marcas.
 *
 * Sin RLS (ver `NON_TENANT_TABLES` y la cabecera de la migración): el scope
 * es `ownerUserId` y lo sostiene `repositories/character-models.ts`.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_shared.js";
import { users } from "./identity.js";

export const CHARACTER_MODEL_STATUSES = ["training", "ready", "failed"] as const;
export type CharacterModelStatus = (typeof CHARACTER_MODEL_STATUSES)[number];

/** Cómo entró el modelo a la biblioteca. */
export const CHARACTER_MODEL_SOURCES = ["photos", "soul_id", "influencer"] as const;
export type CharacterModelSource = (typeof CHARACTER_MODEL_SOURCES)[number];

export const characterModels = pgTable(
  "character_models",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    source: text().$type<CharacterModelSource>().notNull(),
    status: text().$type<CharacterModelStatus>().notNull().default("training"),
    progress: integer().notNull().default(0),
    provider: text().notNull().default("higgsfield"),
    /** Interno: nunca sale por la API (igual que `influencers.soul_id`). */
    soulId: text(),
    /** Clave del retrato en nuestro storage (`models/{owner}/…`). */
    portraitKey: text(),
    /** La dirección del objeto (no una URL firmada, §9.10). */
    portraitUrl: text(),
    /** Las fotos de referencia copiadas a `models/{owner}/…` (claves). */
    referenceKeys: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    notes: text(),
    age: integer(),
    style: text(),
    voiceProvider: text(),
    voiceModel: text(),
    voiceId: text(),
    /** Promovido desde este influencer (otra tabla, otra marca: sin FK). */
    sourceInfluencerId: uuid(),
    sourceCompanyId: uuid(),
    failureCode: text(),
    failureMessage: text(),
    ...timestamps(),
  },
  (t) => [
    index("character_models_owner_created_idx").on(t.ownerUserId, t.createdAt),
    check(
      "character_models_source_check",
      sql`${t.source} in ('photos', 'soul_id', 'influencer')`,
    ),
    check(
      "character_models_status_check",
      sql`${t.status} in ('training', 'ready', 'failed')`,
    ),
    check("character_models_progress_check", sql`${t.progress} between 0 and 100`),
    check(
      "character_models_age_check",
      sql`${t.age} is null or ${t.age} between 18 and 60`,
    ),
    check(
      "character_models_ready_has_soul_check",
      sql`${t.status} <> 'ready' or ${t.soulId} is not null`,
    ),
  ],
);
