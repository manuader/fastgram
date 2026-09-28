/**
 * `asset_decisions` — una fila por decisión del decisor de assets (sprint 9,
 * agente O, `PU-S9-008`, D-18). Migración `0037_asset_decisions.sql`, donde está
 * el porqué de cada columna.
 *
 * No está en el modelo de datos del PRD (§8). Complementa a `judgment_records`
 * (`DATA-033`), que tiene **una fila por llamada** al juicio: ésta tiene una por
 * **decisión**, con todos los candidatos, las respuestas por dimensión, los
 * pesos y su versión, el elegido y el motivo. Es lo que permite recalcular una
 * decisión con otros pesos sin reinferir (§9.15.3.2/3), y lo que leen las
 * preferencias (agente Q, D-22).
 *
 * Igual que `judgment_records`: **ni el estado ni las descripciones** de los
 * candidatos (texto de terceros), sólo ids, clase y fuente.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { createdAtOnly } from "./_shared.js";
import { companyRef } from "./identity.js";

/** Cómo terminó la decisión. `text` + CHECK, como el resto de las tablas de uso personal. */
export const ASSET_DECISION_MODES = [
  "judged",
  "fallback",
  "all_unsafe",
  "empty",
] as const;
export type AssetDecisionMode = (typeof ASSET_DECISION_MODES)[number];

export const assetDecisions = pgTable(
  "asset_decisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    /** Qué pidió la decisión: `blitz_refill`, `blitz_prompt_request`, … (libre, como `DATA-033`). */
    subjectType: text().notNull(),
    subjectId: text(),
    /** `meme`, `background`, `music`, … (`ASSET_ROLES` de `core`). */
    role: text().notNull(),
    /** `green-screen`, `video`, … (`DECISION_FORMATS` de `core`). */
    format: text().notNull(),
    /** La idea/tema, recortada. La escribió el dueño: no es texto de terceros. */
    idea: text(),
    /** `[{ id, kind, source, textRank, textScore }]`. */
    candidates: jsonb().notNull(),
    /** `[{ id, reason }]`: lo que el filtro en código sacó. */
    excluded: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** `{ [candidateId]: { fit: { ideaFit: ScoreAnswer, … }, nsfw: NoulAnswer } }`. */
    answers: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Puntaje por candidato y dimensión, como lo calculó `decideAsset`. */
    scored: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    weights: jsonb().notNull(),
    weightsVersion: text().notNull(),
    questionsVersion: text().notNull(),
    chosenId: text(),
    mode: text().$type<AssetDecisionMode>().notNull(),
    reason: text().notNull(),
    /** `DATA-033.adapter` del juicio (`laya`, `jev`, `llm`) o `null` sin juicio. */
    adapter: text(),
    model: text(),
    latencyMs: integer().notNull(),
    ...createdAtOnly(),
  },
  (t) => [
    index("asset_decisions_company_created_idx").on(t.companyId, t.createdAt),
    index("asset_decisions_subject_idx").on(t.companyId, t.subjectType, t.subjectId),
    check(
      "asset_decisions_mode_check",
      sql`${t.mode} IN ('judged', 'fallback', 'all_unsafe', 'empty')`,
    ),
    check("asset_decisions_latency_check", sql`${t.latencyMs} >= 0`),
  ],
);
