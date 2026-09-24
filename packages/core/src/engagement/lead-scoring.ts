/**
 * Scoring de leads de Reddit — `JV-2` / `DP-002` (PRD §25.3), `P4-ENGAGE-004`
 * y `P4-ENGAGE-005`.
 *
 * ## La división de trabajo
 *
 * El puerto `Judgment` responde **cinco preguntas cerradas** sobre un post
 * (una sola llamada, `ask`). La composición en un número, los pesos, el veto y
 * los cortes de lista viven **acá**, en código (§9.15.3 regla 2). Ningún
 * número de {@link LEAD_SCORE_WEIGHTS} ni de {@link LEAD_THRESHOLDS} aparece en
 * `instructions` ni en `criteria`.
 *
 * ## Recalculable sin reinferir (`P4-ENGAGE-005`)
 *
 * Quien persiste guarda las **respuestas crudas** (`leads.score_answers`,
 * además de `judgment_records`). {@link scoreLead} es pura sobre esas
 * respuestas: cambiar un peso mañana es volver a llamarla sobre lo guardado
 * ({@link parseStoredLeadAnswers}), sin volver a preguntarle a ningún modelo.
 *
 * ## Las preguntas: las del PRD, no otras
 *
 * El PRD fija las cinco (`hasProblem`, `buyingSignal`, `fitToAudience`,
 * `replyWelcome`, `alreadyAnswered`) y la fórmula
 * `0.35·buyingSignal + 0.30·fitToAudience + 0.20·hasProblem + 0.15·replyWelcome`
 * con veto `alreadyAnswered > 0.7`. Se implementan literalmente. `replyWelcome`
 * cubre «las reglas del subreddit permiten promoción» y el riesgo; por eso el
 * estado lleva las reglas del subreddit cuando se pudieron leer.
 *
 * ## Estado (§9.15.3 reglas 4 y 5)
 *
 * Filtrado: título, cuerpo, subreddit, score, cantidad de comentarios, hasta
 * {@link LEAD_STATE_LIMITS.comments} comentarios de arriba (sin autor) y las
 * reglas del subreddit; de la marca, **sólo** `coreIdentity`,
 * `productOffering` y `targetAudience` (JV-2: *"no enviar el perfil de marca
 * completo"*). **Sin autor**: el juicio no lo necesita y la Responsible Builder
 * Policy de Reddit prohíbe inferir características de los usuarios.
 * Limpio: sin invisibles ni control bidireccional, truncado.
 */
import type {
  JudgmentState,
  NoulAnswer,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
} from "@fastgram/ports";

import { cleanStateText } from "../judgment/preflight.js";

/* ------------------------------------------------------------------------ *
 * Preguntas (PRD §25.3 JV-2)
 * ------------------------------------------------------------------------ */

const hasProblem: NoulQuestion<"hasProblem"> = {
  id: "hasProblem",
  kind: "noul",
  instructions:
    "Does the Reddit post describe a problem or need that the product in brand.productOffering solves?",
  criteria: {
    true: "The post describes a concrete problem, need or goal that this product addresses.",
    false:
      "The post is about something the product does not address, or describes no problem at all.",
  },
};

const buyingSignal: ScoreQuestion<"buyingSignal"> = {
  id: "buyingSignal",
  kind: "score",
  instructions:
    "How close is the author of the post to looking for a solution like this product?",
  levels: [
    "Just commenting or sharing: no sign of looking for a solution.",
    "Frustrated with their current solution or situation.",
    "Evaluating or comparing alternatives.",
    "Explicitly asking for a recommendation of a product, tool or service.",
  ],
};

const fitToAudience: ScoreQuestion<"fitToAudience"> = {
  id: "fitToAudience",
  kind: "score",
  instructions:
    "How well does the author of the post match brand.targetAudience, judging only from what the post says?",
  levels: [
    "Outside the target audience.",
    "Adjacent to the target audience.",
    "Exactly the target audience.",
  ],
};

const replyWelcome: NoulQuestion<"replyWelcome"> = {
  id: "replyWelcome",
  kind: "noul",
  instructions:
    "Would a helpful reply that mentions a product, with disclosure, be welcome in this post and this subreddit without being spam? Use subredditRules if present.",
  criteria: {
    true: "The subreddit rules and the post allow recommendations, and a disclosed mention would read as help.",
    false:
      "The rules forbid self-promotion or recommendations, the post asks not to be sold to, or any mention would read as spam.",
  },
};

