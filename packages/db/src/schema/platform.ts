/**
 * Plataforma — `DATA-026` ApiKey, `DATA-027` IdempotencyRecord,
 * `DATA-028` UploadReservation, `DATA-029` QuotaLedger, `DATA-030` OnboardingRecord.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAtOnly, tsColumn, timestamps } from "./_shared.js";
import { companies, companyRef, users } from "./identity.js";
import {
  apiKeyKindEnum,
  idempotencyStateEnum,
  uploadReservationStateEnum,
} from "./enums.js";

/**
 * DATA-026 — `ApiKey`.
 * `hash` guarda el hash; el secreto en claro **nunca** toca la base (PRD §9.1: la key
 * se muestra una sola vez). `prefix` es `fsln_live_`.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    label: text().notNull(),
    /** Hash, NUNCA el secreto en claro. */
    hash: text().notNull(),
    prefix: text().notNull().default("fsln_live_"),
    kind: apiKeyKindEnum().notNull().default("workspace"),
    revokedAt: tsColumn(),
    expiresAt: tsColumn(),
    ...createdAtOnly(),
  },
  (t) => [
    index("api_keys_company_created_idx").on(t.companyId, t.createdAt),
    index("api_keys_hash_idx").on(t.hash),
  ],
);

/**
 * DATA-027 — `IdempotencyRecord`.
 *
 * La PK es `(companyId, key)`: la key la elige el cliente y sólo tiene sentido dentro
 * de su workspace. Que sea la PK es lo que hace que la reserva sea atómica — dos
 * peticiones con la misma key compiten por la misma fila y una pierde.
 *
 * Semántica de §9.3: misma key + mismo `requestHash` ⇒ replay de `responseSnapshot`;
 * misma key + hash distinto ⇒ `409 conflict`; petición fallida ⇒ `released`.
 */
export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    key: text().notNull(),
    companyId: companyRef(),
    endpoint: text().notNull(),
    requestHash: text().notNull(),
    responseSnapshot: jsonb(),
    state: idempotencyStateEnum().notNull().default("in_flight"),
    ...createdAtOnly(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.key] }),
    index("idempotency_records_company_created_idx").on(t.companyId, t.createdAt),
  ],
);

/** DATA-028 — `UploadReservation`. PK `uploadId` (nombre literal del PRD/API). */
export const uploadReservations = pgTable(
  "upload_reservations",
  {
    uploadId: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    apiKeyId: uuid().references(() => apiKeys.id, { onDelete: "set null" }),
    filename: text().notNull(),
    contentType: text().notNull(),
    sizeBytes: bigint({ mode: "number" }).notNull(),
    durationSec: integer(),
    storageKey: text().notNull(),
    expiresAt: tsColumn().notNull(),
    state: uploadReservationStateEnum().notNull().default("reserved"),
    ...createdAtOnly(),
  },
  (t) => [
    index("upload_reservations_company_created_idx").on(t.companyId, t.createdAt),
    index("upload_reservations_expires_idx").on(t.expiresAt),
    check("upload_reservations_size_positive", sql`${t.sizeBytes} > 0`),
  ],
);

/**
 * DATA-029 — `QuotaLedger`. *"1 por periodo"* (diagrama de relaciones), por eso la PK
 * es `(companyId, period)`.
 *
 * `period` es `text` con formato `YYYY-MM-DD`: el **día de inicio del ciclo de
 * facturación** (UTC), no el mes calendario, porque el reset de saves es en el día
 * ancla (§16.2). Lo calcula `billingPeriodKey` (`packages/core/src/quota/reset.ts`);
 * ése es el único sitio que decide la clave, y este schema no la valida.
 */
export const quotaLedgers = pgTable(
  "quota_ledgers",
  {
    companyId: companyRef(),
    period: text().notNull(),
    contentSavesIncluded: integer().notNull().default(0),
    contentSavesUsed: integer().notNull().default(0),
    contentSavesPurchased: integer().notNull().default(0),
    overageUnits: integer().notNull().default(0),
    dailySwipesUsed: integer().notNull().default(0),
    /** Reset diario a 00:00 UTC (§16.2). */
    dailySwipeResetAt: tsColumn(),
    aiCredits: integer().notNull().default(0),
    warmedPostSlots: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.period] }),
    index("quota_ledgers_company_created_idx").on(t.companyId, t.createdAt),
    check(
      "quota_ledgers_counters_non_negative",
      sql`${t.contentSavesIncluded} >= 0 and ${t.contentSavesUsed} >= 0
          and ${t.contentSavesPurchased} >= 0 and ${t.overageUnits} >= 0
          and ${t.dailySwipesUsed} >= 0 and ${t.aiCredits} >= 0
          and ${t.warmedPostSlots} >= 0`,
    ),
  ],
);

/**
 * DATA-030 — `OnboardingRecord`.
 *
 * **No lleva `companyId` ni política RLS por compañía**, y es deliberado: existe
 * *antes* de que haya un workspace (su campo es `draftCompanyId`, que puede ser null).
 * El aislamiento lo sostiene el repositorio, que exige `ownerUserId` en la firma.
 * Es el único hueco de RLS del modelo y está anotado como tal en
 * `drizzle/0002_tenancy_rls.sql`.
 */
export const onboardingRecords = pgTable(
  "onboarding_records",
  {
    id: uuid().primaryKey().defaultRandom(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    draftCompanyId: uuid().references(() => companies.id, { onDelete: "set null" }),
    step: text().notNull(),
    payload: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...createdAtOnly(),
  },
  (t) => [index("onboarding_records_owner_created_idx").on(t.ownerUserId, t.createdAt)],
);
