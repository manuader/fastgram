/**
 * Repositorios concretos.
 *
 * Todos se construyen con `createCompanyScopedRepository`, así que todos heredan la
 * misma propiedad: **ninguna firma acepta un id sin `TenantScope`**. Los que necesitan
 * más que CRUD (idempotencia, cuotas) agregan métodos, nunca quitan el scope.
 */

export * from "./base.js";
export * from "./catalog.js";
export * from "./company.js";
export * from "./quota-ledger.js";
export * from "./filters.js";
export * from "./idempotency.js";
export * from "./workspace-directory.js";
// Sprint 8 (K): biblioteca de modelos del dueño.
export * from "./character-models.js";
// Sprint 9 (Q): preferencias aprendidas desde Blitz.
export * from "./preferences.js";
export * from "./strategy.js";
export * from "./connections.js";

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
  influencerGenerations,
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
  // `PATCH /blitz/preferences` tiene que funcionar antes de que la fila exista: el
  // workspace recién creado no tiene preferencias y el usuario igual abre el drawer.
  upsertTarget: [blitzPreferences.companyId],
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
  // PK compuesta `(contentId, id)`: el id de la caja (`slide-0-text-0`) sólo es único
  // dentro de su contenido. Editar un contenido reescribe sus cajas, y el conflicto
  // tiene que resolver por el par — por `id` solo chocaría con la caja homónima de
  // otro contenido. El `companyId` **no** está en el target, así que acá el `setWhere`
  // de `upsert` es lo único que impide escribir sobre la caja de otro workspace.
  upsertTarget: [contentTextBoxes.contentId, contentTextBoxes.id],
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
  // 1:1 con el influencer. Igual que en las cajas de texto, `companyId` no está en el
  // target y el aislamiento lo sostiene el `setWhere`.
  upsertTarget: [influencerConfigs.influencerId],
});

/** `PU-LATER-004`, `FR-081`: pedidos de imágenes del personaje (`0020`). */
export const influencerGenerationRepository = createCompanyScopedRepository({
  table: influencerGenerations,
  id: influencerGenerations.id,
  companyId: influencerGenerations.companyId,
  createdAt: influencerGenerations.createdAt,
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
  upsertTarget: [warmedSlotBalances.companyId],
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
  upsertTarget: [banRiskAssessments.companyId],
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
  // La PK compuesta completa. `period` solo no es único y Postgres rechazaría el
  // `ON CONFLICT`: es el caso que motiva que `upsertTarget` sea explícito.
  upsertTarget: [quotaLedgers.companyId, quotaLedgers.period],
});