const alreadyAnswered: NoulQuestion<"alreadyAnswered"> = {
  id: "alreadyAnswered",
  kind: "noul",
  instructions:
    "Do the comments in topComments already fully solve what the post asks for?",
  criteria: {
    true: "At least one comment already gives a complete answer the author would accept.",
    false: "There are no comments, or none of them solves what the post asks for.",
  },
};

/** El lote de `JV-2`, en una llamada. Independientes entre sí (§9.15.1). */
export const LEAD_SCORING_QUESTIONS = [
  hasProblem,
  buyingSignal,
  fitToAudience,
  replyWelcome,
  alreadyAnswered,
] as const;

export interface LeadScoringAnswers {
  readonly hasProblem: NoulAnswer;
  readonly buyingSignal: ScoreAnswer;
  readonly fitToAudience: ScoreAnswer;
  readonly replyWelcome: NoulAnswer;
  readonly alreadyAnswered: NoulAnswer;
}

/* ------------------------------------------------------------------------ *
 * Composición (código, no modelo)
 * ------------------------------------------------------------------------ */

export interface LeadScoreWeights {
  readonly buyingSignal: number;
  readonly fitToAudience: number;
  readonly hasProblem: number;
  readonly replyWelcome: number;
}

/** PRD §25.3 JV-2, literal. Suman 1. */
export const LEAD_SCORE_WEIGHTS: LeadScoreWeights = {
  buyingSignal: 0.35,
  fitToAudience: 0.3,
  hasProblem: 0.2,
  replyWelcome: 0.15,
};

export interface LeadThresholds {
  /** `> top` → `Top Scored Leads`. */
  readonly top: number;
  /** `>= visible` y `<= top` → lista general. Debajo, no se muestra. */
  readonly visible: number;
  /** `alreadyAnswered > veto` → no se muestra, con cualquier score. */
  readonly veto: number;
}

/** PRD §25.3 JV-2, literal: `> 0.75`, `0.4–0.75`, `< 0.4`, veto `> 0.7`. */
export const LEAD_THRESHOLDS: LeadThresholds = { top: 0.75, visible: 0.4, veto: 0.7 };

/**
 * Versión de las **preguntas**. Se guarda con las respuestas: un peso nuevo se
 * aplica sobre respuestas viejas, pero una pregunta distinta es otra
 * inferencia y sus respuestas viejas no valen.
 */
export const LEAD_SCORING_VERSION = "2026-09-24.1";

export const LEAD_TIERS = ["top", "general", "hidden", "vetoed"] as const;
export type LeadTier = (typeof LEAD_TIERS)[number];

export interface LeadScoreBreakdown {
  /** Cada componente normalizado a [0, 1]. */
  readonly components: {
    readonly buyingSignal: number;
    readonly fitToAudience: number;
    readonly hasProblem: number;
    readonly replyWelcome: number;
    readonly alreadyAnswered: number;
  };
  /** [0, 1], redondeado a 4 decimales (la columna es `numeric(10,4)`). */
  readonly score: number;
  readonly tier: LeadTier;
}

/**
 * Un `ScoreAnswer.value` vive en `[1, levels]` (el puerto no normaliza, a
 * propósito): esto lo lleva a `[0, 1]`. Es la aritmética que §25.2 deja en
 * código.
 */
