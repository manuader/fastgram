/**
 * Schema completo — `DATA-001` … `DATA-033` del PRD §8.
 *
 * Un archivo por área temática. Este índice es lo que consume `drizzle-kit` y lo que
 * se le pasa a `drizzle()` como `schema`.
 */

export * from "./enums.js";
export * from "./identity.js";
export * from "./brand.js";
export * from "./blitz.js";
export * from "./content.js";
export * from "./media.js";
export * from "./influencers.js";
export * from "./publishing.js";
export * from "./automations.js";
export * from "./discovery.js";
export * from "./platform.js";
export * from "./judgment.js";
export * from "./strategy.js";
export * from "./autopilot.js";
export * from "./metrics.js";
export * from "./engagement.js";
export * from "./notifications.js";

export { tsColumn, timestamps, createdAtOnly, softDelete } from "./_shared.js";

import { brandSources, brandSourceSnapshots, companyProfiles } from "./brand.js";
import {
  blitzPreferences,
  blitzPromptRequests,
  contentAngles,
  suggestions,
} from "./blitz.js";
import { automationSlots, automations } from "./automations.js";
import { contentTextBoxes, contents } from "./content.js";
import { banRiskAssessments, leads } from "./discovery.js";
import { companies, workspaceMemberships } from "./identity.js";
import {
  influencerAssets,
  influencerConfigs,
  influencerGenerations,
  influencers,
} from "./influencers.js";
import { judgmentRecords } from "./judgment.js";
import { brandStrategies, plannedSlots } from "./strategy.js";
import { autopilotDecisions, autopilotRuns } from "./autopilot.js";
import { contentMixAutotune, formatMixAdjustments } from "./metrics.js";
import { engagementReplies, engagementSettings, redditAccounts } from "./engagement.js";
import { notifications } from "./notifications.js";
import { brandAudioTracks, media, mediaSets, ownPostImports } from "./media.js";
import {
  apiKeys,
  idempotencyRecords,
  quotaLedgers,
  uploadReservations,
} from "./platform.js";
import {
  connections,
  posts,
  replacementDecisions,
  warmedAccounts,
  warmedSlotBalances,
} from "./publishing.js";

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
  blitzPromptRequests,
  contents,
  contentTextBoxes,
  media,
  mediaSets,
  influencers,
  influencerAssets,
  influencerConfigs,
  influencerGenerations,
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
  brandStrategies,
  plannedSlots,
  autopilotDecisions,
  autopilotRuns,
  contentMixAutotune,
  formatMixAdjustments,
  engagementSettings,
  redditAccounts,
  engagementReplies,
  notifications,
  brandAudioTracks,
  ownPostImports,
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
  {
    table: "trending_items",
    reason:
      "DATA-023: catálogo global; las referencias del dueño (0022) llevan company_id y política propia",
  },
  {
    table: "onboarding_records",
    reason: "DATA-030: existe antes del workspace; scope por ownerUserId",
  },
];
