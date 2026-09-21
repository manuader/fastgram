/**
 * `StubJudgmentAdapter` — PRD §9.15.2 (fila «Tests»), `P1-JUDGE-003`.
 *
 * «Respuestas fijas, para tests deterministas sin red.» Es el adaptador que
 * desbloquea testear todo lo que consume `Judgment` sin depender de que haya
 * un gateway vivo, y el que hace ejecutable la suite de contrato del puerto
 * antes de que exista ningún proveedor.
 *
 * Dos modos, y la diferencia importa:
 *
 * 1. **Guionado** (`answers`). Se fija la respuesta por id de pregunta. Es lo
 *    que usa un test de caso de uso que quiere ejercitar «qué pasa cuando
 *    `brandSafe` da 0,4»: el umbral de §25.3 se prueba contra un valor que el
 *    test eligió, no contra uno que salió de un modelo.
 *
 * 2. **Derivado** (default). Sin guion, la respuesta sale de un hash del
 *    estado y de la pregunta. **No es aleatoria**: la misma petición da
 *    siempre lo mismo, entre corridas y entre procesos, porque el hash es
 *    propio y no usa `Math.random` ni el reloj.
 *
 * El modo derivado existe para que la suite de contrato tenga algo que
 * verificar. Un stub que devolviera siempre la primera opción con probabilidad
 * 1 pasaría el contrato sin ejercitar nada: `value` sería trivialmente el
 * argmax y `confidence` trivialmente 1. Con distribuciones no degeneradas, un
 * bug en `normalize` o en `argmaxIndex` se ve.
 *
 * **Lo que el stub deliberadamente NO hace:** juzgar. Sus respuestas no tienen
 * relación con el estado más allá de depender de él. Usarlo para medir calidad
 * (§25.4) sería medir un hash.
 */

import {
  PortError,
  type ChoiceAnswer,
  type ChoiceRequest,
  type Judgment,
  type JudgmentAnswer,
  type JudgmentBatchOutcome,
  type JudgmentOutcome,
  type JudgmentProvenance,
  type JudgmentQuestion,
  type JudgmentState,
  type NoulAnswer,
  type NoulRequest,
  type ScoreAnswer,
  type ScoreRequest,
  type AnswersFor,
  type AskRequest,
} from "@fastgram/ports";
import {
  argmaxIndex,
  assertBatch,
  assertChoice,
  assertNoul,
  assertScore,
  assertTimeout,
  concentration,
  normalize,
  weightedLevel,
} from "./validate.js";

const SOURCE = "Judgment/stub";

/**
 * Respuesta guionada. Se declara por la parte que el test controla y el
 * adaptador completa el resto **manteniendo el contrato**: si se guiona
 * `value: "travel"`, la distribución se arma de modo que `travel` sea el
 * argmax. Un guion no puede producir una respuesta que viole §9.15.1, porque
 * entonces el test estaría verificando algo que ningún adaptador real podría
 * devolver.
 */
export type ScriptedAnswer =
  | { readonly kind: "choice"; readonly value: string }
  | { readonly kind: "score"; readonly level: number }
  | { readonly kind: "noul"; readonly probability: number };

export interface StubJudgmentOptions {
  /** Respuestas por id de pregunta. Lo que no esté acá se deriva del hash. */
  readonly answers?: { readonly [questionId: string]: ScriptedAnswer };
  /**
   * Latencia simulada, en ms. Default 0.
   *
   * Sirve para ejercitar el fallback de §9.15.3.7 de verdad: con
   * `latencyMs: 50` y `timeoutMs: 20` el consumidor recibe `timeout` y se
   * puede verificar que publica igual (`JV-3`).
   */
  readonly latencyMs?: number;
  /** `DATA-033.model`. Fijo, porque el stub no tiene modelo. */
  readonly model?: string;
}

export class StubJudgmentAdapter implements Judgment {
  readonly provenance: JudgmentProvenance;
  readonly #answers: { readonly [questionId: string]: ScriptedAnswer };
  readonly #latencyMs: number;

  constructor(options: StubJudgmentOptions = {}) {
    this.#answers = options.answers ?? {};
    this.#latencyMs = options.latencyMs ?? 0;
    this.provenance = {
      // `DATA-033` enumera `llm | jev | stub`. Este es el tercero.
      adapter: "stub",
      model: options.model ?? "stub-1",
    };
  }

  async choice<TOption extends string>(
    request: ChoiceRequest<TOption>,
  ): Promise<JudgmentOutcome<ChoiceAnswer<TOption>>> {
    assertTimeout(request.timeoutMs, SOURCE);
    assertChoice(request.question, SOURCE);
    const started = Date.now();
    await this.#delay(request.timeoutMs);
    const answer = this.#choiceAnswer<TOption>(request.state, request.question);
    return { answer, usage: { latencyMs: Date.now() - started } };
  }

  async score(request: ScoreRequest): Promise<JudgmentOutcome<ScoreAnswer>> {
    assertTimeout(request.timeoutMs, SOURCE);
    assertScore(request.question, SOURCE);
    const started = Date.now();
    await this.#delay(request.timeoutMs);
    const answer = this.#scoreAnswer(request.state, request.question);
    return { answer, usage: { latencyMs: Date.now() - started } };
  }

  async noul(request: NoulRequest): Promise<JudgmentOutcome<NoulAnswer>> {
    assertTimeout(request.timeoutMs, SOURCE);
    assertNoul(request.question, SOURCE);
    const started = Date.now();
    await this.#delay(request.timeoutMs);
    const answer = this.#noulAnswer(request.state, request.question);
    return { answer, usage: { latencyMs: Date.now() - started } };
  }

