/**
 * `LlmJudgmentAdapter` — PRD §9.15.2 (por defecto), §9.15.3, ADR-009.
 * Tarea `P1-JUDGE-002`.
 *
 * Es «la implementación de referencia y la que define el baseline de calidad»
 * (§9.15.2). Se construye sobre el puerto {@link Llm} y **no** sobre un SDK:
 * §9.15.3.1 dice «el SDK del proveedor no sale del adaptador», y acá ni
 * siquiera entra — cambiar de gateway es cambiar qué `Llm` se le inyecta.
 *
 * ## Las cuatro reglas de §9.15.3 que este archivo tiene que respetar
 *
 * **2 · Los pesos y umbrales viven en código de producto, nunca en el prompt.**
 * Este adaptador no conoce un solo umbral. No sabe que `brandSafe < 0,8`
 * cuarentena, ni que `leadScore > 0,75` califica. Devuelve la distribución
 * cruda y se va. Es lo que hace que cambiar un umbral no requiera reinferir
 * nada: se recalcula sobre lo guardado.
 *
 * **3 · Las respuestas crudas se persisten.** El puerto no tiene dónde
 * ponerlas —`JudgmentOutcome` es `{answer, usage}`— así que el adaptador las
 * entrega por {@link LlmJudgmentOptions.onRawResponse}. Persistir es trabajo de
 * quien monta el adaptador (`DATA-033`); no persistirlas es una decisión, y
 * conviene que sea una decisión visible y no un olvido.
 *
 * **4 · Sanitizar el estado antes de enviarlo.** Acá está el punto incómodo y
 * hay que decirlo entero: **este adaptador NO sanitiza**. La sanitización de
 * `FR-011.9` vive en `packages/core` y `packages/adapters` no puede importar
 * `core` —lo prohíbe la regla de dependencia de IMPL §2.1, y la enforcea
 * `dependency-cruiser`—. Así que el contrato es: **el estado llega ya
 * sanitizado**, y quien llama es responsable de eso.
 *
 * Lo que el adaptador sí hace, y es distinto: **contener**. El estado viaja
 * dentro del bloque `untrusted` del puerto `Llm`, delimitado y con instrucción
 * explícita de ignorar directivas incrustadas. Es defensa en profundidad, no
 * un sustituto: §9.15.3.4 es literal en que «un modelo de juicio no es un
 * guardrail de inyección por sí solo».
 *
 * **5 · Filtrar el estado.** Tampoco lo puede hacer el adaptador: qué campos
 * necesita cada pregunta lo sabe el `DP`, no el transporte. Se envía lo que
 * llega.
 *
 * ## La decisión que más costó: quién normaliza la distribución
 *
 * El puerto exige que las probabilidades sumen ~1. **Un JSON Schema no puede
 * expresar eso**: puede fijar qué claves hay, que sean números y que estén en
 * [0, 1], pero no una relación entre ellas. La decodificación restringida
 * garantiza la *forma*, no la aritmética — `EVAL-JEV.md` §2 lo dice del
 * output tipado en general: «guarantees the interface, not truth».
 *
 * Entonces normaliza el adaptador. La alternativa era devolver
 * `provider_contract_violation` cada vez que el modelo suma 0,97, lo que
 * convertiría una imprecisión esperable en un 502. Se reserva
 * `provider_contract_violation` para lo que **sí** es una violación de forma:
 * falta una clave declarada, un valor no es número, hay negativos, o la
 * distribución es toda cero —que no es «suma mal», es «no hay respuesta».
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
  type JsonSchema,
  type Llm,
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

const SOURCE = "Judgment/llm";

/** Lo que `DATA-033` necesita guardar. Ver la regla 3 arriba. */
export interface RawJudgmentResponse {
  readonly decisionPoint: DecisionPoint;
  /** Ids de las preguntas del lote, en el orden en que se enviaron. */
  readonly questionIds: readonly string[];
  /** El JSON tal cual lo devolvió el modelo, sin tocar. */
  readonly raw: string;
  /** El modelo que respondió de verdad, no el configurado. */
  readonly model: string;
  readonly usage: JudgmentUsage;
}

