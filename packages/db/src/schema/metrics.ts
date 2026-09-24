/**
 * Auto-tune del content mix — `PU-AUTO-004`. Migración `0018_metrics_sync.sql`,
 * donde está el porqué de cada columna (y de las que se suman a `posts`).
 *
 * Ninguna de las dos tablas está en el modelo de datos del PRD (§8): nacen del
 * plan de uso personal (§2 paso 7, «las métricas vuelven y ajustan qué
 * formatos se generan después»).
 */
import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { createdAtOnly, timestamps, tsColumn } from "./_shared.js";
import { companies, companyRef } from "./identity.js";

/**
 * Una fila por marca. **Sin fila = apagado**: el auto-tune cambia pesos que el
 * usuario eligió, así que nunca se prende solo.
 *
 * `lastRunAt`/`lastOutcome` son de la última **corrida** (cambie o no): es lo
 * que deja decir en la pantalla «revisado el martes: datos insuficientes» en
 * vez de un silencio que parece un bug.
 */
export const contentMixAutotune = pgTable("content_mix_autotune", {
  companyId: uuid()
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  enabled: boolean().notNull().default(false),
  lastRunAt: tsColumn(),
  /** `changed` | un `MixTuningUnchangedReason` de `core`. Código estable. */
  lastOutcome: text(),
  ...timestamps(),
});

/** Quién hizo un cambio del mix. Hoy sólo el auto-tune escribe acá. */
export const MIX_ADJUSTMENT_ACTOR = ["autotune"] as const;
export type MixAdjustmentActor = (typeof MIX_ADJUSTMENT_ACTOR)[number];

/**
 * Un cambio aplicado a los pesos de formato (`blitz_preferences`): quién,
 * cuándo, de qué a qué, y con qué evidencia (`stats`: muestras y puntaje por
 * formato). Sólo cambios; las corridas sin cambio van a `lastOutcome`.
 */
export const formatMixAdjustments = pgTable(
  "format_mix_adjustments",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    actor: text().$type<MixAdjustmentActor>().notNull(),
    /** `{slideshow, "wall-of-text", "green-screen", "video-hook"}` → puntos. */
    fromWeights: jsonb().notNull(),
    toWeights: jsonb().notNull(),
    stats: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...createdAtOnly(),
  },
  (t) => [
    index("format_mix_adjustments_company_created_idx").on(t.companyId, t.createdAt),
    check("format_mix_adjustments_actor_check", sql`${t.actor} IN ('autotune')`),
  ],
);