export function normalizeScoreValue(value: number, levels: number): number {
  if (levels < 2 || !Number.isFinite(value)) return 0;
  return clamp01((value - 1) / (levels - 1));
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

/** Compone las respuestas. Pura: sin reloj, sin red, sin azar. */
export function scoreLead(
  answers: LeadScoringAnswers,
  weights: LeadScoreWeights = LEAD_SCORE_WEIGHTS,
  thresholds: LeadThresholds = LEAD_THRESHOLDS,
): LeadScoreBreakdown {
  const components = {
    buyingSignal: normalizeScoreValue(
      answers.buyingSignal.value,
      buyingSignal.levels.length,
    ),
    fitToAudience: normalizeScoreValue(
      answers.fitToAudience.value,
      fitToAudience.levels.length,
    ),
    hasProblem: clamp01(answers.hasProblem.probability),
    replyWelcome: clamp01(answers.replyWelcome.probability),
    alreadyAnswered: clamp01(answers.alreadyAnswered.probability),
  };
  const score = round4(
    clamp01(
      weights.buyingSignal * components.buyingSignal +
        weights.fitToAudience * components.fitToAudience +
        weights.hasProblem * components.hasProblem +
        weights.replyWelcome * components.replyWelcome,
    ),
  );
  let tier: LeadTier;
  if (components.alreadyAnswered > thresholds.veto) tier = "vetoed";
  else if (score > thresholds.top) tier = "top";
  else if (score >= thresholds.visible) tier = "general";
  else tier = "hidden";
  return { components, score, tier };
}

/** Si el lead se lista (en cualquier vista). */
export function isVisibleTier(tier: LeadTier): boolean {
  return tier === "top" || tier === "general";
}

/* ------------------------------------------------------------------------ *
 * Respuestas guardadas → respuestas tipadas
 * ------------------------------------------------------------------------ */

function isNoul(v: unknown): v is NoulAnswer {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o["kind"] === "noul" && typeof o["probability"] === "number";
}

function isScore(v: unknown, levels: number): v is ScoreAnswer {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o["kind"] === "score" &&
    typeof o["value"] === "number" &&
    typeof o["confidence"] === "number" &&
    Array.isArray(o["probabilities"]) &&
    (o["probabilities"] as unknown[]).length === levels &&
    (o["probabilities"] as unknown[]).every((p) => typeof p === "number")
  );
}

/**
 * Lo guardado en `leads.score_answers` → respuestas tipadas, o `null` si no
 * tiene la forma (otra versión de las preguntas, fila vieja o corrupta).
 * `null` quiere decir «hay que volver a juzgar», nunca «score 0».
 */
export function parseStoredLeadAnswers(value: unknown): LeadScoringAnswers | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const { hasProblem: hp, buyingSignal: bs, fitToAudience: fa } = o;
  const { replyWelcome: rw, alreadyAnswered: aa } = o;
  if (!isNoul(hp) || !isNoul(rw) || !isNoul(aa)) return null;
  if (!isScore(bs, buyingSignal.levels.length)) return null;
  if (!isScore(fa, fitToAudience.levels.length)) return null;
  return {
    hasProblem: hp,
    buyingSignal: bs,
    fitToAudience: fa,
    replyWelcome: rw,
    alreadyAnswered: aa,
  };
}

/* ------------------------------------------------------------------------ *
 * Estado
 * ------------------------------------------------------------------------ */

export interface LeadScoringSubject {
  readonly post: {
    readonly title: string;
    readonly body: string | null;
    readonly subreddit: string;
    /** Score neto de Reddit. */
    readonly score: number;
    readonly numComments: number;
    /** Cuerpos de los comentarios de arriba, **sin autor**. */
    readonly topComments: readonly string[];
  };
  /** Reglas del subreddit (`short_name: description`), si se pudieron leer. */
  readonly subredditRules: readonly string[];
  readonly brand: {
    readonly coreIdentity?: string | null | undefined;
    readonly productOffering?: string | null | undefined;
    readonly targetAudience?: string | null | undefined;
  };
}

/** Topes. Un post largo es ruido y costo; un ataque de costo, peor. */
export const LEAD_STATE_LIMITS = {
  title: 300,
  body: 3_000,
  comment: 600,
  comments: 5,
  rule: 300,
  rules: 15,
  field: 600,
} as const;

export function buildLeadScoringState(subject: LeadScoringSubject): JudgmentState {
  const L = LEAD_STATE_LIMITS;
  return {
    post: {
      subreddit: cleanStateText(subject.post.subreddit, 64),
      title: cleanStateText(subject.post.title, L.title),
      body: cleanStateText(subject.post.body, L.body),
      score: Number.isFinite(subject.post.score) ? subject.post.score : 0,
      numComments: Number.isFinite(subject.post.numComments)
        ? Math.max(0, subject.post.numComments)
        : 0,
    },
    topComments: subject.post.topComments
      .slice(0, L.comments)
      .map((c) => cleanStateText(c, L.comment))
      .filter((c) => c.length > 0),
    subredditRules: subject.subredditRules
      .slice(0, L.rules)
      .map((r) => cleanStateText(r, L.rule))
      .filter((r) => r.length > 0),
    brand: {
      coreIdentity: cleanStateText(subject.brand.coreIdentity, L.field),
      productOffering: cleanStateText(subject.brand.productOffering, L.field),
      targetAudience: cleanStateText(subject.brand.targetAudience, L.field),
    },
  };
}
