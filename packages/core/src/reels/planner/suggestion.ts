/**
 * El `build_plan` de una sugerencia `reel` — sprint 9 (U), `PU-S9-014`.
 *
 * Una sugerencia de reel ya trae **el spec entero** (lo armó el planificador
 * con copy, assets y la marca): aceptar es construirlo, sin componer nada.
 * Además lleva lo que el deck y las preferencias necesitan sin volver a
 * derivarlo: el póster, los ids de media (para comprobar que siguen vivos
 * antes de cobrar, como `lockLiveMedia` en los formatos base) y los rasgos.
 *
 * `core` no valida el spec (no depende de zod): lo hace quien lo lee con
 * `reelSpecSchema` de `@fastgram/contracts`. Acá sólo la forma del sobre.
 */
import type {
  PreferenceReelInput,
  PreferenceSubject,
} from "../../preferences/features.js";
import { REEL_TEMPLATES, type ReelTemplate } from "../plan.js";

export const REEL_SUGGESTION_PLAN_VERSION = 1;

export interface ReelSuggestionPlan {
  readonly kind: "reel";
  readonly version: typeof REEL_SUGGESTION_PLAN_VERSION;
  /** El ítem del plan semanal que la produjo (`reel_plan_items.id`). */
  readonly planItemId: string;
  /** El `ReelSpec` a construir (se valida al leer). */
  readonly spec: unknown;
  /** Clave de storage del póster (`null` = no se pudo renderizar). */
  readonly posterKey: string | null;
  /** Media del Media Bank que usa el spec: al aceptar tienen que seguir vivas. */
  readonly mediaIds: readonly string[];
  readonly template: ReelTemplate;
  /** Para las preferencias (v2). */
  readonly features: PreferenceReelInput;
  readonly durationSec: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** El sobre, o `null` si no es un plan de reel (sugerencia vieja o de otro formato). */
export function reelSuggestionPlanOf(raw: unknown): ReelSuggestionPlan | null {
  if (!isObj(raw) || raw["kind"] !== "reel" || raw["version"] !== 1) return null;
  const planItemId = raw["planItemId"];
  const template = raw["template"];
  const durationSec = raw["durationSec"];
  if (
    typeof planItemId !== "string" ||
    typeof template !== "string" ||
    !(REEL_TEMPLATES as readonly string[]).includes(template) ||
    typeof durationSec !== "number" ||
    !isObj(raw["spec"])
  ) {
    return null;
  }
  const f = isObj(raw["features"]) ? raw["features"] : {};
  const clip = f["clip"];
  return {
    kind: "reel",
    version: 1,
    planItemId,
    spec: raw["spec"],
    posterKey: typeof raw["posterKey"] === "string" ? raw["posterKey"] : null,
    mediaIds: strList(raw["mediaIds"]),
    template: template as ReelTemplate,
    features: {
      template,
      animations: strList(f["animations"]),
      captionStyle: typeof f["captionStyle"] === "string" ? f["captionStyle"] : null,
      clip:
        clip === "chroma" || clip === "alpha" || clip === "opaque" || clip === "none"
          ? clip
          : null,
    },
    durationSec,
  };
}

/**
 * Lo que un reel suma al sujeto de preferencias de su sugerencia. Para
 * `suggestionSubject` de la API: `{ ...base, ...reelPreferenceSubject(plan) }`.
 */
export function reelPreferenceSubject(
  buildPlan: unknown,
): Pick<PreferenceSubject, "reel" | "durationSec"> {
  const plan = reelSuggestionPlanOf(buildPlan);
  if (plan === null) return {};
  return { reel: plan.features, durationSec: plan.durationSec };
}
