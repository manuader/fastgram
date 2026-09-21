/**
 * `DATA-033` — `JudgmentRecord` (EXTENSION · EXT-008 · PRD §9.15).
 *
 * Se persiste por tres razones que el PRD nombra: recalcular umbrales sin volver a
 * inferir, comparar adaptadores sobre exactamente el mismo estado, y tener
 * `latencyMs`/`inputTokens` reales para decidir con hechos.
 *
 * **El estado crudo no se guarda**: sólo `stateHash`. Esa es la línea de retención y no
 * debe cruzarse agregando una columna con el prompt o el estado completo.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { createdAtOnly } from "./_shared.js";
import { companyRef } from "./identity.js";
import { decisionPointEnum, judgmentAdapterEnum } from "./enums.js";

export const judgmentRecords = pgTable(
  "judgment_records",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    decisionPoint: decisionPointEnum().notNull(),
    /**
     * A qué se le aplicó. El PRD describe los sujetos en prosa (*"trending item, lead,
     * post, campo de perfil"*) pero **no fija literales**, así que es `text` y no un
     * enum inventado. PENDIENTE: fijar la taxonomía junto con los `DP-00x`.
     */
    subjectType: text().notNull(),
    subjectId: text(),
    adapter: judgmentAdapterEnum().notNull(),
    model: text(),
    /** map `questionId → {type, value, probabilities, confidence}`. Permanente. */
    answers: jsonb().notNull(),
    /** Único rastro del estado de entrada. Sirve para detectar si cambió. */
    stateHash: text().notNull(),
    inputTokens: integer(),
    latencyMs: integer(),
    ...createdAtOnly(),
  },
  (t) => [
    index("judgment_records_company_created_idx").on(t.companyId, t.createdAt),
    /**
     * §25.3 compara adaptadores sobre el mismo estado: la consulta es
     * `(decisionPoint, stateHash)`. Sin este índice, ese experimento es un seq scan
     * sobre la tabla más grande del sistema.
     */
    index("judgment_records_decision_state_idx").on(t.decisionPoint, t.stateHash),
    index("judgment_records_subject_idx").on(t.companyId, t.subjectType, t.subjectId),
    check(
      "judgment_records_metrics_non_negative",
      sql`(${t.inputTokens} is null or ${t.inputTokens} >= 0)
          and (${t.latencyMs} is null or ${t.latencyMs} >= 0)`,
    ),
  ],
);
