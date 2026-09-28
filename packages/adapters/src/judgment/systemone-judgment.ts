/**
 * `SystemOneJudgmentAdapter` — PRD §9.15.2, D-18 (sprint 9, agente O).
 *
 * Implementa el puerto `Judgment` sobre el protocolo **SystemOne**
 * (`POST {baseUrl}/v1/systemone`), el de Jev de TypeSafe. Lo hablan dos
 * motores y este adaptador sirve a los dos:
 *
 * - **Laya** (Apache-2.0, `laya-serve`), local en la Mac. Es el default de
 *   D-18: el decisor de assets y los `JV-*` corren sin costo.
 * - **Jev** (`https://api.typesafe.ai`, `Authorization: Bearer`,
 *   `model: "jev-latest"`), si hay key.
 *
 * ## El wire, verificado contra el código de Laya y la doc de TypeSafe
 *
 * Pedido: `{ model?, state, questions: { [id]: { type, instructions, criteria } } }`.
 * `criteria` es un objeto `opción → descripción` en `choice`, **un array** de
 * descripciones en `score` (todas obligatorias en Laya: un nivel `null` es
 * 422) y `{ true, false }` en `noul`.
 *
 * Respuesta: `{ model, answers: { [id]: … }, usage: { input_tokens,
 * output_tokens } }` (Laya agrega `routing`). Por tipo:
 * `choice` → `{ choice, probabilities: {opción: p}, confidence }`;
 * `score` → `{ score, legend: {"0": …}, probabilities: {"0": p, …}, confidence }`;
 * `noul` → `{ noul }`. Laya suma `answer_confidence` en los tres.
 *
 * ## Tres traducciones que no son obvias
 *
 * 1. **`score` es 0-based.** SystemOne devuelve el nivel esperado sobre los
 *    índices de `legend` (`0 … n-1`); el puerto pide `value` en
 *    `[1, levels.length]`. Se recalcula desde la distribución
 *    (`weightedLevel`), igual que el adaptador LLM, y el `score` del proveedor
 *    sólo se usa para verificar que el proveedor habló del mismo espacio.
 * 2. **`confidence` sale de `answer_confidence`, nunca del `confidence` del
 *    proveedor.** El puerto define `confidence` como «qué tan concentrada está
 *    la distribución» y el adaptador de referencia (LLM) la implementa como
 *    `max(p)` (`validate.ts`, `concentration`). `answer_confidence` de Laya es
 *    exactamente la probabilidad de la respuesta reportada, o sea `max(p)`:
 *    mismo número, mismo espacio, y los umbrales de §25.3 (`JV6_MIN_CONFIDENCE`
 *    = 0,4, por ejemplo) valen igual con cualquiera de los dos adaptadores. El
 *    `confidence` de Laya es 1 − entropía normalizada y el de Jev es
 *    `(n·p_max − 1)/(n − 1)`: dos fórmulas distintas entre sí y distintas de la
 *    del puerto (el README de Laya lo advierte). Jev no manda
 *    `answer_confidence`: ahí se calcula `max(p)` acá, que es lo mismo.
 * 3. **`noul` → `probability`**, sin confianza aparte (el puerto lo prohíbe).
 *
 * ## Lo que este adaptador no hace (y quién sí)
 *
 * Ni sanitiza ni filtra el estado (§9.15.3.4 y .5): llega listo, como al LLM.
 * Y a diferencia del LLM, **no hay bloque `untrusted`**: un System One no
 * sigue instrucciones del estado como un chat —es un clasificador—, pero
 * sigue valiendo que «un modelo de juicio no es un guardrail de inyección».
 *
 * La key viaja sólo en `Authorization`. Nunca en un mensaje de error, nunca en
 * `onRawResponse` (que lleva el cuerpo de la **respuesta**, no el pedido).
 */

