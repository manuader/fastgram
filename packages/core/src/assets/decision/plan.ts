/**
 * Lo que el worker necesita para correr una decisión: la shortlist y, por
 * candidato, los dos pedidos al juicio (encaje y seguridad), ya armados.
 *
 * Es la costura entre lo puro (acá) y lo que habla con el puerto (el worker,
 * `apps/worker/src/judgment/asset-decider.ts`): el worker no arma preguntas ni
 * estados, sólo las manda con paralelismo acotado y un plazo, y le pasa lo que
 * vuelva a `decideAsset`.
 */
import type { JudgmentState } from "@fastgram/ports";

import { shortlistCandidates, type FilterResult } from "./filter.js";
import { assetPreferenceMultipliers, type AssetPreferenceInput } from "./preferences.js";
import { roleNeeds, type AssetRole, type DecisionFormat } from "./formats.js";
import {
  assetQuestions,
  assetSafetyState,
  assetState,
  type AssetFitQuestion,
} from "./questions.js";
import type { AssetCandidate, DecisionBrand } from "./types.js";

export interface AssetDecisionInput {
  readonly idea: string | null | undefined;
  readonly brand: DecisionBrand;
  readonly format: DecisionFormat;
  readonly role: AssetRole;
  readonly candidates: readonly AssetCandidate[];
  readonly recentIds?: ReadonlySet<string> | undefined;
  readonly shortlistSize?: number | undefined;
  /**
   * Sprint 9 (T): el gusto aprendido del dueño y si esta decisión explora.
   * Ausente = sin preferencias (todos ×1), como antes.
   */
  readonly preferences?: AssetPreferenceInput | null | undefined;
}

export interface CandidateRequests {
  readonly id: string;
  readonly fitState: JudgmentState;
  readonly safetyState: JudgmentState;
}

export interface AssetDecisionPlan extends FilterResult {
  readonly questions: readonly AssetFitQuestion[];
  readonly requests: readonly CandidateRequests[];
  /** Sprint 9 (T): id → multiplicador del gusto (sólo los ≠ 1). */
  readonly preference: ReadonlyMap<string, number>;
}

/** `null` si el formato no tiene ese rol (p. ej. música en `static`). */
export function planAssetDecision(input: AssetDecisionInput): AssetDecisionPlan | null {
  const needs = roleNeeds(input.format, input.role);
  if (needs === null) return null;
  const filtered = shortlistCandidates({
    idea: input.idea,
    needs,
    candidates: input.candidates,
    recentIds: input.recentIds,
    size: input.shortlistSize,
  });
  return {
    ...filtered,
    questions: assetQuestions(input.role),
    preference: assetPreferenceMultipliers(
      filtered.shortlist.map((e) => e.candidate),
      input.role,
      input.preferences,
    ),
    requests: filtered.shortlist.map(({ candidate }) => ({
      id: candidate.id,
      fitState: assetState({
        idea: input.idea,
        brand: input.brand,
        format: input.format,
        role: input.role,
        candidate,
      }),
      safetyState: assetSafetyState(candidate),
    })),
  };
}
