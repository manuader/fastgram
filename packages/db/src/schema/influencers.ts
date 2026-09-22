/**
 * Influencers — `DATA-013` Influencer, `DATA-014` InfluencerAsset,
 * `DATA-015` InfluencerConfig.
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
  uuid,
} from "drizzle-orm/pg-core";

import { createdAtOnly, timestamps, tsColumn } from "./_shared.js";
import { companyRef } from "./identity.js";
import { influencerAssetKindEnum, influencerStatusEnum } from "./enums.js";
import { INFLUENCER_LIMITS } from "../limits.js";

/** DATA-013 — `Influencer`. Cap: 50 activos por workspace (se aplica en el repo). */
export const influencers = pgTable(
  "influencers",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    name: text().notNull(),
    /**
     * El PRD no enumera los valores de `gender` en DATA-013 (la UI lo muestra como un
     * `select` con placeholder `Select…` pero no lista las opciones). Texto libre, no un
     * enum inventado. PENDIENTE: fijar la taxonomía cuando el PRD la dé.
     */
    gender: text().notNull(),
    age: integer().notNull(),
    ethnicity: text().notNull(),
    baseImageUrl: text(),
    status: influencerStatusEnum().notNull().default("generating_variations"),
    progress: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),

    // ── Campos internos: el PRD dice "nunca expuestos". Viven acá, no salen por API. ──
    soulId: text(),
    baseCharacterCmlId: text(),
    /**
     * NO ESTÁ EN EL PRD (como columna con nombre): DATA-013 menciona *"ids de media y de
     * job"* entre los campos internos pero **no los nombra**. Inventar nombres sería
     * peor que agruparlos; cuando el PRD los nombre, se desnormalizan.
     *
     * **El cargo de créditos ya NO vive acá** (`P1-DATA-016`). Vivía —como
     * `internal_refs.aiStudioCharge`— y el riesgo estaba medido: `update(…, {
     * internalRefs })` **reemplaza el jsonb entero**, así que el primer handler que
     * escribiera `soulId` borraba el registro del cargo y nada fallaba. Ver
     * `creditsPeriod` abajo.
     */
    internalRefs: jsonb(),

    // ── El cargo de 250 créditos de AI Studio — `P1-DATA-016`, `FR-080`, §9.4 ──
    //
    // Mismas tres preguntas —y misma forma— que `contents.save_bucket` /
    // `save_period` / `save_refunded_at` resuelven para el content save. Lo que
    // no tiene respuesta no se puede reembolsar, y un cargo que no se reembolsa
    // no vuelve nunca.
    /**
     * A qué período de facturación se cobró — `quota_ledgers.period`.
     *
     * Se persiste en vez de derivarlo de `createdAt` porque derivarlo depende de
     * `billingAnchorDay`, que puede cambiar entre el cobro y el reembolso: ahí los
     * 250 créditos volverían a **otro ledger**, en silencio.
     */
    creditsPeriod: text(),
    /**
     * Cuántos créditos se reservaron. Es lo que hay que devolver, ni más ni menos.
     *
     * Se guarda el número y no la operación porque `AI_STUDIO_COST.influencer` es
     * un número del PRD y puede moverse: un reembolso que lo volviera a leer de la
     * tabla de tarifas devolvería la tarifa de hoy por un cargo de ayer. Con el
     * monto acá, el reembolso no necesita saber qué operación fue —y por eso
     * tampoco hay columna `operation`: en esta tabla siempre es `influencer`.
     */
    creditsCharged: integer(),
    /**
     * Guarda contra el doble reembolso. El handler de `influencer-pipeline` puede
     * reintentarse (lo dice el puerto `Queue`), y dos reembolsos sobre un solo
     * cargo regalan 250 créditos sin que nada falle.
     *
     * No alcanza con leerla: la guarda es el `WHERE … credits_refunded_at is null`
     * de `claimCreditsRefund`, que es una sola sentencia y no depende de que el
     * llamador se acuerde de comprobarla.
     */
    creditsRefundedAt: tsColumn(),

    ...timestamps(),
  },
  (t) => [
    index("influencers_company_created_idx").on(t.companyId, t.createdAt),
    index("influencers_company_active_idx")
      .on(t.companyId, t.createdAt)
      .where(sql`${t.isActive}`),
    check(
      "influencers_age_range",
      sql`${t.age} between ${sql.raw(String(INFLUENCER_LIMITS.ageMin))} and ${sql.raw(String(INFLUENCER_LIMITS.ageMax))}`,
    ),
    check(
      "influencers_progress_range",
      sql`${t.progress} between ${sql.raw(String(INFLUENCER_LIMITS.progressMin))} and ${sql.raw(String(INFLUENCER_LIMITS.progressMax))}`,
    ),
    /**
     * Un cargo tiene período y monto, o no tiene ninguno de los dos. Saber cuánto
     * se cobró sin saber a qué ledger devolverlo no alcanza para reembolsar, y al
     * revés tampoco.
     */
    check(
      "influencers_credits_period_with_charged",
      sql`(${t.creditsPeriod} is null) = (${t.creditsCharged} is null)`,
    ),
    /** No se puede reembolsar lo que no se cobró. */
    check(
      "influencers_refund_requires_charge",
      sql`${t.creditsRefundedAt} is null or ${t.creditsCharged} is not null`,
    ),
    /**
     * Un cargo de 0 no es un cargo, y uno negativo le **quita** créditos al cliente
     * cuando se "devuelve". Los dos son bugs que sin esto llegan al ledger.
     */
    check(
      "influencers_credits_charged_positive",
      sql`${t.creditsCharged} is null or ${t.creditsCharged} > 0`,
    ),
  ],
);

/**
 * DATA-014 — `InfluencerAsset`.
 * NO ESTÁ EN EL PRD: `companyId`. El PRD sólo da `influencerId`; hace falta para que
 * RLS cubra la tabla sin un JOIN contra `influencers` (IMPL §2.4).
 */
export const influencerAssets = pgTable(
  "influencer_assets",
  {
    id: uuid().primaryKey().defaultRandom(),
    influencerId: uuid()
      .notNull()
      .references(() => influencers.id, { onDelete: "cascade" }),
    companyId: companyRef(),
    kind: influencerAssetKindEnum().notNull(),
    url: text().notNull(),
    prompt: text(),
    model: text(),
    aspect: text(),
    resolution: text(),
    /** El PRD no tipa `batch` (sale de la UI del drawer). Texto hasta que lo haga. */
    batch: text(),
    creditsSpent: integer().notNull().default(0),
    durationSec: integer(),
    ...createdAtOnly(),
  },
  (t) => [
    index("influencer_assets_company_created_idx").on(t.companyId, t.createdAt),
    index("influencer_assets_influencer_created_idx").on(t.influencerId, t.createdAt),
  ],
);

/**
 * DATA-015 — `InfluencerConfig`. 1:1 con `Influencer`, por eso la PK es `influencerId`.
 * NO ESTÁ EN EL PRD: `companyId` (misma razón que en `influencer_assets`).
 */
export const influencerConfigs = pgTable(
  "influencer_configs",
  {
    influencerId: uuid()
      .primaryKey()
      .references(() => influencers.id, { onDelete: "cascade" }),
    companyId: companyRef(),
    angleIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** `[{platform, connectionId, enabled}]`. */
    publishingAccounts: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    slideshowSetIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    videoSetIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    ...timestamps(),
  },
  (t) => [index("influencer_configs_company_created_idx").on(t.companyId, t.createdAt)],
);
