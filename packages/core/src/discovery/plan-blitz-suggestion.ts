/**
 * Una sugerencia **construible** — `AI-002` (a)–(f) más la media concreta.
 *
 * `planSuggestion` hace las seis tiradas de `AI-002` y devuelve candidatos;
 * esto las cierra en algo que `POST /blitz` puede convertir en un
 * `buildPayload` sin volver a decidir nada:
 *
 *  1. **Formatos sin media no compiten** (`formatsWithMedia`): pesan 0 en la
 *     tirada (b). `FR-050`: *"tipo válido pero no producible ahora"*. Los que
 *     quedaron afuera con peso > 0 van a la explicación.
 *  2. **Influencer**: la tirada independiente y el fallback a regular son de
 *     `planSuggestion`. Acá se agrega un fallback más: con un único candidato,
 *     si sus sets (`FR-083`) no tienen media para el formato, la pieza es
 *     regular. Una pieza «con influencer» sin el influencer en la media sería
 *     un chip que miente. Con varios candidatos sigue sin elegirse: es
 *     `DP-005`/`JV-6` (ver `plan-suggestion.ts`).
 *  3. **La media** (`selectMedia`), con el `Rng` **después** de las seis
 *     tiradas: agregarla no cambia ninguna de las anteriores para un seed.
 */
import type { Rng } from "@fastgram/ports";
import type { BlitzContentType } from "../content/content.js";
import {
  formatsWithMedia,
  influencerCoversFormat,
  selectMedia,
  type MediaBank,
  type MediaSelection,
} from "./blitz-media.js";
import type { BlitzPreferences } from "./blitz-preferences.js";
import {
  planSuggestion,
  type EligibleInfluencer,
  type SuggestionPlan,
} from "./plan-suggestion.js";
import { explainSuggestion } from "./refill-job.js";

export interface BlitzPlanningContext {
  readonly activeAngleIds: readonly string[];
  readonly influencers: readonly EligibleInfluencer[];
  readonly bank: MediaBank;
  /** Para la explicación: ids → títulos y nombres. */
  readonly angleTitles: ReadonlyMap<string, string>;
  readonly influencerNames: ReadonlyMap<string, string>;
}

export interface PlannedBlitzSuggestion {
  readonly plan: SuggestionPlan;
  /** El influencer que **sí** se usa: único candidato y con media. */
  readonly influencerId: string | null;
  readonly media: MediaSelection;
  /** La parte determinista de `aiExplanation` (`explainSuggestion`). */
  readonly derivedExplanation: string;
}

const MIX: readonly [BlitzContentType, keyof BlitzPreferences][] = [
  ["slideshow", "slideshowWeight"],
  ["wall-of-text", "wallOfTextWeight"],
  ["green-screen", "greenScreenWeight"],
  ["video-hook", "videoHookWeight"],
];

/**
 * Lanza `DomainError("invalid_state")` si ningún formato del mix tiene media
 * (viene de `planSuggestion`), o si los pesos de ángulo no cubren a ninguno
 * activo. Las dos son estado del workspace y no mejoran reintentando.
 */
export function planBlitzSuggestion(
  rng: Rng,
  preferences: BlitzPreferences,
  context: BlitzPlanningContext,
): PlannedBlitzSuggestion {
  const available = formatsWithMedia(context.bank);
  const skippedFormats = MIX.filter(
    ([format, key]) => (preferences[key] as number) > 0 && !available.includes(format),
  ).map(([format]) => format);

  const plan = planSuggestion(rng, preferences, {
    activeAngleIds: context.activeAngleIds,
    influencers: context.influencers,
    availableFormats: available,
  });

  let influencerId: string | null = null;
  let influencerWithoutMedia: string | undefined;
  const single =
    plan.influencer.decision === "use" && plan.influencer.candidates.length === 1
      ? (plan.influencer.candidates[0] as string)
      : null;
  if (single !== null) {
    if (influencerCoversFormat(context.bank, single, plan.contentType)) {
      influencerId = single;
    } else {
      influencerWithoutMedia = context.influencerNames.get(single) ?? "Your influencer";
    }
  }

  const media = selectMedia(rng, context.bank, plan.contentType, influencerId);
  if (media === null) {
    // `formatsWithMedia` y `influencerCoversFormat` ya lo garantizaron. Llegar
    // acá es que las dos funciones divergieron.
    throw new Error(`selectMedia no encontró media para ${plan.contentType}`);
  }

  const undecided =
    plan.influencer.decision === "use" && single === null
      ? plan.influencer.candidates.length
      : 0;

  return {
    plan,
    influencerId,
    media,
    derivedExplanation: explainSuggestion(plan, {
      angleTitle:
        plan.angleId === null ? undefined : context.angleTitles.get(plan.angleId),
      influencerName:
        influencerId === null ? undefined : context.influencerNames.get(influencerId),
      undecidedCandidates: undecided,
      influencerWithoutMedia,
      skippedFormats,
    }),
  };
}