  async ask<const Q extends readonly JudgmentQuestion[]>(
    request: AskRequest<Q>,
  ): Promise<JudgmentBatchOutcome<Q>> {
    assertTimeout(request.timeoutMs, SOURCE);
    assertBatch(request.questions, SOURCE);
    const started = Date.now();
    await this.#delay(request.timeoutMs);

    const answers: Record<string, JudgmentAnswer> = {};
    for (const question of request.questions) {
      // Cada respuesta se deriva sólo de (estado, pregunta) — nunca del lote.
      // Es lo que hace que el orden no pueda condicionar el resultado, que es
      // lo que §9.15.1 promete al llamarlas independientes.
      answers[question.id] = this.#answerFor(request.state, question);
    }

    return {
      answers: answers as AnswersFor<Q>,
      usage: { latencyMs: Date.now() - started },
    };
  }

  /* -------------------------------------------------------------------- */

  #answerFor(state: JudgmentState, question: JudgmentQuestion): JudgmentAnswer {
    switch (question.kind) {
      case "choice":
        return this.#choiceAnswer(state, question);
      case "score":
        return this.#scoreAnswer(state, question);
      case "noul":
        return this.#noulAnswer(state, question);
      default: {
        const unknown: never = question;
        throw new PortError(
          "bad_request",
          `unknown question kind: ${JSON.stringify(unknown)}`,
          { source: SOURCE },
        );
      }
    }
  }

  #choiceAnswer<TOption extends string>(
    state: JudgmentState,
    question: { readonly id: string; readonly criteria: Record<string, string> },
  ): ChoiceAnswer<TOption> {
    const options = Object.keys(question.criteria);
    const seed = seedOf(state, question.id);
    const scripted = this.#answers[question.id];

    let weights: number[];
    if (scripted !== undefined && scripted.kind === "choice") {
      const index = options.indexOf(scripted.value);
      if (index < 0) {
        throw new PortError(
          "bad_request",
          `scripted answer for "${question.id}" is "${scripted.value}", which is not one of its criteria`,
          { source: SOURCE },
        );
      }
      // El guion elige el ganador; el resto queda repartido pero por debajo,
      // para que `value` siga siendo el argmax como exige el contrato.
      weights = options.map((_, i) => (i === index ? 8 : 1));
    } else {
      weights = options.map((option) => 1 + unitOf(`${seed}|opt|${option}`) * 4);
    }

    const probabilities = normalize(weights);
    const winner = argmaxIndex(probabilities);
    const distribution: Record<string, number> = {};
    for (let i = 0; i < options.length; i += 1) {
      const option = options[i];
      if (option === undefined) continue;
      distribution[option] = probabilities[i] ?? 0;
    }

    return {
      kind: "choice",
      value: (options[winner] ?? options[0] ?? "") as TOption,
      probabilities: distribution as { readonly [option in TOption]: number },
      confidence: concentration(probabilities),
    };
  }

  #scoreAnswer(
    state: JudgmentState,
    question: { readonly id: string; readonly levels: readonly string[] },
  ): ScoreAnswer {
    const levels = question.levels;
    const seed = seedOf(state, question.id);
    const scripted = this.#answers[question.id];

    let weights: number[];
    if (scripted !== undefined && scripted.kind === "score") {
      const target = clamp(scripted.level, 1, levels.length);
      // Campana angosta centrada en el nivel pedido: el `value` ponderado cae
      // sobre él sin que la distribución sea degenerada.
      weights = levels.map((_, i) => 1 / (1 + Math.abs(i + 1 - target) * 6));
    } else {
      weights = levels.map(
        (level, i) => 1 + unitOf(`${seed}|lvl|${String(i)}|${level}`) * 4,
      );
    }

    const probabilities = normalize(weights);
    return {
      kind: "score",
      value: weightedLevel(probabilities),
      probabilities,
      confidence: concentration(probabilities),
    };
  }

  #noulAnswer(state: JudgmentState, question: { readonly id: string }): NoulAnswer {
    const scripted = this.#answers[question.id];
    if (scripted !== undefined && scripted.kind === "noul") {
      return { kind: "noul", probability: clamp(scripted.probability, 0, 1) };
    }
    // Sin `confidence`: §9.15.1 devuelve sólo probabilidad para `noul`, y
    // agregarla haría detectable qué adaptador respondió.
    return { kind: "noul", probability: unitOf(seedOf(state, question.id)) };
  }

  async #delay(timeoutMs: number | undefined): Promise<void> {
    if (this.#latencyMs <= 0) return;
    if (timeoutMs !== undefined && timeoutMs <= this.#latencyMs) {
      await sleep(timeoutMs);
      throw new PortError("timeout", `judgment timed out after ${String(timeoutMs)} ms`, {
        source: SOURCE,
      });
    }
    await sleep(this.#latencyMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Semilla estable de (estado, pregunta).
 *
 * El estado se serializa con las claves ordenadas: dos objetos con el mismo
 * contenido y distinto orden de inserción tienen que dar la misma respuesta, o
 * el stub dejaría de ser determinista de una forma casi imposible de
 * diagnosticar.
 */
function seedOf(state: JudgmentState, questionId: string): string {
  return `${stableStringify(state)}|${questionId}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** FNV-1a de 32 bits. Propio para no arrastrar una dependencia por esto. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** El hash llevado a [0, 1). */
function unitOf(text: string): number {
  return hash32(text) / 0x1_0000_0000;
}
