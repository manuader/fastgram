/**
 * `decideAsset` — ponderación, umbral de seguridad, empate y fallback. Puro.
 *
 * Recibe lo que el juicio respondió por candidato (o nada) y devuelve el
 * elegido, el puntaje por candidato y dimensión, y un motivo legible. Es la
 * misma función para decidir y para **recalcular** una decisión guardada con
 * otros pesos: por eso toma respuestas crudas y no llama a nadie.
 *
 * ## Nunca bloquea
 *
 * - Sin juicio (no hay motor, se cayó, venció el plazo) → el primero del
 *   ranking textual (`mode: "fallback"`), como JV-6 hoy.
 * - Con respuestas parciales (algunos candidatos llegaron, otros no) → se
 *   decide entre los que llegaron. Un candidato sin respuesta no compite: no
 *   hay con qué ponerlo al lado de los otros.
 * - Todos fuera por seguridad → `chosen: null` (`mode: "all_unsafe"`). En el
 *   fallback, un candidato ya marcado inseguro tampoco se elige. Quien
 *   llama se queda con lo que ya tenía y lo loguea; elegir «el menos malo»
 *   sería publicar algo que el umbral dijo que no.
 */
import type { NoulAnswer, ScoreAnswer } from "@fastgram/ports";

import type { ShortlistEntry, Exclusion } from "./filter.js";
import type { AssetRole } from "./formats.js";
import type { AssetDimension, SafetyDimension } from "./questions.js";
import {
  ASSET_WEIGHTS,
  ASSET_WEIGHTS_VERSION,
  HARM_MAX,
  NSFW_MAX,
  TIE_EPSILON,
  type DimensionWeights,
} from "./weights.js";

/** Lo que el juicio respondió sobre un candidato. Ausente = no llegó. */
export interface CandidateAnswers {
  readonly fit?: Readonly<Partial<Record<AssetDimension, ScoreAnswer>>>;
  /** Las dos preguntas de seguridad (llegan juntas: un solo pedido). */
  readonly safety?: Readonly<Partial<Record<SafetyDimension, NoulAnswer>>>;
}

export interface ScoredCandidate {
  readonly id: string;
  readonly textRank: number;
  readonly textScore: number;
  /** Por dimensión: `value` del puerto ([1, n]) y normalizado a [0, 1]. */
  readonly dimensions: Readonly<
    Partial<Record<AssetDimension, { readonly value: number; readonly norm: number }>>
  >;
  /** p(daño) y p(NSFW), si llegaron. */
  readonly harm: number | null;
  readonly nsfw: number | null;
  /** Ponderado en [0, 1]; `null` si no compite. */
  readonly total: number | null;
  readonly status: "scored" | "unsafe" | "unanswered";
}

export type DecisionMode = "judged" | "fallback" | "all_unsafe" | "empty";

export interface AssetDecision {
  readonly role: AssetRole;
  readonly chosenId: string | null;
  readonly mode: DecisionMode;
  /** Una línea, en inglés: va a la explicación de la sugerencia y a la base. */
  readonly reason: string;
  readonly scored: readonly ScoredCandidate[];
  readonly excluded: readonly Exclusion[];
  readonly weights: DimensionWeights;
  readonly weightsVersion: string;
}

/** `[1, n]` → `[0, 1]`. */
export function normalizeScore(answer: ScoreAnswer): number {
  const n = answer.probabilities.length;
  if (n < 2) return 0;
  return Math.min(1, Math.max(0, (answer.value - 1) / (n - 1)));
}

/**
 * Suma ponderada sobre las dimensiones **juzgadas** que el candidato tiene y
 * el rol pesa, más la textual. `null` si no hay ninguna juzgada: la textual
 * sola no es una decisión del juicio (eso es el fallback).
 */
function weighted(
  dims: ScoredCandidate["dimensions"],
  textNorm: number,
  weights: DimensionWeights,
): number | null {
  let sum = 0;
  let total = 0;
  let judged = 0;
  for (const [dim, weight] of Object.entries(weights) as [
    AssetDimension | "text",
    number,
  ][]) {
    if (!(weight > 0)) continue;
    if (dim === "text") {
      sum += weight * textNorm;
      total += weight;
      continue;
    }
    const d = dims[dim];
    if (d === undefined) continue;
    sum += weight * d.norm;
    total += weight;
    judged += 1;
  }
  return judged > 0 && total > 0 ? sum / total : null;
}

/** La relevancia textual de cada uno, contra la mejor de la shortlist: [0, 1]. */
function textNorms(shortlist: readonly ShortlistEntry[]): ReadonlyMap<string, number> {
  const best = Math.max(0, ...shortlist.map((e) => e.textScore));
  return new Map(
    shortlist.map((e) => [
      e.candidate.id,
      best > 0 ? Math.max(0, e.textScore) / best : 0,
    ]),
  );
}

