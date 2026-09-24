/**
 * La selección de un slot — `AI-012` sobre `AI-002`.
 *
 * Es `planBlitzSuggestion` (las seis tiradas, la media del Media Bank, el
 * fallback de influencer) con dos diferencias:
 *
 * 1. **El tipo viene dado** por el reparto exacto de la campaña
 *    (`assignContentTypes`) o por el re-roll. Se fuerza como hace «crear desde
 *    prompt»: ese tipo al 100 %, los demás en 0.
 * 2. **Las preferencias son el snapshot**, no las de la marca, y los ángulos
 *    son los activos que el snapshot pesa (`snapshotAngleIds`).
 *
 * Si el tipo no tiene media, **no se cambia de tipo** (`AI-012`: un tipo con
 * peso 0 no es fallback, y otro tipo tampoco): el slot falla. Con `video-hook`
 * el motivo es el del PRD, `no_demo_video`; con los otros, `no_media` (código
 * nuestro, en `errorCode`: el enum de `failureReason` sólo tiene los dos del
 * PRD).
 */
import type { Rng } from "@fastgram/ports";
import type { BlitzContentType } from "../content/content.js";
import { DomainError } from "../errors.js";
import { formatsWithMedia } from "../discovery/blitz-media.js";
import {
  planBlitzSuggestion,
  type BlitzPlanningContext,
  type PlannedBlitzSuggestion,
} from "../discovery/plan-blitz-suggestion.js";
import {
  forcedTypePreferences,
  snapshotAngleIds,
  type AutomationPrefsSnapshot,
  type AutomationSlotFailureReason,
} from "./model.js";

export type PlanSlotOutcome =
  | { readonly ok: true; readonly planned: PlannedBlitzSuggestion }
  | {
      readonly ok: false;
      readonly failureReason: AutomationSlotFailureReason | null;
      readonly errorCode: "no_demo_video" | "no_media" | "invalid_state";
      readonly message: string;
    };

export function planAutomationSlot(
  rng: Rng,
  snapshot: AutomationPrefsSnapshot,
  context: BlitzPlanningContext,
  contentType: BlitzContentType,
): PlanSlotOutcome {
  if (!formatsWithMedia(context.bank).includes(contentType)) {
    return contentType === "video-hook"
      ? {
          ok: false,
          failureReason: "no_demo_video",
          errorCode: "no_demo_video",
          message: "No demo video in the Media Bank (category hook-video).",
        }
      : {
          ok: false,
          failureReason: null,
          errorCode: "no_media",
          message: `No media in the Media Bank for ${contentType}.`,
        };
  }
  try {
    return {
      ok: true,
      planned: planBlitzSuggestion(rng, forcedTypePreferences(snapshot, contentType), {
        ...context,
        activeAngleIds: snapshotAngleIds(snapshot, context.activeAngleIds),
      }),
    };
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === "invalid_state") {
      return {
        ok: false,
        failureReason: null,
        errorCode: "invalid_state",
        message: error.message,
      };
    }
    throw error;
  }
}
