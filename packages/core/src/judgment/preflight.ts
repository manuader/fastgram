/**
 * Pre-chequeo del piloto automático — `JV-3` / `DP-007` (PRD §25.3, `EXT-007`)
 * adaptado a `D-08` (`PU-AUTO-002`).
 *
 * ## Qué cambia respecto del `JV-3` del PRD, y por qué
 *
 * El `JV-3` del PRD corre **delante de un humano** que está programando: si
 * bloquea, el usuario edita; si el puerto no responde, **se publica igual**
 * (§25.3: *"un pre-flight caído no puede impedir que el usuario use el
 * producto"*). En el piloto no hay humano mirando, así que dos cosas se
 * invierten a propósito:
 *
 * 1. **Un juicio que no llega no aprueba nada.** Timeout o proveedor caído →
 *    la pieza queda en la cola para revisión manual (`hold`). Sigue sin
 *    bloquear el producto —el piloto sigue, Blitz sigue— pero nunca se
 *    auto-aprueba algo que nadie juzgó.
 * 2. **Los umbrales son más estrictos que los de §25.3.** El PRD bloquea
 *    `policyRisk` con confianza > 0,7 porque del otro lado hay alguien que
 *    puede corregir un falso negativo antes de publicar. Acá un falso negativo
 *    sale publicado, y un falso positivo sólo cuesta una sugerencia
 *    descartada (el refill repone). Se rechaza con 30 % de masa de riesgo.
 *
 * Las preguntas son las del pedido (`PU-AUTO-002`): en tema con la marca,
 * afirmaciones riesgosas (salud, finanzas, legales), terceros mencionados,
 * coherencia e idioma. `hookQuality` y `needsAiLabel` de §25.3 quedan afuera:
 * ninguno decide aprobar o no (§25.3 lo dice del hook: *"nunca bloqueo"*).
 *
 * ## Las reglas de §9.15.3 que este archivo cumple
 *
 * - **Los umbrales viven acá, no en el prompt** (regla 2). Ningún número de
 *   {@link PRECHECK_THRESHOLDS} aparece en `instructions` ni en `criteria`.
 * - **Recalculables sin reinferir**: {@link evaluatePrecheck} es pura sobre las
 *   respuestas crudas, y quien persiste guarda esas respuestas (no sólo el
 *   veredicto). Cambiar un umbral mañana es volver a llamar a esta función
 *   sobre lo guardado ({@link parseStoredPrecheckAnswers}).
 * - **Estado filtrado** (regla 5): sólo la copy, el formato, el idioma y
 *   cuatro campos del perfil — no el perfil entero (`JV-2` lo pide explícito).
 * - **Estado limpio** (regla 4): {@link buildPrecheckState} saca caracteres
 *   invisibles y de control bidireccional y trunca. El adaptador además lo
 *   mete en el bloque `untrusted` del puerto `Llm`.
 */
import type {
  ChoiceAnswer,
  JudgmentState,
  NoulAnswer,
  ChoiceQuestion,
  NoulQuestion,
} from "@fastgram/ports";

/** Las opciones de `riskyClaims`. `none` primero: es el caso esperado. */
export const RISKY_CLAIM_OPTIONS = [
  "none",
  "health_claim",
  "financial_claim",
  "legal_claim",
] as const;
export type RiskyClaimOption = (typeof RISKY_CLAIM_OPTIONS)[number];

const onBrand: NoulQuestion<"onBrand"> = {
  id: "onBrand",
  kind: "noul",
  instructions:
    "Is the caption about this brand's business, offering, audience or tone, as described in the brand fields of the state?",
  criteria: {
    true: "The caption clearly fits the brand: it talks about what the brand offers, the problem it solves, or topics its audience cares about.",
    false:
      "The caption is about something unrelated to the brand, or would read the same for any random business.",
  },
};