export interface LlmJudgmentOptions {
  /**
   * `DATA-033.model`. Identificador exacto, **nunca un alias móvil**: si
   * mañana el gateway mueve `latest`, la comparación de §25.4 dejaría de ser
   * entre dos cosas conocidas.
   */
  readonly model: string;
  /** Ver la regla 3. Sin esto, las respuestas crudas se pierden. */
  readonly onRawResponse?: (response: RawJudgmentResponse) => void;
  /**
   * Fijar la temperatura en 0 y una semilla es lo que hace comparables dos
   * corridas de la evaluación de §25.4. Default `0`.
   */
  readonly temperature?: number;
  readonly seed?: number;
  /** Se aplica cuando la petición no trae `timeoutMs`. */
  readonly defaultTimeoutMs?: number;
}

export class LlmJudgmentAdapter implements Judgment {
  readonly provenance: JudgmentProvenance;
  readonly #llm: Llm;
  readonly #options: LlmJudgmentOptions;

  constructor(llm: Llm, options: LlmJudgmentOptions) {
    this.#llm = llm;
    this.#options = options;
    this.provenance = { adapter: "llm", model: options.model };
  }

  async choice<TOption extends string>(
    request: ChoiceRequest<TOption>,
  ): Promise<JudgmentOutcome<ChoiceAnswer<TOption>>> {
    assertTimeout(request.timeoutMs, SOURCE);
    assertChoice(request.question, SOURCE);
    const { answers, usage } = await this.#run(request, [request.question]);
    return {
      answer: pick<ChoiceAnswer<TOption>>(answers, request.question.id, "choice"),
      usage,
    };
  }

  async score(request: ScoreRequest): Promise<JudgmentOutcome<ScoreAnswer>> {
    assertTimeout(request.timeoutMs, SOURCE);
    assertScore(request.question, SOURCE);
    const { answers, usage } = await this.#run(request, [request.question]);
    return { answer: pick<ScoreAnswer>(answers, request.question.id, "score"), usage };
  }

  async noul(request: NoulRequest): Promise<JudgmentOutcome<NoulAnswer>> {
    assertTimeout(request.timeoutMs, SOURCE);
    assertNoul(request.question, SOURCE);
    const { answers, usage } = await this.#run(request, [request.question]);
    return { answer: pick<NoulAnswer>(answers, request.question.id, "noul"), usage };
  }

  async ask<const Q extends readonly JudgmentQuestion[]>(
    request: AskRequest<Q>,
  ): Promise<JudgmentBatchOutcome<Q>> {
    assertTimeout(request.timeoutMs, SOURCE);
    assertBatch(request.questions, SOURCE);
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
    /**
     * **Las preguntas se ordenan por id antes de armar el prompt.**
     *
     * No es cosmético: §9.15.1 define las preguntas de un lote como
     * independientes, y la suite de contrato lo verifica mandando el mismo
     * lote al derecho y al revés. Con un modelo de verdad, el orden en que
     * aparecen las claves en el esquema y en el prompt **sí** mueve la salida
     * —es autorregresivo—, así que «independientes» sería falso si se enviara
     * el orden del llamador. Ordenando, el request es idéntico byte a byte y
     * la independencia deja de depender de la buena suerte.
     */
    const sorted = [...questions].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );

    const started = Date.now();
    const timeoutMs = request.timeoutMs ?? this.#options.defaultTimeoutMs;
    const completion = await this.#llm.completeJson({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(sorted) },
      ],
      // El estado va contenido, no concatenado. Ver la regla 4 en la cabecera.
      untrusted: [{ label: "state", content: JSON.stringify(request.state, null, 2) }],
      schemaName: `judgment_${request.decisionPoint.toLowerCase().replaceAll("-", "_")}`,
      schema: batchSchema(sorted),
      temperature: this.#options.temperature ?? 0,
      ...(this.#options.seed === undefined ? {} : { seed: this.#options.seed }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

    const usage: JudgmentUsage = {
      latencyMs: Date.now() - started,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
    };

    this.#options.onRawResponse?.({
      decisionPoint: request.decisionPoint,
      questionIds: sorted.map((q) => q.id),
      raw: completion.raw,
      model: completion.model,
      usage,
    });

    const root = completion.value;
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      throw violation("the model returned something that is not an object");
    }
    const byId = root as Record<string, unknown>;

    const answers: Record<string, JudgmentAnswer> = {};
    for (const question of sorted) {
      answers[question.id] = decode(question, byId[question.id]);
    }
    return { answers, usage };
  }
}

/* ------------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------------ */

