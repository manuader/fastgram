/**
 * Estrategia de publicación por marca y slots planificados — `PU-BRAND-002`,
 * `PU-CAL-001`, `PU-CAL-002` (`docs/PLAN-USO-PERSONAL.md` §2 pasos 2 y 5, §5;
 * PRD §2.7 `D-07`/`D-08`). Migración `0014_brand_strategy.sql`.
 *
 * Ninguna de las dos tablas está en el modelo de datos del PRD (§8): nacen del
 * plan de uso personal. Los nombres de campo son los del contrato
 * (`packages/contracts/src/resources/strategy.ts`).
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps, tsColumn } from "./_shared.js";
import { companies, companyRef } from "./identity.js";
import { contents } from "./content.js";
import { connections, posts } from "./publishing.js";
import { automationSlots } from "./automations.js";

/**
 * Las redes de la estrategia (`D-09`). **No** es `social_platform` ni
 * `post_platform`: esos enums no tienen `x`, `threads` ni `facebook`, y
 * ampliarlos es del sprint 3, junto con los adaptadores que los publican.
 */
export const STRATEGY_NETWORK = [
  "instagram",
  "tiktok",
  "x",
  "threads",
  "facebook",
  "youtube",
  "linkedin",
] as const;
export const strategyNetworkEnum = pgEnum("strategy_network", STRATEGY_NETWORK);

/** `D-08`: manual (Blitz) o piloto automático. El piloto se implementa en el sprint 5. */
export const BRAND_AUTONOMY = ["manual", "autopilot"] as const;
export const brandAutonomyEnum = pgEnum("brand_autonomy", BRAND_AUTONOMY);

export const PLANNED_SLOT_STATUS = ["planned", "converted"] as const;
export const plannedSlotStatusEnum = pgEnum("planned_slot_status", PLANNED_SLOT_STATUS);

/** Rangos que la base sostiene además del contrato. */
export const STRATEGY_DB_LIMITS = {
  jitterMinutesMax: 60,
  brandGapMinutesMax: 240,
} as const;

/**
 * Una fila por marca. **Sin fila = estrategia por defecto**: la marca recién
 * creada no tiene que "guardar" nada para que el auto-slot funcione, y el
 * default vive en un solo lugar (`apps/api`), no en un `DEFAULT` de columna que
 * habría que migrar para cambiarlo.
 *
 * La zona horaria **no** está acá: es `companies.timezone`, que ya existía y
 * es la de la marca. Guardarla dos veces es la receta para que diverjan.
 *
 * `networks`, `windows` y `formatMix` son `jsonb` validado por el contrato: la
 * forma es chica, se lee y se escribe entera, y nunca se consulta por dentro.
 */
export const brandStrategies = pgTable(
  "brand_strategies",
  {
    companyId: uuid()
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** `[{network, enabled, perDay, dailyCap}]`. */
    networks: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** `{sun: ["09:00", …], mon: […], …}` — horas locales de la marca. */
    windows: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** `{slideshow: 40, …}` — pesos relativos por tipo de contenido. */
    formatMix: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    language: text().notNull(),
    autonomy: brandAutonomyEnum().notNull().default("manual"),
    jitterMinutes: integer().notNull(),
    brandGapMinutes: integer().notNull(),
    ...timestamps(),
  },
  (t) => [
    check(
      "brand_strategies_jitter_range",
      sql`${t.jitterMinutes} between 0 and ${sql.raw(String(STRATEGY_DB_LIMITS.jitterMinutesMax))}`,
    ),
    check(
      "brand_strategies_gap_range",
      sql`${t.brandGapMinutes} between 0 and ${sql.raw(String(STRATEGY_DB_LIMITS.brandGapMinutesMax))}`,
    ),
  ],
);

/**
 * Un slot planificado: **contenido + red + hora, sin cuenta.**
 *
 * Existe porque un `Post` exige una cuenta (`posts_account_exclusive`) y en el
 * sprint 2 todavía no hay OAuth. El calendario los muestra igual que a un
 * post; cuando la marca tenga la conexión, el sprint 3 convierte el slot en un
 * `Post` real por el flujo de `FR-060` y deja `status = converted` con el
 * `postId`. La máquina de estados de `FR-060` no se toca: un slot no es un
 * post en ningún estado, es lo que hay **antes** de que exista uno.
 */
export const plannedSlots = pgTable(
  "planned_slots",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    /** `cascade`: un slot sin contenido no significa nada, y no bloquea el borrado. */
    contentId: uuid()
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    network: strategyNetworkEnum().notNull(),
    scheduledAtUtc: tsColumn().notNull(),
    status: plannedSlotStatusEnum().notNull().default("planned"),
    postId: uuid().references(() => posts.id, { onDelete: "set null" }),
    /**
     * `0023` — el slot de campaña que lo reservó (`FR-150`), y la conexión que
     * la campaña eligió. El barrido de publicación convierte con **esa**
     * conexión y las captions del slot; sin ellas, con la única activa de la
     * red y sin caption, como siempre.
     */
    automationSlotId: uuid().references(() => automationSlots.id, {
      onDelete: "set null",
    }),
    connectionId: uuid().references(() => connections.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    index("planned_slots_company_scheduled_idx").on(t.companyId, t.scheduledAtUtc),
    index("planned_slots_automation_slot_idx")
      .on(t.automationSlotId)
      .where(sql`${t.automationSlotId} is not null`),
    index("planned_slots_company_created_idx").on(t.companyId, t.createdAt),
    /** Una pieza no se planifica dos veces en la misma red. */
    uniqueIndex("planned_slots_content_network_planned_uq")
      .on(t.contentId, t.network)
      .where(sql`${t.status} = 'planned'`),
  ],
);
