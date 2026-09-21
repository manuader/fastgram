/**
 * Persistencia de `JudgmentRecord` — `P1-JUDGE-005`, `DATA-033`, PRD §9.15 y §25.4.
 *
 * ## Qué faltaba
 *
 * Todas las piezas ya existían y ninguna se tocaba: el puerto devuelve
 * `JudgmentUsage` (`latencyMs`, `inputTokens`) y expone `provenance`, y la tabla
 * `judgment_records` tiene sus columnas y sus índices. Lo que no había era el
 * pedazo que los junta. Sin él, `DATA-033` describe una tabla que nadie escribe
 * y §25.4 —comparar adaptadores *"con hechos en vez de con claims de
 * fabricante"*— no tiene con qué.
 *
 * ## Por qué un decorador y no un método más del puerto
 *
 * Porque tiene que ser **sustituible**: `RecordingJudgment` implementa
 * `Judgment` y nada más, así que entra donde entraba el adaptador de abajo y
 * el código de producto no se entera. Si persistir fuera parte del puerto,
 * cada adaptador tendría que reimplementarlo, y el que se olvidara dejaría un
 * hueco en la tabla sin que nada fallara.
 *
 * ## Las tres decisiones que importan
 *
 * 1. **Un fallo al persistir no puede voltear el juicio.** Esto es
 *    observabilidad; perder un registro es malo, perder la decisión que el
 *    usuario está esperando es peor. Por eso el `record` va en un `catch` — y
 *    por eso hay `onError`: tragárselo en silencio convertiría una tabla vacía
 *    en un misterio en vez de en una alarma.
 *
 * 2. **Se guarda el hash del estado, nunca el estado.** El puerto ya lo dice:
 *    *"`DATA-033` guarda `stateHash`, no el estado: hashearlo es trabajo de
 *    quien persiste"*. No es sólo tamaño — el estado que llega a un juicio
 *    incluye texto de terceros (bios, comentarios, captions). Persistirlo
 *    haría de esta tabla un depósito permanente de contenido ajeno, y de cada
 *    consulta a la tabla una vía nueva para ese contenido.
 *
 * 3. **El hash es canónico.** `{a:1,b:2}` y `{b:2,a:1}` tienen que dar el
 *    mismo hash, porque §25.4 compara adaptadores **sobre el mismo estado** y
 *    la consulta es `(decisionPoint, stateHash)`. Con `JSON.stringify` pelado,
 *    dos llamadas con el mismo estado construido en distinto orden se verían
 *    como estados distintos y el experimento no encontraría los pares.
 */

import { createHash } from "node:crypto";
import type {
  AskRequest,
  ChoiceRequest,
  DecisionPoint,
  Judgment,
  JudgmentAnswer,
  JudgmentBatchOutcome,
  JudgmentOutcome,
  JudgmentProvenance,
  JudgmentQuestion,
  JudgmentState,
  JudgmentUsage,
  NoulRequest,
  ScoreRequest,
  ChoiceAnswer,
  NoulAnswer,
  ScoreAnswer,
} from "@fastgram/ports";

/** A qué se le aplicó el juicio. El puerto no lo sabe y no debería. */
export interface JudgmentSubject {
  readonly companyId: string;
  /**
   * `DATA-033.subjectType`. El PRD describe los sujetos en prosa (*"trending
   * item, lead, post, campo de perfil"*) pero **no fija literales**, así que
   * acá es un string libre igual que en el schema. Fijar la taxonomía va junto
   * con los `DP-00x`, no antes.
   */
  readonly subjectType: string;
  readonly subjectId?: string;
}

/** Una fila de `judgment_records` lista para escribir. */
export interface JudgmentRecordEntry {
  readonly companyId: string;
  readonly decisionPoint: DecisionPoint;
  readonly subjectType: string;
  readonly subjectId?: string;
  readonly adapter: string;
  readonly model: string;
  /** `questionId → respuesta`, tal cual la devolvió el adaptador. */
  readonly answers: { readonly [questionId: string]: JudgmentAnswer };
  readonly stateHash: string;
  readonly inputTokens?: number;
  readonly latencyMs: number;
}

/**
 * Dónde van los registros.
 *
 * Es una interfaz y no el repositorio directamente porque `packages/adapters`
 * no conoce `packages/db` —ni tiene por qué—, y porque así el worker puede
 * escribir por lote y los tests por memoria sin tocar esto.
 */
export interface JudgmentSink {
  record(entry: JudgmentRecordEntry): Promise<void>;
}

export interface RecordingJudgmentOptions {
  /**
   * Se llama cuando el sink falla. Sin esto, una tabla vacía no se distingue
   * de un sistema que no toma decisiones, y ése es el peor estado posible:
   * parece que todo anda.
   */
  readonly onError?: (error: unknown, entry: JudgmentRecordEntry) => void;
}

