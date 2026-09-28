/**
 * Preferencias aprendidas desde Blitz — sprint 9 (agente Q), migración `0039`,
 * `PU-S9-011`, `D-22`.
 *
 * NO ESTÁ EN EL PRD como entidad (§8). Tres tablas:
 *
 * - `preference_signals` (**por marca, RLS**): cada decisión del dueño en
 *   Blitz —aceptar, descartar, editar— con los rasgos de la pieza. Es la
 *   fuente de verdad; todo lo demás se recalcula desde acá.
 * - `preference_weights` (**por marca, RLS**, 1:1 con la company): los pesos
 *   materializados de la marca y su configuración (on/off, exploración y vida
 *   media, `null` = hereda la del dueño).
 * - `owner_preferences` (**del dueño, sin RLS**, como `character_models`): la
 *   configuración por defecto del dueño y lo que **cada marca aporta** al
 *   nivel del dueño (`brand_stats`, companyId → estadísticas). Se escribe
 *   desde la transacción de la marca: no tiene RLS, así que no hace falta
 *   cruzar tenants para mantenerla. Ver la cabecera de la migración.
 *
 * Los rasgos y las estadísticas tienen la forma de `@fastgram/core`
 * (`preferences/`): acá son `text[]` y `jsonb`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps, tsColumn } from "./_shared.js";
import { companyRef, users } from "./identity.js";

export const PREFERENCE_SIGNAL_KIND_VALUES = [
  "accept",
  "discard",
  "edit_before_accept",
  "edit_after_accept",
] as const;
export type PreferenceSignalKindValue = (typeof PREFERENCE_SIGNAL_KIND_VALUES)[number];

/** `""` = la señal es sobre la pieza entera (aceptar/descartar). */
export const PREFERENCE_SIGNAL_ASPECT_VALUES = [
  "",
  "text",
  "background",
  "clip",
  "music",
  "style",
] as const;
export type PreferenceSignalAspectValue =
  (typeof PREFERENCE_SIGNAL_ASPECT_VALUES)[number];

export const preferenceSignals = pgTable(
  "preference_signals",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    /**
     * La sugerencia sobre la que decidió. Sin FK, como `source_influencer_id`
     * de `character_models`: es historia de aprendizaje, y borrar una
     * sugerencia vieja no tiene que borrar lo que el dueño enseñó con ella.
     */
    suggestionId: uuid().notNull(),
    /** La pieza que salió al aceptar (y la que se editó). Sin FK por lo mismo. */
    contentId: uuid(),
    kind: text().$type<PreferenceSignalKindValue>().notNull(),
    aspect: text().$type<PreferenceSignalAspectValue>().notNull().default(""),
    /** Los rasgos de la pieza al decidir. */
    features: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Edición: lo que el dueño sacó. */
    removed: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Edición: lo que el dueño puso. */
    added: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    weight: real().notNull(),
    vocabularyVersion: integer().notNull(),
    occurredAt: tsColumn().notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    /**
     * Idempotencia: una señal por (sugerencia, tipo, aspecto). Reintentar la
     * misma decisión no cuenta dos veces; editar dos veces el fondo deja la
     * **última** edición (upsert), que es lo que el dueño terminó eligiendo.
     */
    uniqueIndex("preference_signals_decision_uq").on(
      t.companyId,
      t.suggestionId,
      t.kind,
      t.aspect,
    ),
    index("preference_signals_company_occurred_idx").on(t.companyId, t.occurredAt),
    index("preference_signals_company_content_idx")
      .on(t.companyId, t.contentId)
      .where(sql`${t.contentId} is not null`),
    check(
      "preference_signals_kind_check",
      sql`${t.kind} in ('accept', 'discard', 'edit_before_accept', 'edit_after_accept')`,
    ),
    check(
      "preference_signals_aspect_check",
      sql`${t.aspect} in ('', 'text', 'background', 'clip', 'music', 'style')`,
    ),
    check(
      "preference_signals_edit_has_aspect_check",
      sql`(${t.kind} in ('accept', 'discard')) = (${t.aspect} = '')`,
    ),
    check("preference_signals_weight_check", sql`${t.weight} > 0 and ${t.weight} <= 1`),
  ],
);

/** Rangos de la configuración (los mismos que `core`). */
export const PREFERENCE_SETTINGS_LIMITS = {
  explorationMin: 0,
  explorationMax: 0.5,
  halfLifeMinDays: 1,
  halfLifeMaxDays: 365,
} as const;

export const preferenceWeights = pgTable(
  "preference_weights",
  {
    companyId: companyRef().primaryKey(),
    /** `false` = esta marca no pondera con preferencias. Las señales se siguen guardando. */
    enabled: boolean().notNull().default(true),
    /** `null` = la del dueño. */
    exploration: real(),
    halfLifeDays: real(),
    /** `PreferenceStats` de `core`, decaídas a `computedAt`. */
    stats: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    signalCount: integer().notNull().default(0),
    computedAt: tsColumn(),
    ...timestamps(),
  },
  (t) => [
    check(
      "preference_weights_exploration_check",
      sql`${t.exploration} is null or ${t.exploration} between 0 and 0.5`,
    ),
    check(
      "preference_weights_half_life_check",
      sql`${t.halfLifeDays} is null or ${t.halfLifeDays} between 1 and 365`,
    ),
  ],
);

export const ownerPreferences = pgTable(
  "owner_preferences",
  {
    ownerUserId: uuid()
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    exploration: real().notNull().default(0.15),
    halfLifeDays: real().notNull().default(30),
    /** Lo anterior no cuenta para el nivel del dueño (reset del dueño). */
    resetAt: tsColumn(),
    /** companyId → `PreferenceStats` que esa marca aporta al dueño. */
    brandStats: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps(),
  },
  (t) => [
    check("owner_preferences_exploration_check", sql`${t.exploration} between 0 and 0.5`),
    check("owner_preferences_half_life_check", sql`${t.halfLifeDays} between 1 and 365`),
  ],
);
