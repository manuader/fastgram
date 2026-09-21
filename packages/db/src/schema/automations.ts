/**
 * Automations — `DATA-021` Automation, `DATA-022` AutomationSlot.
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
  varchar,
} from "drizzle-orm/pg-core";

import { createdAtOnly, tsColumn, timestamps } from "./_shared.js";
import { companyRef } from "./identity.js";
import { contents } from "./content.js";
import {
  automationSlotFailureReasonEnum,
  automationSlotStatusEnum,
  automationStatusEnum,
  contentTypeEnum,
  postingModeEnum,
} from "./enums.js";
import { AUTOMATION_LIMITS } from "../limits.js";

/** DATA-021 — `Automation`. */
export const automations = pgTable(
  "automations",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    name: varchar({ length: AUTOMATION_LIMITS.nameMaxChars }).notNull(),
    status: automationStatusEnum().notNull().default("DRAFT"),
    /** Cuentas destino; forma `[{platform, connectionId|warmedAccountId, …}]`. */
    accounts: jsonb().notNull().default(sql`'[]'::jsonb`),
    perAccountPerDay: integer().notNull(),
    durationWeeks: integer().notNull(),
    startDateUtc: tsColumn().notNull(),
    timezone: text().notNull(),
    postingMode: postingModeEnum(),
    /**
     * El PRD no enumera los valores de `youtubePrivacyStatus` (no son los de
     * `privacy_level` de TikTok). Texto hasta que lo haga.
     */
    youtubePrivacyStatus: text(),
    discloseAsAds: boolean().notNull().default(false),
    aiContentDisclaimer: boolean().notNull().default(false),
    /** Snapshot de `BlitzPreferences` al lanzar. */
    prefsSnapshot: jsonb(),
    generationQuotaUsed: integer().notNull().default(0),
    launchValidation: jsonb(),
    ...createdAtOnly(),
  },
  (t) => [
    index("automations_company_created_idx").on(t.companyId, t.createdAt),
    check(
      "automations_per_account_per_day_range",
      sql`${t.perAccountPerDay} between ${sql.raw(String(AUTOMATION_LIMITS.perAccountPerDayMin))} and ${sql.raw(String(AUTOMATION_LIMITS.perAccountPerDayMax))}`,
    ),
    check(
      "automations_duration_weeks_range",
      sql`${t.durationWeeks} between ${sql.raw(String(AUTOMATION_LIMITS.durationWeeksMin))} and ${sql.raw(String(AUTOMATION_LIMITS.durationWeeksMax))}`,
    ),
  ],
);

/**
 * DATA-022 — `AutomationSlot`.
 * NO ESTÁ EN EL PRD: `companyId`. El PRD sólo da `automationId`; hace falta para RLS
 * sin JOIN (IMPL §2.4) y para el índice `(companyId, createdAt)`.
 *
 * `postIds[]` queda como array sin FK, tal como lo modela el PRD: los posts se crean
 * después y el slot no debe bloquear su borrado.
 */
export const automationSlots = pgTable(
  "automation_slots",
  {
    id: uuid().primaryKey().defaultRandom(),
    automationId: uuid()
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    companyId: companyRef(),
    status: automationSlotStatusEnum().notNull().default("PENDING_GEN"),
    contentType: contentTypeEnum().notNull(),
    /** *"forma variable por tipo"* — por eso JSONB y no columnas. */
    suggestionData: jsonb(),
    generatedText: text(),
    /** map plataforma → caption. */
    captionsByPlatform: jsonb().notNull().default(sql`'{}'::jsonb`),
    scheduledAtUtc: tsColumn(),
    failureReason: automationSlotFailureReasonEnum(),
    contentId: uuid().references(() => contents.id, { onDelete: "set null" }),
    postIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    ...timestamps(),
  },
  (t) => [
    index("automation_slots_company_created_idx").on(t.companyId, t.createdAt),
    index("automation_slots_automation_created_idx").on(t.automationId, t.createdAt),
  ],
);
