/**
 * Validación compartida por todos los adaptadores de `Judgment`.
 *
 * Vive acá y no dentro de cada adaptador por una razón del contrato, no de
 * DRY: PRD §9.15.2 dice que la selección de adaptador es **por punto de
 * decisión** y que el consumidor no puede saber cuál respondió. Si el stub
 * aceptara un `score` de 11 niveles y el adaptador LLM lo rechazara, mover un
 * `DP` de uno a otro cambiaría qué preguntas son válidas — y eso es
 * exactamente lo que el puerto existe para evitar.
 *
 * Todo lo de acá produce `bad_request`, que es lo que la suite de contrato
 * espera para una pregunta que viola el espacio declarado.
 */

import {
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  MIN_SCORE_LEVELS,
  PortError,
  type ChoiceQuestion,
  type JudgmentQuestion,
  type NoulQuestion,
  type ScoreQuestion,
} from "@fastgram/ports";

/**
 * Piso de `timeoutMs`.
 *
 * Por debajo de esto el adaptador responde `bad_request` en vez de fingir que
 * lo intentó: ni la validación local de la pregunta entra en un milisegundo, y
 * un `timeout` devuelto sin haber llamado a nadie le mentiría al fallback de
 * §9.15.3.7 —le haría creer que el proveedor no respondió cuando nunca se lo
 * consultó.
 *
 * El número es del adaptador, no del PRD: el PRD sólo exige que el timeout
 * exista y se respete. Está acá y no en cada adaptador porque §9.15.2 obliga a
 * que todos se comporten igual ante la misma petición.
 */
export const MIN_TIMEOUT_MS = 10;

function bad(message: string, source: string): PortError {
  return new PortError("bad_request", message, { source });
}

export function assertTimeout(timeoutMs: number | undefined, source: string): void {
  if (timeoutMs === undefined) return;
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS) {
    throw bad(`timeoutMs must be at least ${String(MIN_TIMEOUT_MS)} ms`, source);
  }
}

export function assertChoice(
  question: ChoiceQuestion,
  source: string,
): readonly string[] {
  const options = Object.keys(question.criteria);
  if (options.length === 0) {
    throw bad("choice question has no criteria", source);
  }
  if (options.length > MAX_CHOICE_OPTIONS) {
    throw bad(
      `choice question has ${String(options.length)} options, max is ${String(MAX_CHOICE_OPTIONS)}`,
      source,
    );
  }
  for (const option of options) {
    const description = question.criteria[option];
    if (typeof description !== "string" || description.length === 0) {
      // La descripción **es** la definición del criterio (§25.3 JV-1: una tasa
      // de cuarentena alta significa que los criteria están mal escritos). Una
      // opción sin descripción no es una opción, es un enum suelto.
      throw bad(`choice option "${option}" has no description`, source);
    }
  }
  if (question.instructions.length === 0) {
    throw bad("choice question has empty instructions", source);
  }
  return options;
}

export function assertScore(question: ScoreQuestion, source: string): readonly string[] {
  const levels = question.levels as readonly string[] | undefined;
  if (!Array.isArray(levels)) {
    throw bad("score question has no levels", source);
  }
  if (levels.length < MIN_SCORE_LEVELS) {
    throw bad(
      `score question has ${String(levels.length)} levels, min is ${String(MIN_SCORE_LEVELS)}`,
      source,
    );
  }
  if (levels.length > MAX_SCORE_LEVELS) {
    throw bad(
      `score question has ${String(levels.length)} levels, max is ${String(MAX_SCORE_LEVELS)}`,
      source,
    );
  }
  if (question.instructions.length === 0) {
    throw bad("score question has empty instructions", source);
  }
  return levels;
}

export function assertNoul(question: NoulQuestion, source: string): void {
  const { criteria } = question;
  if (typeof criteria.true !== "string" || criteria.true.length === 0) {
    throw bad("noul question has no description for `true`", source);
  }
  if (typeof criteria.false !== "string" || criteria.false.length === 0) {
    // Escribir qué significa `false` es la mitad del trabajo de definir la
    // pregunta. Ver el comentario de `NoulQuestion` en el puerto.
    throw bad("noul question has no description for `false`", source);
  }
  if (question.instructions.length === 0) {
    throw bad("noul question has empty instructions", source);
  }
}

export function assertQuestion(question: JudgmentQuestion, source: string): void {
  switch (question.kind) {
    case "choice":
      assertChoice(question, source);
      return;
    case "score":
      assertScore(question, source);
      return;
    case "noul":
      assertNoul(question, source);
      return;
    default: {
      const unknown: never = question;
      throw bad(`unknown question kind: ${JSON.stringify(unknown)}`, source);
    }
  }
}

export function assertBatch(
  questions: readonly JudgmentQuestion[],
  source: string,
): void {
  if (questions.length === 0) {
    throw bad("ask requires at least one question", source);
  }
  const seen = new Set<string>();
  for (const question of questions) {
    if (seen.has(question.id)) {
      // Sin esto la respuesta se pisaría a sí misma: `AnswersFor` indexa por id.
      throw bad(`duplicate question id in batch: "${question.id}"`, source);
    }
    seen.add(question.id);
    assertQuestion(question, source);
  }
}

/* ------------------------------------------------------------------------ *
 * Forma de la respuesta
 * ------------------------------------------------------------------------ */

/**
 * Normaliza a una distribución que suma 1 exactamente en el último elemento.
 *
 * El residuo se acumula en el último en vez de dividirse: la suite de contrato
 * usa una tolerancia de 1e-3, pero un lote de 255 opciones con error de
 * redondeo por opción se le puede acercar. Con esto la suma es exacta por
 * construcción.
 */
export function normalize(weights: readonly number[]): number[] {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0 || !Number.isFinite(total)) {
    // Uniforme: es lo único honesto cuando no hay señal.
    const share = 1 / weights.length;
    const flat = weights.map(() => share);
    return fixTail(flat);
  }
  return fixTail(weights.map((w) => Math.max(0, w) / total));
}

function fixTail(values: number[]): number[] {
  if (values.length === 0) return values;
  let sum = 0;
  for (let i = 0; i < values.length - 1; i += 1) sum += values[i] ?? 0;
  values[values.length - 1] = Math.max(0, Math.min(1, 1 - sum));
  return values;
}

/** Índice del máximo. Empata por el menor índice: estable y reproducible. */
export function argmaxIndex(values: readonly number[]): number {
  let best = 0;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] ?? Number.NEGATIVE_INFINITY;
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

/**
 * Nivel ponderado, en `[1, levels.length]`.
 *
 * **No normalizado a [0, 1]**, a propósito: el umbral `specificity ≥ 2` de
 * `JV-4` está escrito en este espacio. Ver `ScoreAnswer.value` en el puerto.
 */
export function weightedLevel(probabilities: readonly number[]): number {
  let value = 0;
  for (let i = 0; i < probabilities.length; i += 1) {
    value += (i + 1) * (probabilities[i] ?? 0);
  }
  // Clamp: acumular productos puede salirse por 1e-16 y `checkInRange` no
  // tiene tolerancia.
  return Math.min(Math.max(value, 1), probabilities.length);
}

/**
 * Confianza = qué tan concentrada está la distribución.
 *
 * Se usa el máximo y no la entropía porque el máximo ya está en [0, 1] sin
 * depender de cuántas opciones haya, y los umbrales de §25.3 comparan contra
 * constantes fijas que no pueden moverse según el tamaño del enum.
 */
export function concentration(probabilities: readonly number[]): number {
  return Math.min(1, Math.max(0, Math.max(...probabilities, 0)));
}