const riskyClaims: ChoiceQuestion<"riskyClaims", RiskyClaimOption> = {
  id: "riskyClaims",
  kind: "choice",
  instructions:
    "Does the caption make a claim that could be risky to publish for a brand?",
  criteria: {
    none: "No risky claim: opinions, tips, humor or product descriptions without guarantees.",
    health_claim:
      "A health or medical claim: cures, treats, prevents or diagnoses something, or promises a body or mental health result.",
    financial_claim:
      "A financial claim: promises income, returns, savings or investment results, or gives investment advice.",
    legal_claim:
      "A legal claim: legal advice, guarantees of legal outcomes, or statements about laws or regulations presented as fact.",
  },
};

const thirdPartyBrands: NoulQuestion<"thirdPartyBrands"> = {
  id: "thirdPartyBrands",
  kind: "noul",
  // Concreta a propósito: con una redacción abstracta ("¿menciona a un
  // competidor?") un 7B local respondió 0,2 a una copy que nombraba IKEA,
  // Herman Miller y MacBook (verificación del 2026-09-24, ver el reporte).
  instructions:
    "Read the caption word by word. Does it contain the proper name of any company, store, product, app, device or famous person, other than brand.name from the state? Names like Starbucks, IKEA, Nike, iPhone, MacBook, Netflix or Elon Musk count.",
  criteria: {
    true: "At least one proper name of another company, store, product, app, device or famous person appears in the caption.",
    false:
      "The only proper name in the caption is brand.name (or there is none). Generic words like 'coffee' or 'desk' are not names.",
  },
};

const coherent: NoulQuestion<"coherent"> = {
  id: "coherent",
  kind: "noul",
  instructions: "Is the caption coherent, readable text that a person could post as is?",
  criteria: {
    true: "Complete sentences or phrases that make sense together, with no leftover placeholders, markup or instructions.",
    false:
      "Garbled, truncated, repetitive or self-contradictory text, placeholders like [brand] or {name}, or text that reads like instructions to a model.",
  },
};

const inLanguage: NoulQuestion<"inLanguage"> = {
  id: "inLanguage",
  kind: "noul",
  instructions:
    "Is the caption written in the language given by expectedLanguage in the state (a BCP 47 tag such as es, en or pt-BR)?",
  criteria: {
    true: "The caption is written in that language. Brand names, hashtags or a loanword in another language are fine.",
    false: "Most of the caption is written in a different language.",
  },
};

/**
 * El lote, en **una** llamada (`ask`). Independientes entre sí: ninguna
 * respuesta condiciona otra (§9.15.1), la composición es de {@link evaluatePrecheck}.
 */
export const AUTOPILOT_PRECHECK_QUESTIONS = [
  onBrand,
  riskyClaims,
  thirdPartyBrands,
  coherent,
  inLanguage,
] as const;

export interface PrecheckAnswers {
  readonly onBrand: NoulAnswer;
  readonly riskyClaims: ChoiceAnswer<RiskyClaimOption>;
  readonly thirdPartyBrands: NoulAnswer;
  readonly coherent: NoulAnswer;
  readonly inLanguage: NoulAnswer;
}

/**
 * Umbrales — **decisión nuestra, no del PRD** (ver la cabecera). Cambiarlos
 * no reinfiere nada: {@link evaluatePrecheck} corre sobre lo guardado.
 *
 * - `onBrandMin`: probabilidad mínima de "en tema".
 * - `riskyClaimMaxMass`: masa máxima de probabilidad sobre las opciones de
 *   riesgo (`1 - P(none)`). A partir de ahí, se rechaza.
 * - `thirdPartyMax`: probabilidad máxima de "nombra a un tercero".
 * - `coherentMin`, `inLanguageMin`: mínimas.
 */
export interface PrecheckThresholds {
  readonly onBrandMin: number;
  readonly riskyClaimMaxMass: number;
  readonly thirdPartyMax: number;
  readonly coherentMin: number;
  readonly inLanguageMin: number;
}

export const PRECHECK_THRESHOLDS: PrecheckThresholds = {
  onBrandMin: 0.6,
  riskyClaimMaxMass: 0.3,
  thirdPartyMax: 0.5,
  coherentMin: 0.6,
  inLanguageMin: 0.6,
};

