/**
 * Piloto automático — `PU-AUTO-002`, `PU-AUTO-003` (`docs/PLAN-USO-PERSONAL.md`
 * §2, PRD §2.7 `D-08`). Migración `0017_autopilot.sql`, donde está el porqué
 * de cada restricción.
 *
 * Ninguna de las dos tablas está en el modelo de datos del PRD (§8).
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAtOnly, timestamps, tsColumn } from "./_shared.js";
import { suggestions } from "./blitz.js";
import { contents } from "./content.js";
import { companies, companyRef } from "./identity.js";

/** Qué hizo el piloto con una sugerencia. `text` + CHECK, no enum: ver la migración. */
export const AUTOPILOT_DECISION = ["approved", "rejected", "held"] as const;
export type AutopilotDecisionKind = (typeof AUTOPILOT_DECISION)[number];

/**
 * Una fila por sugerencia juzgada. `details` guarda las respuestas crudas del
 * juicio, la versión de las preguntas/umbrales, un extracto de la copy y, si
 * se aprobó, dónde se agendó.
 */
export const autopilotDecisions = pgTable(
  "autopilot_decisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    suggestionId: uuid()
      .notNull()
      .references(() => suggestions.id, { onDelete: "cascade" }),
    decision: text().$type<AutopilotDecisionKind>().notNull(),
    /** Código estable: el primer motivo de rechazo, o el de `held`. `null` si se aprobó. */
    reason: text(),
    contentId: uuid().references(() => contents.id, { onDelete: "set null" }),
    details: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...createdAtOnly(),
  },
  (t) => [
    uniqueIndex("autopilot_decisions_suggestion_uq").on(t.suggestionId),
    index("autopilot_decisions_company_created_idx").on(t.companyId, t.createdAt),
    check(
      "autopilot_decisions_decision_check",
      sql`${t.decision} IN ('approved', 'rejected', 'held')`,
    ),
  ],
);

/** La última corrida del piloto por marca. */
export const autopilotRuns = pgTable(
  "autopilot_runs",
  {
    companyId: uuid()
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    lastRunAt: tsColumn().notNull(),
    /** Ver `AUTOPILOT_RUN_OUTCOMES` en el repositorio. */
    outcome: text().notNull(),
    queueTarget: integer().notNull(),
    queued: integer().notNull(),
    approved: integer().notNull(),
    rejected: integer().notNull(),
    held: integer().notNull(),
    ...timestamps(),
  },
  (t) => [
    check(
      "autopilot_runs_counts_check",
      sql`${t.queueTarget} >= 0 AND ${t.queued} >= 0 AND ${t.approved} >= 0 AND ${t.rejected} >= 0 AND ${t.held} >= 0`,
    ),
  ],
);
