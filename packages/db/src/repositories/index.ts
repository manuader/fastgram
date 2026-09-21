/**
 * Repositorios concretos.
 *
 * Todos se construyen con `createCompanyScopedRepository`, así que todos heredan la
 * misma propiedad: **ninguna firma acepta un id sin `TenantScope`**. Los que necesitan
 * más que CRUD (idempotencia, cuotas) agregan métodos, nunca quitan el scope.
 */

export * from "./base.js";
export * from "./idempotency.js";

import {
  apiKeys,
  automationSlots,
  automations,
  banRiskAssessments,
  blitzPreferences,
  brandSourceSnapshots,
  brandSources,
  companyProfiles,
  connections,
  contentAngles,
  contentTextBoxes,
  contents,
  influencerAssets,
  influencerConfigs,
  influencers,
  judgmentRecords,
  leads,
  media,
  mediaSets,
  posts,
  quotaLedgers,
  replacementDecisions,
  suggestions,
  uploadReservations,
  warmedAccounts,
  warmedSlotBalances,
  workspaceMemberships,
} from "../schema/index.js";
import { createCompanyScopedRepository } from "./base.js";

export const workspaceMembershipRepository = createCompanyScopedRepository({
  table: workspaceMemberships,
  id: workspaceMemberships.id,
  companyId: workspaceMemberships.companyId,
  createdAt: workspaceMemberships.createdAt,
});

export const companyProfileRepository = createCompanyScopedRepository({
  table: companyProfiles,
  id: companyProfiles.id,
  companyId: companyProfiles.companyId,
  createdAt: companyProfiles.createdAt,
});

export const brandSourceRepository = createCompanyScopedRepository({
  table: brandSources,
  id: brandSources.id,
  companyId: brandSources.companyId,
  createdAt: brandSources.createdAt,
});

export const brandSourceSnapshotRepository = createCompanyScopedRepository({
  table: brandSourceSnapshots,
  id: brandSourceSnapshots.id,
  companyId: brandSourceSnapshots.companyId,
  createdAt: brandSourceSnapshots.createdAt,
});

export const contentAngleRepository = createCompanyScopedRepository({
  table: contentAngles,
  id: contentAngles.id,
  companyId: contentAngles.companyId,
  createdAt: contentAngles.createdAt,
});

export const blitzPreferencesRepository = createCompanyScopedRepository({
  table: blitzPreferences,
  // 1:1 con company: la PK *es* el companyId.
  id: blitzPreferences.companyId,
  companyId: blitzPreferences.companyId,
  createdAt: blitzPreferences.createdAt,
});

export const suggestionRepository = createCompanyScopedRepository({
  table: suggestions,
  id: suggestions.id,
  companyId: suggestions.companyId,
  createdAt: suggestions.createdAt,
});

/** `Content` tiene soft-delete: PRD §9.4 y DATA-008 (`deletedAt`). */
export const contentRepository = createCompanyScopedRepository({
  table: contents,
  id: contents.id,
  companyId: contents.companyId,
  createdAt: contents.createdAt,
  deletedAt: contents.deletedAt,
});

export const contentTextBoxRepository = createCompanyScopedRepository({
  table: contentTextBoxes,
  id: contentTextBoxes.id,
  companyId: contentTextBoxes.companyId,
  createdAt: contentTextBoxes.createdAt,
});

/** `Media` tiene soft-delete (DATA-010). */
export const mediaRepository = createCompanyScopedRepository({
  table: media,
  id: media.mediaId,
  companyId: media.companyId,
  createdAt: media.createdAt,
  deletedAt: media.deletedAt,
});

export const mediaSetRepository = createCompanyScopedRepository({
  table: mediaSets,
  id: mediaSets.id,
  companyId: mediaSets.companyId,
  createdAt: mediaSets.createdAt,
});

export const influencerRepository = createCompanyScopedRepository({
  table: influencers,
  id: influencers.id,
  companyId: influencers.companyId,
  createdAt: influencers.createdAt,
});

export const influencerAssetRepository = createCompanyScopedRepository({
  table: influencerAssets,
  id: influencerAssets.id,
  companyId: influencerAssets.companyId,
  createdAt: influencerAssets.createdAt,
});

export const influencerConfigRepository = createCompanyScopedRepository({
  table: influencerConfigs,
  id: influencerConfigs.influencerId,
  companyId: influencerConfigs.companyId,
  createdAt: influencerConfigs.createdAt,
});

export const connectionRepository = createCompanyScopedRepository({
  table: connections,
  id: connections.id,
  companyId: connections.companyId,
  createdAt: connections.createdAt,
});

export const warmedAccountRepository = createCompanyScopedRepository({
  table: warmedAccounts,
  id: warmedAccounts.warmedAccountId,
  companyId: warmedAccounts.companyId,
  createdAt: warmedAccounts.createdAt,
});

export const warmedSlotBalanceRepository = createCompanyScopedRepository({
  table: warmedSlotBalances,
  id: warmedSlotBalances.companyId,
  companyId: warmedSlotBalances.companyId,
  createdAt: warmedSlotBalances.createdAt,
});

export const replacementDecisionRepository = createCompanyScopedRepository({
  table: replacementDecisions,
  id: replacementDecisions.id,
  companyId: replacementDecisions.companyId,
  createdAt: replacementDecisions.createdAt,
});

export const postRepository = createCompanyScopedRepository({
  table: posts,
  id: posts.id,
  companyId: posts.companyId,
  createdAt: posts.createdAt,
});

export const automationRepository = createCompanyScopedRepository({
  table: automations,
  id: automations.id,
  companyId: automations.companyId,
  createdAt: automations.createdAt,
});

export const automationSlotRepository = createCompanyScopedRepository({
  table: automationSlots,
  id: automationSlots.id,
  companyId: automationSlots.companyId,
  createdAt: automationSlots.createdAt,
});

/** `Lead` tiene soft-delete (DATA-024). */
export const leadRepository = createCompanyScopedRepository({
  table: leads,
  id: leads.id,
  companyId: leads.companyId,
  createdAt: leads.createdAt,
  deletedAt: leads.deletedAt,
});

export const banRiskAssessmentRepository = createCompanyScopedRepository({
  table: banRiskAssessments,
  id: banRiskAssessments.companyId,
  companyId: banRiskAssessments.companyId,
  createdAt: banRiskAssessments.createdAt,
});

export const apiKeyRepository = createCompanyScopedRepository({
  table: apiKeys,
  id: apiKeys.id,
  companyId: apiKeys.companyId,
  createdAt: apiKeys.createdAt,
});

export const uploadReservationRepository = createCompanyScopedRepository({
  table: uploadReservations,
  id: uploadReservations.uploadId,
  companyId: uploadReservations.companyId,
  createdAt: uploadReservations.createdAt,
});

export const quotaLedgerRepository = createCompanyScopedRepository({
  table: quotaLedgers,
  // PK compuesta `(companyId, period)`. Para el cursor alcanza con `period`, que es
  // único dentro del workspace.
  id: quotaLedgers.period,
  companyId: quotaLedgers.companyId,
  createdAt: quotaLedgers.createdAt,
});

export const judgmentRecordRepository = createCompanyScopedRepository({
  table: judgmentRecords,
  id: judgmentRecords.id,
  companyId: judgmentRecords.companyId,
  createdAt: judgmentRecords.createdAt,
});
