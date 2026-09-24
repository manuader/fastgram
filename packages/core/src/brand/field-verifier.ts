/**
 * `JV-4` — verificador de campos de marca · `DP-004` (PRD §25.3, `AI-016`).
 *
 * Hasta acá **todo** campo sintetizado quedaba en `low` (`materializeField`
 * recorta a `low` la confianza del sintetizador), así que `Worth a quick check`
 * marcaba el perfil entero y dejaba de significar algo. `AI-016` lo dice: «la
 * confianza por campo la produce `JV-4`, no el LLM de síntesis: quien deriva un
 * valor no es buen juez de su propia evidencia».
 *
 * ## Qué pregunta
 *
 * Literal del PRD (§25.3): un juicio por campo sobre `{fieldName, derivedValue,
 * sourceExcerpt, sourceType}` con dos preguntas independientes:
 *
 * - `supported` (noul): ¿el extracto respalda el valor sin suponer nada?
 * - `specificity` (score, 3 niveles): genérico → parcialmente → específico.
 *
 * ## El mapeo, literal del PRD
 *
 * `supported > 0.85` **y** `specificity ≥ 2` → `high`; `supported > 0.6` →
 * `medium`; resto → `low`. Los umbrales viven acá y no en el prompt (§9.15.3
 * regla 2): cambiarlos no reinfiere nada.
 *
 * ## Fallback conservador
 *
 * Sin modelo de juicio, con timeout o con una respuesta rota, el campo queda
 * **como estaba**: confianza del sintetizador, que `materializeField` recorta a
 * `low`. Nunca se sube una confianza que nadie midió.
 */
import type {
  JudgmentState,
  NoulAnswer,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
} from "@fastgram/ports";

import { cleanStateText } from "../judgment/preflight.js";
import type { DerivedField, FieldConfidence } from "./synthesis.js";

const supported: NoulQuestion<"supported"> = {
  id: "supported",
  kind: "noul",
  instructions:
    "Does the source excerpt support the derived value on its own, without assuming anything that is not written there?",
  criteria: {
    true: "Everything the derived value claims can be read in the excerpt.",
    false:
      "The derived value claims something the excerpt does not say, contradicts it, or needs outside assumptions.",
  },
};

const specificity: ScoreQuestion<"specificity"> = {
  id: "specificity",
  kind: "score",
  instructions: "How specific to this particular business is the derived value?",
  levels: [
    "Generic: it could describe almost any business in the category.",
    "Partially specific: some details are particular to this business.",
    "Specific to this business: it names what makes this business itself.",
  ],
};

/** Las dos preguntas de `JV-4`, en un solo lote (son independientes). */
export const FIELD_VERIFIER_QUESTIONS = [supported, specificity] as const;

export interface FieldVerifierAnswers {
  readonly supported: NoulAnswer;
  readonly specificity: ScoreAnswer;
}

/** Umbrales literales de `JV-4` (PRD §25.3). */
export const FIELD_VERIFIER_THRESHOLDS = {
  highSupported: 0.85,
  highSpecificity: 2,
  mediumSupported: 0.6,
} as const;

/** Mapeo de `JV-4` a `fieldMeta.confidence`. Puro, recalculable sobre lo guardado. */
export function confidenceFromVerification(
  answers: FieldVerifierAnswers,
): FieldConfidence {
  const p = answers.supported.probability;
  const s = answers.specificity.value;
  const t = FIELD_VERIFIER_THRESHOLDS;
  if (p > t.highSupported && s >= t.highSpecificity) return "high";
  if (p > t.mediumSupported) return "medium";
  return "low";
}

/** Topes del estado (regla 5: filtrado). No son números del PRD. */
export const FIELD_VERIFIER_STATE_LIMITS = { value: 1_000, excerpt: 2_000 } as const;

/**
 * El estado de un campo, limpio de invisibles y truncado (regla 4). El
 * adaptador además lo mete en el bloque `untrusted` del `Llm`.
 */
export function buildFieldVerificationState(field: DerivedField): JudgmentState {
  return {
    fieldName: field.field,
    derivedValue: cleanStateText(field.value, FIELD_VERIFIER_STATE_LIMITS.value),
    sourceExcerpt: cleanStateText(field.excerpt, FIELD_VERIFIER_STATE_LIMITS.excerpt),
    sourceType: field.sourceType,
  };
}

/** ¿Vale la pena verificarlo? Sin valor o sin extracto el guardarraíl ya lo vacía. */
export function isVerifiable(field: DerivedField): boolean {
  return field.value.trim().length > 0 && (field.excerpt?.trim().length ?? 0) > 0;
}

const isProbability = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Lee las respuestas crudas (del puerto o de lo guardado). `null` si no tienen
 * la forma esperada: el llamador cae al fallback conservador.
 */
export function parseFieldVerifierAnswers(raw: unknown): FieldVerifierAnswers | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const sup = r["supported"];
  const spec = r["specificity"];
  if (typeof sup !== "object" || sup === null) return null;
  if (typeof spec !== "object" || spec === null) return null;
  const s = sup as Record<string, unknown>;
  const p = spec as Record<string, unknown>;
  if (s["kind"] !== "noul" || !isProbability(s["probability"])) return null;
  const value = p["value"];
  if (
    p["kind"] !== "score" ||
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 1 ||
    value > specificity.levels.length ||
    !Array.isArray(p["probabilities"])
  ) {
    return null;
  }
  return {
    supported: { kind: "noul", probability: s["probability"] },
    specificity: {
      kind: "score",
      value,
      probabilities: (p["probabilities"] as unknown[]).filter(
        (x): x is number => typeof x === "number",
      ),
      confidence: typeof p["confidence"] === "number" ? p["confidence"] : 0,
    },
  };
}

/** El campo con la confianza medida por el verificador. */
export function applyVerification(
  field: DerivedField,
  answers: FieldVerifierAnswers,
): DerivedField {
  return {
    ...field,
    confidence: confidenceFromVerification(answers),
    confidenceSource: "verifier",
  };
}