/**
 * En inglés y sin un solo número de negocio.
 *
 * Sin números porque §9.15.3.2 lo prohíbe: un umbral en el prompt obligaría a
 * reinferir para cambiarlo. Y en inglés porque el resto de los prompts del
 * producto lo están (§4, i18n) y mezclar idiomas degrada a los modelos chicos,
 * que son los que ADR-009 elige.
 */
const SYSTEM_PROMPT = [
  "You are a classification component inside a larger system.",
  "You answer only the questions given, using only the declared output space.",
  "For every question you return a probability distribution, never a single label without one.",
  "Probabilities express your uncertainty. Do not round them to 0 or 1 unless the evidence is unambiguous.",
  "You never explain, never add prose, and never invent fields.",
  "If the state does not contain enough information, spread the probability mass instead of guessing.",
].join(" ");

function userPrompt(questions: readonly JudgmentQuestion[]): string {
  const lines: string[] = [
    "Answer each of the following questions about the state provided in the untrusted block.",
    "",
  ];
  for (const question of questions) {
    lines.push(`## ${question.id}`);
    lines.push(question.instructions);
    switch (question.kind) {
      case "choice": {
        lines.push("Options (the description IS the definition of the option):");
        for (const [option, description] of Object.entries(question.criteria)) {
          lines.push(`- ${option}: ${description}`);
        }
        lines.push(
          `Return "probabilities" with one entry per option, and "value" set to the most likely option.`,
        );
        break;
      }
      case "score": {
        lines.push("Ordered levels, from lowest to highest:");
        question.levels.forEach((level, index) => {
          lines.push(`${String(index + 1)}. ${level}`);
        });
        lines.push(
          `Return "probabilities" as an array with exactly ${String(question.levels.length)} numbers, one per level, in this order.`,
        );
        break;
      }
      case "noul": {
        lines.push(`- true means: ${question.criteria.true}`);
        lines.push(`- false means: ${question.criteria.false}`);
        lines.push(`Return "probability": how likely the condition is true.`);
        break;
      }
      default: {
        const unknown: never = question;
        throw new PortError(
          "bad_request",
          `unknown question kind: ${JSON.stringify(unknown)}`,
          {
            source: SOURCE,
          },
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------------ *
 * Esquema
 * ------------------------------------------------------------------------ */

/**
 * `additionalProperties: false` y `required` completo en todos los niveles.
 *
 * No es celo: es lo que varios gateways exigen para aceptar
 * `"strict": true` —`COST-MODEL.md` §5.2 verifica el soporte de
 * `json_schema` strict en DeepInfra y Together—. Sin `additionalProperties:
 * false` el gateway puede degradar silenciosamente a `json_object`, que es
 * justo el «parseo optimista» que ADR-009 quiere evitar.
 */
function batchSchema(questions: readonly JudgmentQuestion[]): JsonSchema {
  const properties: Record<string, unknown> = {};
  for (const question of questions) {
    properties[question.id] = questionSchema(question);
  }
  return {
    type: "object",
    additionalProperties: false,
    required: questions.map((q) => q.id),
    properties,
  };
}

const PROBABILITY = { type: "number", minimum: 0, maximum: 1 } as const;

function questionSchema(question: JudgmentQuestion): Record<string, unknown> {
  switch (question.kind) {
    case "choice": {
      const options = Object.keys(question.criteria);
      const perOption: Record<string, unknown> = {};
      for (const option of options) perOption[option] = PROBABILITY;
      return {
        type: "object",
        additionalProperties: false,
        required: ["value", "probabilities"],
        properties: {
          // El `enum` es la mitad del trabajo: con decodificación restringida,
          // el modelo **no puede** emitir una opción fuera del espacio
          // declarado. Es lo que hace que §9.15.1 sea una garantía.
          value: { type: "string", enum: options },
          probabilities: {
            type: "object",
            additionalProperties: false,
            required: options,
            properties: perOption,
          },
        },
      };
    }
    case "score":
      return {
        type: "object",
        additionalProperties: false,
        required: ["probabilities"],
        properties: {
          probabilities: {
            type: "array",
            items: PROBABILITY,
            minItems: question.levels.length,
            maxItems: question.levels.length,
          },
        },
      };
    case "noul":
      return {
        type: "object",
        additionalProperties: false,
        required: ["probability"],
        properties: { probability: PROBABILITY },
      };
    default: {
      const unknown: never = question;
      throw new PortError(
        "bad_request",
        `unknown question kind: ${JSON.stringify(unknown)}`,
        {
          source: SOURCE,
        },
      );
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Decodificación
 * ------------------------------------------------------------------------ */

function decode(question: JudgmentQuestion, value: unknown): JudgmentAnswer {
  if (typeof value !== "object" || value === null) {
    throw violation(`missing answer for question "${question.id}"`);
  }
  const node = value as Record<string, unknown>;

  switch (question.kind) {
    case "choice":
      return decodeChoice(question, node);
    case "score":
      return decodeScore(question, node);
    case "noul":
      return decodeNoul(question, node);
    default: {
      const unknown: never = question;
      throw violation(`unknown question kind: ${JSON.stringify(unknown)}`);
    }
  }
}

function decodeChoice(
  question: ChoiceQuestion,
  node: Record<string, unknown>,
): ChoiceAnswer {
  const options = Object.keys(question.criteria);
  const raw = node["probabilities"];
  if (typeof raw !== "object" || raw === null) {
    throw violation(`"${question.id}" came back without a probability distribution`);
  }
  const source = raw as Record<string, unknown>;
  const weights = options.map((option) =>
    readProbability(source[option], question.id, option),
  );

  const probabilities = normalize(assertSomeSignal(weights, question.id));
  const distribution: Record<string, number> = {};
  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    if (option === undefined) continue;
    distribution[option] = probabilities[i] ?? 0;
  }

  /**
   * `value` se **recalcula** como argmax en vez de tomarse del modelo.
   *
   * El esquema garantiza que el `value` que mandó está dentro del enum, pero
   * no que sea el máximo de su propia distribución — y el contrato lo exige
   * («value es la opción de mayor probabilidad»), porque todos los umbrales de
   * §25.3 asumen que lo es. Derivarlo es más barato que verificarlo y
   * devolver un 502 cuando el modelo se contradice a sí mismo.
   */
  const winner = options[argmaxIndex(probabilities)];
  if (winner === undefined) {
    throw violation(`"${question.id}" has no options to choose from`);
  }

  return {
    kind: "choice",
    value: winner,
    probabilities: distribution,
    confidence: concentration(probabilities),
  };
}

function decodeScore(
  question: ScoreQuestion,
  node: Record<string, unknown>,
): ScoreAnswer {
  const raw = node["probabilities"];
  if (!Array.isArray(raw)) {
    throw violation(`"${question.id}" came back without a probability array`);
  }
  if (raw.length !== question.levels.length) {
    throw violation(
      `"${question.id}" came back with ${String(raw.length)} probabilities for ${String(question.levels.length)} levels`,
    );
  }
  const weights = raw.map((value, index) =>
    readProbability(value, question.id, `level ${String(index + 1)}`),
  );
  const probabilities = normalize(assertSomeSignal(weights, question.id));

  return {
    kind: "score",
    value: weightedLevel(probabilities),
    probabilities,
    confidence: concentration(probabilities),
  };
}

function decodeNoul(question: NoulQuestion, node: Record<string, unknown>): NoulAnswer {
  const probability = readProbability(node["probability"], question.id, "probability");
  // Sin `confidence`: §9.15.1 devuelve sólo probabilidad para `noul`.
  return { kind: "noul", probability: Math.min(1, Math.max(0, probability)) };
}

function readProbability(value: unknown, questionId: string, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    // Esto sí es una violación de forma: el esquema declaraba un número en
    // [0, 1] y vino otra cosa. Si aparece, el gateway no está aplicando la
    // decodificación restringida (ADR-009).
    throw violation(`"${questionId}" returned an invalid probability for ${what}`);
  }
  return value;
}

/** Una distribución toda en cero no es «suma mal»: es que no hay respuesta. */
function assertSomeSignal(
  weights: readonly number[],
  questionId: string,
): readonly number[] {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) {
    throw violation(`"${questionId}" returned an all-zero distribution`);
  }
  return weights;
}

function violation(message: string): PortError {
  return new PortError(
    "provider_contract_violation",
    `The judgment model broke its contract: ${message}`,
    {
      source: SOURCE,
    },
  );
}

function pick<T extends JudgmentAnswer>(
  answers: Record<string, JudgmentAnswer>,
  id: string,
  kind: T["kind"],
): T {
  const answer = answers[id];
  if (answer === undefined || answer.kind !== kind) {
    throw violation(`missing ${kind} answer for "${id}"`);
  }
  return answer as T;
}