/**
 * Envuelve un `Judgment` y deja un `JudgmentRecord` por llamada.
 *
 * El sujeto va en el constructor y no en cada petición porque el puerto no
 * lleva `companyId` —es una abstracción semántica, no de tenencia— y meterlo
 * en las peticiones obligaría a cambiar los cuatro tipos de request y todos
 * los adaptadores. Quien juzga sobre un item construye un `RecordingJudgment`
 * para ese item; es una línea, y mantiene el puerto intacto.
 */
export class RecordingJudgment implements Judgment {
  readonly #inner: Judgment;
  readonly #sink: JudgmentSink;
  readonly #subject: JudgmentSubject;
  readonly #onError: ((error: unknown, entry: JudgmentRecordEntry) => void) | undefined;

  constructor(
    inner: Judgment,
    sink: JudgmentSink,
    subject: JudgmentSubject,
    options: RecordingJudgmentOptions = {},
  ) {
    this.#inner = inner;
    this.#sink = sink;
    this.#subject = subject;
    this.#onError = options.onError;
  }

  get provenance(): JudgmentProvenance {
    // Se delega en vez de copiarse: un adaptador que cambie de modelo en
    // caliente tiene que verse reflejado acá y en la fila que se escribe.
    return this.#inner.provenance;
  }

  async choice<TOption extends string>(
    request: ChoiceRequest<TOption>,
  ): Promise<JudgmentOutcome<ChoiceAnswer<TOption>>> {
    const outcome = await this.#inner.choice(request);
    await this.#write(request.decisionPoint, request.state, outcome.usage, {
      [request.question.id]: outcome.answer,
    });
    return outcome;
  }

  async score(request: ScoreRequest): Promise<JudgmentOutcome<ScoreAnswer>> {
    const outcome = await this.#inner.score(request);
    await this.#write(request.decisionPoint, request.state, outcome.usage, {
      [request.question.id]: outcome.answer,
    });
    return outcome;
  }

  async noul(request: NoulRequest): Promise<JudgmentOutcome<NoulAnswer>> {
    const outcome = await this.#inner.noul(request);
    await this.#write(request.decisionPoint, request.state, outcome.usage, {
      [request.question.id]: outcome.answer,
    });
    return outcome;
  }

  async ask<const Q extends readonly JudgmentQuestion[]>(
    request: AskRequest<Q>,
  ): Promise<JudgmentBatchOutcome<Q>> {
    const outcome = await this.#inner.ask(request);
    // Un lote es **una** llamada y por eso una sola fila, con todas las
    // respuestas juntas. Partirlo en N filas repartiría un `latencyMs` que no
    // es de ninguna pregunta en particular y multiplicaría por N el
    // `inputTokens` que se pagó una sola vez — justo los dos números que §25.4
    // usa para decidir.
    await this.#write(
      request.decisionPoint,
      request.state,
      outcome.usage,
      outcome.answers as { readonly [questionId: string]: JudgmentAnswer },
    );
    return outcome;
  }

  async #write(
    decisionPoint: DecisionPoint,
    state: JudgmentState,
    usage: JudgmentUsage,
    answers: { readonly [questionId: string]: JudgmentAnswer },
  ): Promise<void> {
    const { adapter, model } = this.#inner.provenance;
    const entry: JudgmentRecordEntry = {
      companyId: this.#subject.companyId,
      decisionPoint,
      subjectType: this.#subject.subjectType,
      ...(this.#subject.subjectId === undefined
        ? {}
        : { subjectId: this.#subject.subjectId }),
      adapter,
      model,
      answers,
      stateHash: hashState(state),
      ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
      latencyMs: usage.latencyMs,
    };

    try {
      await this.#sink.record(entry);
    } catch (error) {
      this.#onError?.(error, entry);
    }
  }
}

/**
 * SHA-256 sobre una serialización **canónica** del estado.
 *
 * Canónica quiere decir que el orden de las claves no cambia el resultado, a
 * cualquier profundidad. Es lo que hace comparable a `(decisionPoint,
 * stateHash)`: sin eso, el mismo estado armado en distinto orden —que es lo
 * normal, porque lo arman funciones distintas— daría hashes distintos y el
 * experimento de §25.4 no encontraría los pares que quiere comparar.
 *
 * El orden de los **arrays** sí se conserva: en un array el orden es dato.
 */
export function hashState(state: JudgmentState): string {
  return createHash("sha256").update(canonicalize(state)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` no existe en JSON y no puede cambiar el hash: un campo
    // ausente y uno presente en `undefined` son el mismo estado.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}
