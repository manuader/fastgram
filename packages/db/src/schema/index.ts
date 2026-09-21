/**
 * Schema completo — `DATA-001` … `DATA-033` del PRD §8.
 *
 * Un archivo por área temática. Este índice es lo que consume `drizzle-kit` y lo que
 * se le pasa a `drizzle()` como `schema`.
 */

export * from "./enums";
export * from "./identity";
export * from "./brand";
export * from "./blitz";
export * from "./content";
export * from "./media";
export * from "./influencers";
export * from "./publishing";
export * from "./automations";
export * from "./discovery";
export * from "./platform";
export * from "./judgment";

export { tsColumn, timestamps, createdAtOnly, softDelete } from "./_shared";

import { brandSources, brandSourceSnapshots, companyProfiles } from "./brand";
import { blitzPreferences, contentAngles, suggestions } from "./blitz";
import { automationSlots, automations } from "./automations";
import { contentTextBoxes, contents } from "./content";
import { banRiskAssessments, leads } from "./discovery";
import { companies, workspaceMemberships } from "./identity";
import { influencerAssets, influencerConfigs, influencers } from "./influencers";
import { judgmentRecords } from "./judgment";
import { media, mediaSets } from "./media";
import {
  apiKeys,
  idempotencyRecords,
  quotaLedgers,
  uploadReservations,
} from "./platform";
import {
  connections,
  posts,
  replacementDecisions,
  warmedAccounts,
  warmedSlotBalances,
} from "./publishing";

/**
 * Las tablas que llevan `companyId` y **deben** estar bajo RLS.
 *
 * No es decorativo: `test/rls.int.test.ts` recorre esta lista contra `pg_policies` y
 * falla si una tabla de cliente quedó sin política. Agregar una tabla nueva sin RLS
 * rompe el test, que es exactamente la red que pide IMPL §2.4.
 */
export const COMPANY_SCOPED_TABLES = [
  workspaceMemberships,
  companyProfiles,
  brandSources,
  brandSourceSnapshots,
  contentAngles,
  blitzPreferences,
  suggestions,
  contents,
  contentTextBoxes,
  media,
  mediaSets,
  influencers,
  influencerAssets,
  influencerConfigs,
  connections,
  warmedAccounts,
  warmedSlotBalances,
  replacementDecisions,
  posts,
  automations,
  automationSlots,
  leads,
  banRiskAssessments,
  apiKeys,
  idempotencyRecords,
  uploadReservations,
  quotaLedgers,
  judgmentRecords,
] as const;

/** La raíz de la tenencia. Su política compara `id`, no `company_id`. */
export const TENANT_ROOT_TABLE = companies;

/**
 * Tablas **sin** aislamiento por compañía, con su razón. Cada una es una decisión, no
 * un olvido; el test de RLS las excluye explícitamente citando esta lista.
 */
export const NON_TENANT_TABLES: ReadonlyArray<{ table: string; reason: string }> = [
  { table: "users", reason: "DATA-001: identidad global, N workspaces por usuario" },
  { table: "audio_tracks", reason: "DATA-012: *Global, no por workspace* (literal)" },
  { table: "trending_items", reason: "DATA-023: global en el diagrama de relaciones" },
  {
    table: "onboarding_records",
    reason: "DATA-030: existe antes del workspace; scope por ownerUserId",
  },
];