export const judgmentRecordRepository = createCompanyScopedRepository({
  table: judgmentRecords,
  id: judgmentRecords.id,
  companyId: judgmentRecords.companyId,
  createdAt: judgmentRecords.createdAt,
});
export { resolveApiKeyByHash, type ApiKeyBootstrapRow } from "./api-key-bootstrap.js";
export { contentBuildStore, lockContent, type ContentRow } from "./content-build.js";
export {
  countQueued,
  discoveryQueueStore,
  listPlanningMedia,
  lockCompanyRefill,
  refillLockKey,
  refillQueue,
  type InfluencerSetRow,
  type PlanningMediaRow,
  type QueuedSuggestionDraft,
  type RefillResult,
} from "./discovery-queue.js";
export {
  createJudgmentSink,
  judgmentSinkStore,
  writeJudgmentRecord,
  type DbJudgmentSink,
  type JudgmentRecordInput,
  type JudgmentRecordRow,
  type JudgmentSinkOptions,
} from "./judgment-sink.js";
export {
  claimCreditsRefund,
  influencerCreditsStore,
  lockInfluencer,
  type InfluencerCreditsCharge,
  type InfluencerRow,
} from "./influencer-credits.js";
export { brandStalenessStore, sweepStaleBrandSources } from "./brand-staleness.js";
export { lockBrandSource } from "./brand-source-lock.js";
export { purgeExpiredSnapshotRaw, snapshotPurgeStore } from "./snapshot-purge.js";
export { lockPost, postPublishStore, type PostRow } from "./post-publish.js";
export {
  completeMediaNormalization,
  failMediaNormalization,
  findMediaToNormalize,
  mediaNormalizationStore,
  type CompleteNormalizationInput,
  type MediaRow,
} from "./media-normalization.js";
export {
  brandAnalysisStore,
  claimBrandSourceAnalysis,
  completeBrandSourceAnalysis,
  failBrandSourceAnalysis,
  findBrandSourceForAnalysis,
  insertBrandSourceSnapshot,
  latestSnapshotsOfOtherSources,
  lockCompanyProfile,
  saveMaterializedProfile,
  setBrandSourceAnalysisPhase,
  type BrandSourceRow,
  type CompanyProfileRow,
  type CompleteBrandSourceInput,
  type FailBrandSourceInput,
  type InsertSnapshotInput,
  type MaterializedProfileValues,
  type OtherSourceSnapshot,
  type SaveMaterializedProfileInput,
} from "./brand-analysis.js";
export {
  blitzAcceptanceStore,
  claimNextQueuedSuggestion,
  discardQueuedSuggestion,
  findLiveMedia,
  listQueuedSuggestions,
  lockLiveMedia,
  lockSuggestionById,
  markSuggestionPopped,
  type LiveMediaRow,
  type QueuedSuggestionView,
  type SuggestionContentType,
  type SuggestionRow,
} from "./blitz-acceptance.js";
export {
  blitzPromptStore,
  completePromptRequest,
  createPromptRequest,
  failPromptRequest,
  findPromptRequest,
  isOpenPromptRequest,
  listPromptSuggestionIds,
  lockPromptRequest,
  markPromptRequestRunning,
  type BlitzPromptRequestRow,
  type BlitzPromptStatus,
  type NewPromptRequest,
} from "./blitz-prompt.js";
export {
  brandKitStore,
  existingBrandKitKeys,
  insertBrandKitMedia,
  lockCompanyBrandKit,
  type BrandKitMediaInput,
} from "./brand-kit.js";
export {
  AUTOPILOT_RUN_OUTCOMES,
  autopilotStore,
  countSuggestionsCreatedInRange,
  findAutopilotRun,
  listAutopilotBrands,
  listAutopilotDecisionsInRange,
  listPilotCandidates,
  recordAutopilotDecision,
  saveAutopilotRun,
  type AutopilotBrandRow,
  type AutopilotDecisionRow,
  type AutopilotRunOutcome,
  type AutopilotRunRow,
  type AutopilotRunValues,
  type DecisionWithSuggestion,
  type NewAutopilotDecision,
} from "./autopilot.js";
export {
  POST_METRIC_COLUMNS,
  metricsStore,
  mixTuningStore,
  type AnalyticsPostRow,
  type ContentMixAutotuneRow,
  type FormatMixAdjustmentRow,
  type FormatWeightsRow,
  type MetricsSyncPostRow,
  type PostMetricColumn,
  type PostMetricsWrite,
} from "./metrics.js";
// `0022`: Inspiration como tablero de referencias propio (FR-040 adaptado, OQ-13).
export {
  applyOwnerReferenceIngest,
  createOwnerReference,
  deleteOwnerReference,
  escapeLike,
  findOwnerReference,
  listOwnerReferenceTags,
  listOwnerReferences,
  setOwnerReferenceTags,
  type NewOwnerReference,
  type OwnerReferenceIngestPatch,
  type OwnerReferenceQuery,
  type TrendingItemRow,
} from "./inspiration.js";
// `0021`: Engagement de Reddit (leads JV-2, respuestas JV-5, ban meter DP-003).
export * from "./engagement.js";
// `FR-150`, `P3-AUTO-001…013`: campañas multi-semana.
export * from "./automations.js";
// `0025`: biblioteca de audio de cada marca (sprint 7, audio).
export * from "./brand-audio.js";
// `0029`: búsqueda del Media Bank e importación de posts propios (sprint 7, F).
export * from "./media-bank.js";
// `0028` (sprint 7, notify-reliability): notificaciones, apagado de marca y media en uso.
export * from "./notifications.js";
export * from "./brand-shutdown.js";
export * from "./media-usage.js";
// `0026` (sprint 7, memes desde un prompt): la búsqueda automática del meme.
export * from "./blitz-prompt-meme.js";
// `0031` (sprint 7, H): oferta post-análisis de `/brand`.
export * from "./brand-flow.js";
// `0036` (sprint 9, N): biblioteca global de assets (D-19).
export * from "./library.js";
// `0040` (sprint 9, R): anuncios pagos con Meta (D-21).
export * from "./ads.js";
// `0037` (sprint 9, O): decisiones del decisor de assets.
export * from "./asset-decisions.js";
// `0035` (sprint 9, M): design system por marca.
export * from "./design-system.js";
// Sprint 9 (U, `0041`): el planificador semanal de reels (`PU-S9-014`).
export * from "./reel-plans.js";