/**
 * Versión de {@link PRECHECK_THRESHOLDS} **y** de las preguntas. Se guarda con
 * cada decisión: una respuesta vieja se recalcula contra umbrales nuevos, pero
 * no contra preguntas distintas (otra pregunta es otra inferencia).
 */
export const PRECHECK_VERSION = "2026-09-24.1";

/** Por qué no pasó. Códigos estables: la API los devuelve y la web los traduce. */
export const PRECHECK_REJECT_REASONS = [
  "off_brand",
  "health_claim",
  "financial_claim",
  "legal_claim",
  "third_party_brand",
  "incoherent",
  "wrong_language",
] as const;
export type PrecheckRejectReason = (typeof PRECHECK_REJECT_REASONS)[number];

export interface PrecheckEvaluation {
  readonly pass: boolean;
  /** Vacío si pasó. En el orden de las preguntas. */
  readonly reasons: readonly PrecheckRejectReason[];
}

/**
 * Compone las respuestas en un veredicto. Pura: sin reloj, sin red, sin azar.
 * Es la única función que conoce los umbrales.
 */
export function evaluatePrecheck(
  answers: PrecheckAnswers,
  thresholds: PrecheckThresholds = PRECHECK_THRESHOLDS,
): PrecheckEvaluation {
  const reasons: PrecheckRejectReason[] = [];

  if (answers.onBrand.probability < thresholds.onBrandMin) reasons.push("off_brand");

  const probs = answers.riskyClaims.probabilities;
  const riskMass = 1 - (probs.none ?? 0);
  if (riskMass >= thresholds.riskyClaimMaxMass) {
    // El motivo es la opción de riesgo más probable, no el `value` crudo: con
    // `none` = 0,65 el `value` es `none` y aun así hay 35 % de riesgo.
    const risky = RISKY_CLAIM_OPTIONS.filter(
      (o): o is Exclude<RiskyClaimOption, "none"> => o !== "none",
    );
    let top: Exclude<RiskyClaimOption, "none"> = "health_claim";
    for (const option of risky) {
      if ((probs[option] ?? 0) > (probs[top] ?? 0)) top = option;
    }
    reasons.push(top);
  }

  if (answers.thirdPartyBrands.probability >= thresholds.thirdPartyMax) {
    reasons.push("third_party_brand");
  }
  if (answers.coherent.probability < thresholds.coherentMin) reasons.push("incoherent");
  if (answers.inLanguage.probability < thresholds.inLanguageMin) {
    reasons.push("wrong_language");
  }

  return { pass: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------------ *
 * La decisión del piloto
 * ------------------------------------------------------------------------ */

/** Lo que pasó al preguntar. El consumidor traduce `PortError` a esto. */
export type PrecheckOutcome =
  | { readonly kind: "answered"; readonly answers: PrecheckAnswers }
  /** El puerto no respondió dentro del timeout duro. */
  | { readonly kind: "timeout" }
  /**
   * Cualquier otro fallo del juicio: proveedor caído, sin modelo, respuesta
   * fuera de contrato. `code` es el código estable del `PortError`.
   */
  | { readonly kind: "unavailable"; readonly code: string };

export const AUTOPILOT_HOLD_REASONS = [
  "judgment_timeout",
  "judgment_unavailable",
] as const;
export type AutopilotHoldReason = (typeof AUTOPILOT_HOLD_REASONS)[number];

export type AutopilotDecision =
  | { readonly kind: "approve" }
  | { readonly kind: "reject"; readonly reasons: readonly PrecheckRejectReason[] }
  /** Queda en la cola para revisión manual. **Nunca** se auto-aprueba. */
  | { readonly kind: "hold"; readonly reason: AutopilotHoldReason };

export function decideAutopilot(
  outcome: PrecheckOutcome,
  thresholds: PrecheckThresholds = PRECHECK_THRESHOLDS,
): AutopilotDecision {
  switch (outcome.kind) {
    case "timeout":
      return { kind: "hold", reason: "judgment_timeout" };
    case "unavailable":
      return { kind: "hold", reason: "judgment_unavailable" };
    case "answered": {
      const evaluation = evaluatePrecheck(outcome.answers, thresholds);
      return evaluation.pass
        ? { kind: "approve" }
        : { kind: "reject", reasons: evaluation.reasons };
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Estado
 * ------------------------------------------------------------------------ */

export interface PrecheckSubject {
  /** La copy de la sugerencia (`generatedText`). */
  readonly caption: string;
  readonly contentType: string;
  /** BCP 47, de la estrategia. */
  readonly language: string;
  readonly brandName: string;
  readonly profile: {
    readonly coreIdentity?: string | null | undefined;
    readonly productOffering?: string | null | undefined;
    readonly targetAudience?: string | null | undefined;
    readonly toneOfVoice?: string | null | undefined;
  };
}

/** Topes por campo. Una copy de Blitz es corta; más que esto es ruido o ataque de costo. */
export const PRECHECK_STATE_LIMITS = { caption: 2_000, field: 600 } as const;

/**
 * Invisibles y control bidireccional: mismo criterio que `containUntrusted`
 * (`sanitization/untrusted-text.ts`). Se arma por código para no contener los
 * caracteres que describe.
 */
const INVISIBLE = new RegExp(
  "[" +
    "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F" +
    "\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF" +
    "]",
  "g",
);

export function cleanStateText(value: string | null | undefined, max: number): string {
  if (value === null || value === undefined) return "";
  const clean = value.replace(INVISIBLE, "").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** El estado filtrado y limpio. Ver la cabecera (reglas 4 y 5). */
export function buildPrecheckState(subject: PrecheckSubject): JudgmentState {
  const field = (v: string | null | undefined): string =>
    cleanStateText(v, PRECHECK_STATE_LIMITS.field);
  return {
    caption: cleanStateText(subject.caption, PRECHECK_STATE_LIMITS.caption),
    contentType: subject.contentType,
    expectedLanguage: field(subject.language),
    brand: {
      name: field(subject.brandName),
      coreIdentity: field(subject.profile.coreIdentity),
      productOffering: field(subject.profile.productOffering),
      targetAudience: field(subject.profile.targetAudience),
      toneOfVoice: field(subject.profile.toneOfVoice),
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Recalcular sobre lo guardado
 * ------------------------------------------------------------------------ */

const isProbability = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function noulOf(raw: unknown): NoulAnswer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return r["kind"] === "noul" && isProbability(r["probability"])
    ? { kind: "noul", probability: r["probability"] }
    : null;
}

function riskyOf(raw: unknown): ChoiceAnswer<RiskyClaimOption> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const probs = r["probabilities"];
  if (r["kind"] !== "choice" || typeof probs !== "object" || probs === null) return null;
  const p = probs as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const option of RISKY_CLAIM_OPTIONS) {
    const value = p[option];
    if (!isProbability(value)) return null;
    out[option] = value;
  }
  const value = r["value"];
  if (
    typeof value !== "string" ||
    !(RISKY_CLAIM_OPTIONS as readonly string[]).includes(value)
  )
    return null;
  const confidence = r["confidence"];
  return {
    kind: "choice",
    value: value as RiskyClaimOption,
    probabilities: out as Record<RiskyClaimOption, number>,
    confidence: isProbability(confidence) ? confidence : 0,
  };
}

/**
 * Las respuestas guardadas (jsonb) → {@link PrecheckAnswers}, o `null` si no
 * tienen la forma. Es lo que permite recalcular con umbrales nuevos.
 */
export function parseStoredPrecheckAnswers(raw: unknown): PrecheckAnswers | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const onBrandA = noulOf(r["onBrand"]);
  const risky = riskyOf(r["riskyClaims"]);
  const third = noulOf(r["thirdPartyBrands"]);
  const coherentA = noulOf(r["coherent"]);
  const lang = noulOf(r["inLanguage"]);
  if (
    onBrandA === null ||
    risky === null ||
    third === null ||
    coherentA === null ||
    lang === null
  ) {
    return null;
  }
  return {
    onBrand: onBrandA,
    riskyClaims: risky,
    thirdPartyBrands: third,
    coherent: coherentA,
    inLanguage: lang,
  };
}
