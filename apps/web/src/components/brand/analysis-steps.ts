/**
 * Los sub-pasos del análisis de una fuente · `P1-ONB-005`, `FR-011.2`.
 *
 * Hasta la migración `0031` la API sólo publicaba el estado de la fuente, y
 * los sub-pasos se listaban sin tildar (`lib/onboarding/processing.ts`). Ahora
 * la fuente trae `analysisPhase`: la etapa en la que **de verdad** está el
 * handler del worker. Esto la convierte en una lista con check progresivo.
 *
 * Sin porcentajes ni tiempos: cada paso es una etapa del código
 * (`apps/worker/src/brand/analysis-handler.ts`).
 *
 * - `reading_links` sólo existe en redes (link-in-bio). Si el perfil no tiene
 *   links, el worker salta de `collecting` a `synthesizing` y el paso queda
 *   atrás como los demás: no hubo nada que seguir.
 * - `verifying` corre con el verificador de campos (`JV-4`), que la
 *   instalación monta siempre que hay LLM.
 */
import type {
  BrandSource,
  BrandSourceAnalysisPhase,
  BrandSourceType,
} from "@fastgram/contracts";
import type { CopyKey } from "@/lib/i18n/t";

export type StepState = "done" | "current" | "pending";

export interface AnalysisStep {
  readonly phase: BrandSourceAnalysisPhase;
  readonly label: CopyKey;
  readonly state: StepState;
}

const WEB_TYPES: ReadonlySet<BrandSourceType> = new Set(["website", "other_url"]);

/** Las etapas que recorre el worker para este tipo de fuente, en orden. */
export function phasesFor(
  sourceType: BrandSourceType,
): readonly BrandSourceAnalysisPhase[] {
  return WEB_TYPES.has(sourceType)
    ? ["collecting", "synthesizing", "verifying"]
    : ["collecting", "reading_links", "synthesizing", "verifying"];
}

function labelOf(phase: BrandSourceAnalysisPhase, sourceType: BrandSourceType): CopyKey {
  if (phase === "collecting") {
    return WEB_TYPES.has(sourceType)
      ? "brand.phase.collecting.website"
      : "brand.phase.collecting.social";
  }
  return `brand.phase.${phase}`;
}

/**
 * Los pasos con su estado, o `null` si la fuente no está analizando (la lista
 * sólo tiene sentido mientras corre; al terminar manda el badge de estado).
 *
 * Con `analyzing` y sin fase —reclamada y todavía sin empezar, o un
 * re-análisis que ningún worker tomó— todos quedan `pending`.
 */
export function analysisSteps(
  source: Pick<BrandSource, "status" | "sourceType" | "analysisPhase">,
): readonly AnalysisStep[] | null {
  if (source.status !== "analyzing") return null;
  const phases = phasesFor(source.sourceType);
  const current = source.analysisPhase ?? null;
  // Una fase que este tipo no recorre (p. ej. `reading_links` en una web) no
  // debería llegar; si llega, se trata como «sin fase» en vez de inventar.
  const index = current === null ? -1 : phases.indexOf(current);
  return phases.map((phase, i) => ({
    phase,
    label: labelOf(phase, source.sourceType),
    state: index < 0 || i > index ? "pending" : i === index ? "current" : "done",
  }));
}