import {
  PortError,
  type AnswersFor,
  type AskRequest,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type ChoiceRequest,
  type DecisionPoint,
  type Judgment,
  type JudgmentAnswer,
  type JudgmentBatchOutcome,
  type JudgmentOutcome,
  type JudgmentProvenance,
  type JudgmentQuestion,
  type JudgmentState,
  type JudgmentUsage,
  type NoulAnswer,
  type NoulQuestion,
  type NoulRequest,
  type ScoreAnswer,
  type ScoreQuestion,
  type ScoreRequest,
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

export type SystemOneFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Tope duro de opciones por `choice` en Laya: `laya.serve` rechaza más de
 * 100 con 413 antes de inferir (`MAX_CHOICE_OPTIONS = 100` en `serve.py`).
 * Se valida acá para devolver `bad_request` sin viajar.
 */
export const LAYA_MAX_CHOICE_OPTIONS = 100;

/**
 * Por encima de esto Laya recorta las descripciones de las opciones para que
 * entren en su presupuesto de tokens (`head_max_len`, 192–256), y opciones
 * largas o parecidas le llegan leyéndose igual (README, «Options per
 * question»: «around 20 options with a short description each»). No es un
 * error: es un aviso.
 */
export const LAYA_SOFT_CHOICE_OPTIONS = 20;

/** Jev: «max 255» opciones por `choice` (docs.typesafe.ai/api.md). */
export const JEV_MAX_CHOICE_OPTIONS = 255;

/** Tolerancia para comparar el `score` del proveedor con el recalculado. */
const SCORE_TOLERANCE = 0.02;

export interface SystemOneWarning {
  readonly code: "choice_options_over_soft_limit";
  readonly questionId: string;
  readonly options: number;
  readonly softLimit: number;
}

/** Lo que `DATA-033` necesita para guardar la respuesta cruda. Sin el pedido. */
export interface SystemOneRawResponse {
  readonly decisionPoint: DecisionPoint;
  readonly questionIds: readonly string[];
  /** El cuerpo de la respuesta tal cual llegó. */
  readonly raw: string;
  /** Lo que el proveedor dijo que respondió (Laya: `laya-rl-agent/<checkpoint>`). */
  readonly model: string;
  readonly usage: JudgmentUsage;
}

export interface SystemOneJudgmentOptions {
  /** Sin `/v1/systemone`: la base, p. ej. `http://127.0.0.1:3006`. */
  readonly baseUrl: string;
  /** Vacía o ausente = sin `Authorization` (Laya local). */
  readonly apiKey?: string;
  /**
   * El modelo a pedir. En Laya, `auto` = no mandar `model` y dejar que el
   * router elija checkpoint por idioma (`serve.py`, `_resolve_model`).
   */
  readonly model: string;
  /** `DATA-033.adapter`: `laya` o `jev`. */
  readonly adapter: string;
  /** Tope duro por `choice`. Default {@link LAYA_MAX_CHOICE_OPTIONS}. */
  readonly maxChoiceOptions?: number;
  /** Aviso por encima de esto. `null` = sin aviso. Default {@link LAYA_SOFT_CHOICE_OPTIONS}. */
  readonly softChoiceOptions?: number | null;
  readonly defaultTimeoutMs?: number;
  readonly fetch?: SystemOneFetch;
  readonly onWarning?: (warning: SystemOneWarning) => void;
  /** Ver la regla 3 de §9.15.3: sin esto, las respuestas crudas se pierden. */
  readonly onRawResponse?: (response: SystemOneRawResponse) => void;
  /** Sólo tests. */
  readonly nowMs?: () => number;
}

/** El modelo de Laya que significa «que elija el router». */
export const LAYA_AUTO_MODEL = "auto";

export class SystemOneJudgmentAdapter implements Judgment {
  readonly provenance: JudgmentProvenance;
  readonly #options: SystemOneJudgmentOptions;
  readonly #source: string;
  readonly #endpoint: string;

  constructor(options: SystemOneJudgmentOptions) {
    this.#options = options;
    this.#source = `Judgment/${options.adapter}`;
    this.#endpoint = systemOneEndpoint(options.baseUrl);
    this.provenance = { adapter: options.adapter, model: options.model };
  }

  async choice<TOption extends string>(
    request: ChoiceRequest<TOption>,
  ): Promise<JudgmentOutcome<ChoiceAnswer<TOption>>> {
    assertTimeout(request.timeoutMs, this.#source);
    assertChoice(request.question, this.#source);
    const { answers, usage } = await this.#run(request, [request.question]);
    return {
      answer: this.#pick<ChoiceAnswer<TOption>>(answers, request.question.id, "choice"),
      usage,
    };
  }

  async score(request: ScoreRequest): Promise<JudgmentOutcome<ScoreAnswer>> {
    assertTimeout(request.timeoutMs, this.#source);
    assertScore(request.question, this.#source);
    const { answers, usage } = await this.#run(request, [request.question]);
    return {
      answer: this.#pick<ScoreAnswer>(answers, request.question.id, "score"),
      usage,
    };
  }

  async noul(request: NoulRequest): Promise<JudgmentOutcome<NoulAnswer>> {
    assertTimeout(request.timeoutMs, this.#source);
    assertNoul(request.question, this.#source);
    const { answers, usage } = await this.#run(request, [request.question]);
    return {
      answer: this.#pick<NoulAnswer>(answers, request.question.id, "noul"),
      usage,
    };
  }

  async ask<const Q extends readonly JudgmentQuestion[]>(
    request: AskRequest<Q>,
  ): Promise<JudgmentBatchOutcome<Q>> {
    assertTimeout(request.timeoutMs, this.#source);
    assertBatch(request.questions, this.#source);
    const { answers, usage } = await this.#run(request, request.questions);
    return { answers: answers as AnswersFor<Q>, usage };
  }

  /* -------------------------------------------------------------------- */

  async #run(
    request: {
      readonly decisionPoint: DecisionPoint;
      readonly state: JudgmentState;
      readonly timeoutMs?: number;
    },
    questions: readonly JudgmentQuestion[],
  ): Promise<{ answers: Record<string, JudgmentAnswer>; usage: JudgmentUsage }> {
    this.#checkLimits(questions);
    // Mismo orden por id que el adaptador LLM: el pedido es idéntico byte a
    // byte sin importar el orden del llamador (§9.15.1, preguntas independientes).
    const sorted = [...questions].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const body: Record<string, unknown> = {
      state: request.state,
      questions: Object.fromEntries(sorted.map((q) => [q.id, wireQuestion(q)])),
    };
    if (this.#options.model !== LAYA_AUTO_MODEL) body["model"] = this.#options.model;

    const now = this.#options.nowMs ?? Date.now;
    const started = now();
    const timeoutMs = request.timeoutMs ?? this.#options.defaultTimeoutMs;
    const raw = await this.#post(JSON.stringify(body), timeoutMs);
    const latencyMs = Math.max(0, now() - started);

    let root: unknown;
    try {
      root = JSON.parse(raw);
    } catch (cause) {
      throw this.#violation("the response is not JSON", cause);
    }
    if (!isRecord(root)) throw this.#violation("the response is not an object");
    const usageNode = isRecord(root["usage"]) ? root["usage"] : {};
    const usage: JudgmentUsage = {
      latencyMs,
      ...(isCount(usageNode["input_tokens"])
        ? { inputTokens: usageNode["input_tokens"] }
        : {}),
      ...(isCount(usageNode["output_tokens"])
        ? { outputTokens: usageNode["output_tokens"] }
        : {}),
    };

    this.#options.onRawResponse?.({
      decisionPoint: request.decisionPoint,
      questionIds: sorted.map((q) => q.id),
      raw,
      model: reportedModel(root, this.#options.model),
      usage,
    });

    const byId = root["answers"];
    if (!isRecord(byId)) throw this.#violation("the response has no answers");
    const answers: Record<string, JudgmentAnswer> = {};
    for (const question of sorted) {
      answers[question.id] = this.#decode(question, byId[question.id]);
    }
    return { answers, usage };
  }

  #checkLimits(questions: readonly JudgmentQuestion[]): void {
    const hard = this.#options.maxChoiceOptions ?? LAYA_MAX_CHOICE_OPTIONS;
    const soft =
      this.#options.softChoiceOptions === undefined
        ? LAYA_SOFT_CHOICE_OPTIONS
        : this.#options.softChoiceOptions;
    for (const q of questions) {
      if (q.kind !== "choice") continue;
      const n = Object.keys(q.criteria).length;
      if (n > hard) {
        throw new PortError(
          "bad_request",
          `choice question "${q.id}" has ${String(n)} options; this judgment engine takes at most ${String(hard)}`,
          { source: this.#source },
        );
      }
      if (soft !== null && n > soft) {
        this.#options.onWarning?.({
          code: "choice_options_over_soft_limit",
          questionId: q.id,
          options: n,
          softLimit: soft,
        });
      }
    }
  }

  async #post(body: string, timeoutMs: number | undefined): Promise<string> {
    const doFetch = this.#options.fetch ?? ((input, init) => fetch(input, init));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    const key = this.#options.apiKey?.trim() ?? "";
    if (key !== "") headers["authorization"] = `Bearer ${key}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
    try {
      let response: Response;
      try {
        response = await doFetch(this.#endpoint, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
      } catch (cause) {
        if (timedOut) {
          throw new PortError(
            "timeout",
            `The judgment engine did not answer within ${String(timeoutMs)} ms`,
            { source: this.#source, cause },
          );
        }
        throw new PortError(
          "provider_unavailable",
          "Could not reach the judgment engine",
          {
            source: this.#source,
            cause,
          },
        );
      }
      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        if (timedOut) {
          throw new PortError(
            "timeout",
            `The judgment engine did not answer within ${String(timeoutMs)} ms`,
            { source: this.#source, cause },
          );
        }
        throw new PortError(
          "provider_unavailable",
          "The judgment engine dropped the response",
          { source: this.#source, cause },
        );
      }
      if (!response.ok) throw this.#httpError(response, text);
      return text;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * HTTP → código estable. El cuerpo del proveedor va sólo en `cause` (para el
   * log de quien llama), nunca en el mensaje: el mensaje puede cruzar hacia la
   * web por `toPublic()`.
   */
  #httpError(response: Response, body: string): PortError {
    const status = response.status;
    const cause = { status, body: body.slice(0, 500) };
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    const withRetry = retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter };
    const source = this.#source;
    if (status === 401 || status === 403) {
      return new PortError("unauthorized", "The judgment engine rejected the API key", {
        source,
        cause,
      });
    }
    if (status === 402) {
      return new PortError(
        "quota_exceeded",
        "The judgment engine account is out of credit",
        {
          source,
          cause,
        },
      );
    }
    if (status === 404) {
      return new PortError(
        "not_found",
        "The judgment engine has no /v1/systemone at that base URL",
        { source, cause },
      );
    }
    if (
      status === 429 ||
      status === 529 ||
      (status === 503 && retryAfter !== undefined)
    ) {
      // 429 (Jev: límite), 529 (Jev: sobrecargado) y 503 con `Retry-After`
      // (Laya: más de `LAYA_MAX_CONCURRENT` pedidos a la vez) son la misma
      // cosa para quien llama: esperar y reintentar, no «está caído».
      return new PortError("rate_limited", "The judgment engine is busy", {
        source,
        cause,
        ...withRetry,
      });
    }
    if (status === 400 || status === 413 || status === 422) {
      // 413: Laya rechaza por tamaño (preguntas, opciones, estado); 422: la
      // pregunta no pasó su validación (p. ej. no entra en la ventana).
      return new PortError("bad_request", "The judgment engine rejected the question", {
        source,
        cause,
      });
    }
    if (status === 408 || status === 504) {
      return new PortError("timeout", "The judgment engine timed out", { source, cause });
    }
    return new PortError(
      "provider_unavailable",
      `The judgment engine failed (HTTP ${String(status)})`,
      { source, cause },
    );
  }

  /* -------------------------------------------------------------------- */

  #decode(question: JudgmentQuestion, value: unknown): JudgmentAnswer {
    if (!isRecord(value)) {
      throw this.#violation(`missing answer for question "${question.id}"`);
    }
    if (value["type"] !== undefined && value["type"] !== question.kind) {
      throw this.#violation(
        `"${question.id}" came back as ${JSON.stringify(value["type"])}, asked ${question.kind}`,
      );
    }
    switch (question.kind) {
      case "choice":
        return this.#decodeChoice(question, value);
      case "score":
        return this.#decodeScore(question, value);
      case "noul":
        return this.#decodeNoul(question, value);
      default: {
        const unknown: never = question;
        throw this.#violation(`unknown question kind: ${JSON.stringify(unknown)}`);
      }
    }
  }

  #decodeChoice(question: ChoiceQuestion, node: Record<string, unknown>): ChoiceAnswer {
    const options = Object.keys(question.criteria);
    const reported = node["choice"];
    if (typeof reported !== "string" || !options.includes(reported)) {
      throw this.#violation(`"${question.id}" chose an option that was not offered`);
    }
    const source = node["probabilities"];
    if (!isRecord(source)) {
      throw this.#violation(
        `"${question.id}" came back without a probability distribution`,
      );
    }
    for (const key of Object.keys(source)) {
      if (!options.includes(key)) {
        throw this.#violation(`"${question.id}" has a probability for an unknown option`);
      }
    }
    const weights = options.map((o) => this.#probability(source[o], question.id, o));
    const probabilities = normalize(this.#someSignal(weights, question.id));
    const distribution: Record<string, number> = {};
    options.forEach((o, i) => {
      distribution[o] = probabilities[i] ?? 0;
    });
    // `value` es el argmax de la distribución, como en el adaptador LLM: el
    // contrato lo exige y el redondeo a 4 decimales de Laya puede empatar.
    const winner = options[argmaxIndex(probabilities)];
    if (winner === undefined) throw this.#violation(`"${question.id}" has no options`);
    return {
      kind: "choice",
      value: winner,
      probabilities: distribution,
      confidence: answerConfidence(node, probabilities),
    };
  }

  #decodeScore(question: ScoreQuestion, node: Record<string, unknown>): ScoreAnswer {
    const n = question.levels.length;
    const source = node["probabilities"];
    let weights: number[];
    if (Array.isArray(source)) {
      if (source.length !== n) {
        throw this.#violation(
          `"${question.id}" came back with ${String(source.length)} probabilities for ${String(n)} levels`,
        );
      }
      weights = source.map((v, i) =>
        this.#probability(v, question.id, `level ${String(i)}`),
      );
    } else if (isRecord(source)) {
      // 0-based: `"0"` es `levels[0]`.
      const keys = Object.keys(source);
      if (keys.length !== n || keys.some((k) => !/^\d+$/.test(k) || Number(k) >= n)) {
        throw this.#violation(
          `"${question.id}" came back with levels that do not match the ${String(n)} asked`,
        );
      }
      weights = Array.from({ length: n }, (_, i) =>
        this.#probability(source[String(i)], question.id, `level ${String(i)}`),
      );
    } else {
      throw this.#violation(
        `"${question.id}" came back without a probability distribution`,
      );
    }
    const legend = node["legend"];
    if (isRecord(legend) && Object.keys(legend).length !== n) {
      throw this.#violation(`"${question.id}" was scored on a different scale`);
    }
    const probabilities = normalize(this.#someSignal(weights, question.id));
    const value = weightedLevel(probabilities);
    const reported = node["score"];
    if (reported !== undefined) {
      // El `score` del proveedor es 0-based; el del puerto, 1-based.
      if (
        typeof reported !== "number" ||
        !Number.isFinite(reported) ||
        Math.abs(reported + 1 - value) > SCORE_TOLERANCE * n
      ) {
        throw this.#violation(
          `"${question.id}" reported a score outside its distribution`,
        );
      }
    }
    return {
      kind: "score",
      value,
      probabilities,
      confidence: answerConfidence(node, probabilities),
    };
  }

  #decodeNoul(question: NoulQuestion, node: Record<string, unknown>): NoulAnswer {
    const p = node["noul"];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw this.#violation(`"${question.id}" returned an invalid noul probability`);
    }
    return { kind: "noul", probability: p };
  }

  #probability(value: unknown, questionId: string, what: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw this.#violation(
        `"${questionId}" returned an invalid probability for ${what}`,
      );
    }
    return value;
  }

  #someSignal(weights: readonly number[], questionId: string): readonly number[] {
    if (weights.reduce((a, b) => a + b, 0) <= 0) {
      throw this.#violation(`"${questionId}" returned an all-zero distribution`);
    }
    return weights;
  }

  #violation(message: string, cause?: unknown): PortError {
    return new PortError(
      "provider_contract_violation",
      `The judgment engine broke its contract: ${message}`,
      { source: this.#source, ...(cause === undefined ? {} : { cause }) },
    );
  }

  #pick<T extends JudgmentAnswer>(
    answers: Record<string, JudgmentAnswer>,
    id: string,
    kind: T["kind"],
  ): T {
    const answer = answers[id];
    if (answer === undefined || answer.kind !== kind) {
      throw this.#violation(`missing ${kind} answer for "${id}"`);
    }
    return answer as T;
  }
}

/* ------------------------------------------------------------------------ *
 * Auxiliares
 * ------------------------------------------------------------------------ */

/** `{base}/v1/systemone`. La base se guarda sin la ruta (como la escribe el preset). */
export function systemOneEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/systemone` : `${base}/v1/systemone`;
}

function wireQuestion(question: JudgmentQuestion): Record<string, unknown> {
  switch (question.kind) {
    case "choice":
      return {
        type: "choice",
        instructions: question.instructions,
        criteria: { ...question.criteria },
      };
    case "score":
      return {
        type: "score",
        instructions: question.instructions,
        criteria: [...question.levels],
      };
    case "noul":
      return {
        type: "noul",
        instructions: question.instructions,
        criteria: { true: question.criteria.true, false: question.criteria.false },
      };
    default: {
      const unknown: never = question;
      throw new PortError(
        "bad_request",
        `unknown question kind: ${JSON.stringify(unknown)}`,
        {
          source: "Judgment/systemone",
        },
      );
    }
  }
}

/** Ver la cabecera, regla 2: `answer_confidence` = `max(p)`, o se calcula. */
function answerConfidence(
  node: Record<string, unknown>,
  probabilities: readonly number[],
) {
  const reported = node["answer_confidence"];
  if (
    typeof reported === "number" &&
    Number.isFinite(reported) &&
    reported >= 0 &&
    reported <= 1
  ) {
    return reported;
  }
  return concentration(probabilities);
}

function reportedModel(root: Record<string, unknown>, configured: string): string {
  const model = typeof root["model"] === "string" ? root["model"] : configured;
  const routing = root["routing"];
  if (isRecord(routing) && typeof routing["model"] === "string") {
    return `${model}/${routing["model"]}`;
  }
  return model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** `Retry-After`: segundos o fecha HTTP. `undefined` si no vino o no se entiende. */
export function parseRetryAfter(
  header: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}
