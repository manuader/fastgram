/**
 * El planificador semanal de reels — sprint 9 (U), `PU-S9-014`, migración
 * `0041_reel_planner.sql` (ahí está el porqué de cada columna).
 *
 * No están en el modelo de datos del PRD (§8): nacen del plan de uso personal
 * y de `D-20`. Una fila de `reel_plans` por marca y **semana ISO local**
 * (`UNIQUE (company_id, week_start)`: la idempotencia del plan), y una de
 * `reel_plan_items` por reel planificado, con su estado.
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

import { timestamps } from "./_shared.js";
import { companyRef } from "./identity.js";
import { contentAngles, suggestions } from "./blitz.js";
import { contents } from "./content.js";

/** Estados de un ítem. `text` + CHECK, como el resto de las tablas de uso personal. */
export const REEL_PLAN_ITEM_STATUS = [
  "planned",
  "suggested",
  "accepted",
  "discarded",
  "built",
  "failed",
] as const;
export type ReelPlanItemStatusDb = (typeof REEL_PLAN_ITEM_STATUS)[number];

export const reelPlans = pgTable(
  "reel_plans",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    /** El lunes de la semana, en la zona de la marca (`YYYY-MM-DD`). */
    weekStart: text().notNull(),
    /** La zona con la que se calcularon los días (la de la marca al planificar). */
    timezone: text().notNull(),
    /** Reels que pedía la estrategia al planificar. */
    quota: integer().notNull(),
    /** `[{ code, detail? }]` — `REEL_PLAN_NOTE_CODES` del contrato. */
    notes: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("reel_plans_company_week_uq").on(t.companyId, t.weekStart),
    check("reel_plans_week_format", sql`${t.weekStart} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    check("reel_plans_quota_range", sql`${t.quota} between 0 and 14`),
  ],
);

export const reelPlanItems = pgTable(
  "reel_plan_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    planId: uuid()
      .notNull()
      .references(() => reelPlans.id, { onDelete: "cascade" }),
    /** Orden dentro del plan: estable entre re-planificaciones. */
    ord: integer().notNull(),
    /** Día local en que entra a la cola (`YYYY-MM-DD`). */
    day: text().notNull(),
    status: text().$type<ReelPlanItemStatusDb>().notNull().default("planned"),
    template: text().notNull(),
    angleId: uuid().references(() => contentAngles.id, { onDelete: "set null" }),
    /** El título del ángulo al planificar (el ángulo se puede borrar o renombrar). */
    angleTitle: text(),
    idea: text(),
    hook: text(),
    /** `ReelCopy` (`hook`, `beats`, `punchline`) y de dónde salió (`model` | `angle`). */
    copy: jsonb(),
    /** `ReelMotion` elegido por el planificador (preferencias + exploración). */
    motion: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Lo elegido por rol: `{ backgrounds, clip, music, logo, motif, picks[] }`. */
    assets: jsonb(),
    /** El `ReelSpec` armado (se valida con el contrato al leer). */
    spec: jsonb(),
    durationSec: real(),
    /** Clave de storage del póster (un cuadro compuesto por el motor de reels). */
    posterKey: text(),
    explored: boolean().notNull().default(false),
    suggestionId: uuid().references(() => suggestions.id, { onDelete: "set null" }),
    contentId: uuid().references(() => contents.id, { onDelete: "set null" }),
    failureReason: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("reel_plan_items_plan_ord_uq").on(t.planId, t.ord),
    index("reel_plan_items_company_day_idx").on(t.companyId, t.day),
    index("reel_plan_items_suggestion_idx")
      .on(t.suggestionId)
      .where(sql`${t.suggestionId} is not null`),
    index("reel_plan_items_content_idx")
      .on(t.contentId)
      .where(sql`${t.contentId} is not null`),
    check(
      "reel_plan_items_status",
      sql`${t.status} in ('planned', 'suggested', 'accepted', 'discarded', 'built', 'failed')`,
    ),
    check(
      "reel_plan_items_template",
      sql`${t.template} in ('hook-reaction-punchline', 'list-beats', 'before-after')`,
    ),
    check("reel_plan_items_day_format", sql`${t.day} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
  ],
);