export function decideAsset(input: {
  readonly role: AssetRole;
  readonly shortlist: readonly ShortlistEntry[];
  readonly excluded?: readonly Exclusion[];
  /** `id → respuestas`. `null` = no hubo juicio en absoluto. */
  readonly answers: ReadonlyMap<string, CandidateAnswers> | null;
  /** Para recalcular con otros pesos. Default: los del rol. */
  readonly weights?: DimensionWeights;
  readonly weightsVersion?: string;
  readonly harmMax?: number;
  readonly nsfwMax?: number;
}): AssetDecision {
  const weights = input.weights ?? ASSET_WEIGHTS[input.role];
  const weightsVersion = input.weightsVersion ?? ASSET_WEIGHTS_VERSION;
  const harmMax = input.harmMax ?? HARM_MAX;
  const nsfwMax = input.nsfwMax ?? NSFW_MAX;
  const excluded = input.excluded ?? [];
  const base = { role: input.role, excluded, weights, weightsVersion };

  if (input.shortlist.length === 0) {
    return {
      ...base,
      chosenId: null,
      mode: "empty",
      reason: "No candidate fits this format.",
      scored: [],
    };
  }

  const texts = textNorms(input.shortlist);
  const scored: ScoredCandidate[] = input.shortlist.map((entry) => {
    const a = input.answers?.get(entry.candidate.id);
    const dimensions: Partial<
      Record<AssetDimension, { readonly value: number; readonly norm: number }>
    > = {};
    for (const [dim, answer] of Object.entries(a?.fit ?? {}) as [
      AssetDimension,
      ScoreAnswer | undefined,
    ][]) {
      if (answer !== undefined) {
        dimensions[dim] = { value: answer.value, norm: normalizeScore(answer) };
      }
    }
    const harm = a?.safety?.harm?.probability ?? null;
    const nsfw = a?.safety?.nsfw?.probability ?? null;
    const checked = harm !== null || nsfw !== null;
    const unsafe =
      (harm !== null && harm >= harmMax) || (nsfw !== null && nsfw >= nsfwMax);
    const total = weighted(dimensions, texts.get(entry.candidate.id) ?? 0, weights);
    const common = {
      id: entry.candidate.id,
      textRank: entry.textRank,
      textScore: entry.textScore,
      dimensions,
      harm,
      nsfw,
    };
    // Sin la respuesta de seguridad **no compite**: el umbral es duro, y un
    // candidato sin medir no pasó el umbral.
    // Lo inseguro primero: un candidato marcado inseguro lo está aunque su
    // pregunta de encaje no haya llegado.
    if (unsafe) return { ...common, total: null, status: "unsafe" };
    if (a === undefined || total === null || !checked) {
      return { ...common, total: null, status: "unanswered" };
    }
    return { ...common, total, status: "scored" };
  });

  const competing = scored.filter(
    (s): s is ScoredCandidate & { total: number } => s.status === "scored",
  );

  if (competing.length === 0) {
    // Fallback al ranking textual, **salteando lo que el juicio ya marcó
    // inseguro**: que no haya llegado a tiempo con el resto no borra lo que sí
    // se supo.
    const notUnsafe = scored.filter((s) => s.status !== "unsafe");
    const fallback = notUnsafe.reduce<ScoredCandidate | null>(
      (a, b) => (a === null || b.textRank < a.textRank ? b : a),
      null,
    );
    if (fallback === null) {
      return {
        ...base,
        chosenId: null,
        mode: "all_unsafe",
        reason: `All ${String(scored.length)} judged candidates failed the brand-safety check.`,
        scored,
      };
    }
    return {
      ...base,
      chosenId: fallback.id,
      mode: "fallback",
      reason:
        input.answers === null
          ? "Picked by topic keywords (the judgment model was not available)."
          : "Picked by topic keywords (the judgment model did not answer in time).",
      scored,
    };
  }

  // Mayor total; empate (±TIE_EPSILON) → mejor ranking textual.
  const best = competing.reduce((a, b) => {
    if (b.total > a.total + TIE_EPSILON) return b;
    if (Math.abs(b.total - a.total) <= TIE_EPSILON && b.textRank < a.textRank) return b;
    return a;
  });
  const idea = best.dimensions.ideaFit;
  return {
    ...base,
    chosenId: best.id,
    mode: "judged",
    reason:
      `Picked by AI among ${String(competing.length)} candidates` +
      (idea === undefined ? "" : ` (idea fit ${idea.value.toFixed(1)}/4`) +
      (idea === undefined ? "" : `, score ${best.total.toFixed(2)})`) +
      ".",
    scored,
  };
}

/** Los N mejores de una decisión, para mostrar o loguear. */
export function topScored(
  decision: AssetDecision,
  n: number,
): readonly ScoredCandidate[] {
  return [...decision.scored]
    .filter((s) => s.total !== null)
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0) || a.textRank - b.textRank)
    .slice(0, n);
}

/**
 * Los candidatos con encaje ya respondido, del mejor al peor total (empate →
 * ranking textual), **sin mirar la seguridad**. Es el orden en que el worker
 * pregunta la seguridad: se pregunta sólo hasta encontrar uno seguro, porque
 * todo lo que está debajo no puede ganar (ver `apps/worker/src/judgment`).
 */
export function rankByFit(input: {
  readonly role: AssetRole;
  readonly shortlist: readonly ShortlistEntry[];
  readonly fits: ReadonlyMap<
    string,
    Readonly<Partial<Record<AssetDimension, ScoreAnswer>>>
  >;
  readonly weights?: DimensionWeights;
}): readonly string[] {
  const weights = input.weights ?? ASSET_WEIGHTS[input.role];
  const texts = textNorms(input.shortlist);
  const rows: { id: string; total: number; textRank: number }[] = [];
  for (const entry of input.shortlist) {
    const fit = input.fits.get(entry.candidate.id);
    if (fit === undefined) continue;
    const dims: Partial<Record<AssetDimension, { value: number; norm: number }>> = {};
    for (const [dim, answer] of Object.entries(fit) as [
      AssetDimension,
      ScoreAnswer | undefined,
    ][]) {
      if (answer !== undefined)
        dims[dim] = { value: answer.value, norm: normalizeScore(answer) };
    }
    const total = weighted(dims, texts.get(entry.candidate.id) ?? 0, weights);
    if (total !== null)
      rows.push({ id: entry.candidate.id, total, textRank: entry.textRank });
  }
  rows.sort((a, b) =>
    Math.abs(a.total - b.total) <= TIE_EPSILON
      ? a.textRank - b.textRank
      : b.total - a.total,
  );
  return rows.map((r) => r.id);
}
