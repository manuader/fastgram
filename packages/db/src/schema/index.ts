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
// Sprint 8 (K): biblioteca de modelos del dueño (migración 0033).
export * from "./character-models.js";
// Sprint 9 (Q): preferencias aprendidas desde Blitz (migración 0039).
export * from "./preferences.js";
// Sprint 9 (N): biblioteca global de assets (migración 0036).
export * from "./library.js";

// Sprint 9 (R): anuncios pagos con Meta (migración 0040).
export * from "./ads.js";
// Sprint 9 (O): decisiones del decisor de assets (migración 0037).
export * from "./asset-decisions.js";
// Sprint 9 (M): design system por marca (migración 0035).
export * from "./design-system.js";
// Sprint 9 (U): planificador semanal de reels (migración 0041).
export * from "./reels.js";

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
import {
  adAccounts,
  adActions,
  adCampaigns,
  adExperiments,
  adInsightsDaily,
  ads,
  adSets,
} from "./ads.js";
import { preferenceSignals, preferenceWeights } from "./preferences.js";
import { assetDecisions } from "./asset-decisions.js";
import { brandDesignSystems } from "./design-system.js";
import { reelPlanItems, reelPlans } from "./reels.js";
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
  // Sprint 9 (Q): 0039.
  preferenceSignals,
  preferenceWeights,
  // Sprint 9 (R): 0040.
  adAccounts,
  adCampaigns,
  adSets,
  ads,
  adExperiments,
  adInsightsDaily,
  adActions,
  // Sprint 9 (O): 0037.
  assetDecisions,
  // Sprint 9 (M): 0035.
  brandDesignSystems,
  // Sprint 9 (U): 0041.
  reelPlans,
  reelPlanItems,
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
  {
    table: "character_models",
    reason:
      "Sprint 8 (0033): biblioteca de modelos del dueño, por encima de las marcas; scope por ownerUserId en el repositorio",
  },
  {
    table: "owner_preferences",
    reason:
      "Sprint 9 (0039): configuración y nivel del dueño de las preferencias; scope por ownerUserId en el repositorio",
  },
  {
    table: "library_assets",
    reason:
      "Sprint 9 (0036, D-19): biblioteca global de la instalación, como audio_tracks; imported_by_company_id es auditoría, no scope",
  },
];
