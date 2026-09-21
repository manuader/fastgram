/**
 * Puerto Judgment — PRD §9.15 (EXT-008 · D-05), PRD §25, IMPL §2.1.
 *
 * La regla que lo obliga es literal: «todas esas decisiones pasan por un único
 * puerto. **Ningún módulo de producto llama a un proveedor de IA directamente
 * para decidir**» (§9.15). Y §9.15.3.1: «El SDK del proveedor no sale del
 * adaptador».
 *
 * El porqué de fondo está en `EVAL-JEV.md` §7 (riesgo R1): el proveedor
 * candidato tiene tres semanas de vida y su API ya tuvo un cambio de ruptura
 * (`jev-1.13.0` con guía de migración a v1). La mitigación aceptada fue
 * declarar este puerto el día 1, cuando cuesta un archivo, en vez de
 * retrofitearlo después, cuando es transversal.
 *
 * Tres reglas del contrato, todas de §9.15.1:
 *  1. El espacio de salida se declara de antemano. Lo que no se puede
 *     enumerar, no pasa por acá.
 *  2. Toda respuesta trae probabilidad. **El puerto no decide por el
 *     consumidor**: los umbrales de §25.3 viven en código de producto.
 *  3. El puerto no genera texto. Si hace falta prosa, es el puerto `Llm`.
 *
 * Y una que define la forma de la interfaz: la selección de adaptador es **por
 * punto de decisión**, no global (§9.15.2) — `DP-001` puede correr con un
 * adaptador mientras `DP-004` sigue con otro. Por eso `decisionPoint` viaja en
 * cada petición: es lo que el enrutador necesita para elegir, y sin eso
 * validar de a un `DP` (§25.4) sería imposible.
 *
 * **Lo que este puerto deliberadamente NO hace** (§25.2): aritmética, fechas,
 * ratios, cuotas, muestreo ponderado, parseo de URLs y generación de texto.
 * Si el resultado se puede calcular, buscar o enumerar con certeza, es código.
 *
 * Errores (`PortError`) que puede producir:
 *  - `timeout` — el adaptador no respondió dentro de `timeoutMs`. En cualquier
 *    uso síncrono el consumidor **debe** tener un fallback declarado
 *    (§9.15.3.7); para `DP-007` el PRD lo fija: si el pre-flight no responde,
 *    se publica igual (§25.3 JV-3).
 *  - `rate_limited` — con `retryAfterSeconds` si el proveedor lo dijo. Los
 *    límites del proveedor «se ajustan dinámicamente» (EVAL-JEV R8): el
 *    consumidor batch estira, no rompe.
 *  - `provider_unavailable`, `unauthorized`, `quota_exceeded`.
 *  - `bad_request` — la pregunta viola el contrato: menos de
 *    {@link MIN_SCORE_LEVELS} o más de {@link MAX_SCORE_LEVELS} niveles, más de
 *    {@link MAX_CHOICE_OPTIONS} opciones, `criteria` vacío, ids repetidos en un
 *    lote.
 *  - `provider_contract_violation` — el proveedor respondió fuera del espacio
 *    declarado, o con probabilidades que no suman ~1. Es el caso que la
 *    decodificación restringida por JSON-schema (ADR-009) debería hacer
 *    imposible; si aparece, el adaptador está roto, no el modelo.
 */

/**
 * Punto de decisión. Los literales son los de PRD §25.1 y `DATA-033`.
 * No hay `DP-008`…`DP-012`: existen en `EVAL-JEV.md` §3 como inventario, pero
 * el PRD sólo promovió siete.
 */
export const DECISION_POINTS = [
  /** Clasificación del catálogo de tendencias · `JV-1`. */
  "DP-001",
  /** Scoring de leads de Reddit · `JV-2`. */
  "DP-002",
  /** Tono de una respuesta, insumo del ban meter · `JV-5`. */
  "DP-003",
  /** Verificación de campos del perfil de marca · `JV-4`. */
  "DP-004",
  /** Selección de qué tendencia remixar · `JV-6`. */
  "DP-005",
  /** Normalización de errores de plataforma. Tabla determinística primero. */
  "DP-006",
  /** Pre-flight de publicación · `JV-3`. El único síncrono. */
  "DP-007",
] as const;

export type DecisionPoint = (typeof DECISION_POINTS)[number];

/**
 * Tope de opciones de un `choice`.
 *
 * No es un límite de negocio: es el mínimo común denominador entre
 * adaptadores (`EVAL-JEV.md` §6 — Choice tope 255 opciones). Si el puerto
 * aceptara más, un `DP` escrito contra el adaptador LLM dejaría de poder
 * correr contra los demás, que es exactamente lo que el puerto existe para
 * evitar.
 */
export const MAX_CHOICE_OPTIONS = 255;

/** `score` cubre 2–10 niveles (PRD §9.15.1). Fuera de ahí es `bad_request`. */
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

/* ------------------------------------------------------------------------ *
 * Estado
 * ------------------------------------------------------------------------ */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * El estado sobre el que se pregunta.
 *
 * Dos obligaciones del consumidor, ambas de §9.15.3, que el puerto no puede
 * verificar por él:
 *  - **Sanitizado** (regla 4). Todo texto de terceros —bios, captions, posts de
 *    Reddit— pasa por la sanitización de `FR-011.9` *antes* de llegar acá. El
 *    PRD es explícito: «un modelo de juicio no es un guardrail de inyección por
 *    sí solo».
 *  - **Filtrado** (regla 5). Sólo los campos que la pregunta necesita. Estado
 *    grande e irrelevante degrada la calidad y cuesta tokens — `JV-2` lo dice
 *    en concreto: no enviar el perfil de marca completo.
 *
 * `DATA-033` guarda `stateHash`, no el estado: hashearlo es trabajo de quien
 * persiste, no del puerto.
 */
export type JudgmentState = { readonly [field: string]: JsonValue };

/* ------------------------------------------------------------------------ *
 * Preguntas
 * ------------------------------------------------------------------------ */

/**
 * Una opción de un conjunto cerrado y enumerable (PRD §9.15.1).
 *
 * `criteria` es `id → descripción`: la descripción **es** la definición del
 * criterio y no un comentario. §25.3 `JV-1` lo dice del revés y vale la pena
 * leerlo así: «Tasa de cuarentena > 5 % ⇒ los `criteria` están mal escritos,
 * no el modelo».
 */
export interface ChoiceQuestion<
  TId extends string = string,
  TOption extends string = string,
> {
  readonly id: TId;
  readonly kind: "choice";
  /** Qué se pregunta, en una línea. */
  readonly instructions: string;
  /** Máx. {@link MAX_CHOICE_OPTIONS} entradas. Vacío es `bad_request`. */
  readonly criteria: { readonly [option in TOption]: string };
}

/**
 * Posición en una dimensión **ordenada** (PRD §9.15.1). El orden importa:
 * `levels[0]` es el extremo bajo. Ej. `JV-2` `buyingSignal`: `solo comenta` →
 * `frustrado con su solución actual` → `evaluando alternativas` → `pide
 * recomendación explícita`.
 */
export interface ScoreQuestion<TId extends string = string> {
  readonly id: TId;
  readonly kind: "score";
  readonly instructions: string;
  /**
   * Entre {@link MIN_SCORE_LEVELS} y {@link MAX_SCORE_LEVELS} descripciones, de
   * menor a mayor. El tipo fija el mínimo; el máximo lo valida el adaptador.
   */
  readonly levels: readonly [string, string, ...string[]];
}

/**
 * Si una condición se cumple o no. Devuelve sólo probabilidad (PRD §9.15.1).
 *
 * Se declaran **las dos** caras a propósito: escribir qué significa `false`
 * es la mitad del trabajo de definir la pregunta, y es lo que evita que
 * `remixable` y `brandSafe` terminen significando cosas distintas según quién
 * las lea.
 */
export interface NoulQuestion<TId extends string = string> {
  readonly id: TId;
  readonly kind: "noul";
  readonly instructions: string;
  readonly criteria: { readonly true: string; readonly false: string };
}

export type JudgmentQuestion =
  | ChoiceQuestion
  | ScoreQuestion
  | NoulQuestion;

/* ------------------------------------------------------------------------ *
 * Respuestas
 * ------------------------------------------------------------------------ */

export interface ChoiceAnswer<TOption extends string = string> {
  readonly kind: "choice";
  /** La opción de mayor probabilidad. Siempre una clave de `criteria`. */
  readonly value: TOption;
  /** Distribución completa sobre `criteria`. Suma ~1. */
  readonly probabilities: { readonly [option in TOption]: number };
  /** [0, 1]. Qué tan concentrada está la distribución. */
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly kind: "score";
  /**
   * Nivel ponderado por probabilidad, en `[1, levels.length]` — continuo, no
   * entero. El mapeo de `JV-4` (`specificity ≥ 2` sobre 3 niveles) está escrito
   * en ese espacio.
   *
   * **No normalizado a [0, 1].** El `leadScore` de `JV-2` mezcla scores con
   * nouls, así que alguien tiene que normalizar; ese alguien es código de
   * producto (§25.2: la aritmética no pasa por el puerto). Si el puerto
   * normalizara, el umbral `≥ 2` de `JV-4` dejaría de poder escribirse.
   */
  readonly value: number;
  /** Una probabilidad por nivel, en el orden de `levels`. Suma ~1. */
  readonly probabilities: readonly number[];
  readonly confidence: number;
}

export interface NoulAnswer {
  readonly kind: "noul";
  /**
   * [0, 1]. **Sin confianza aparte**, y no por olvido: el contrato de
   * §9.15.1 devuelve sólo `probability` para `noul`. Un campo `confidence`
   * opcional acá haría detectable qué adaptador respondió según si vino o no,
   * y el consumidor no puede saberlo (§9.15.2).
   */
  readonly probability: number;
}

export type JudgmentAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/** Deriva el tipo de respuesta a partir del tipo de la pregunta. */
export type AnswerFor<Q> = Q extends { readonly kind: "choice"; readonly criteria: infer C }
  ? ChoiceAnswer<Extract<keyof C, string>>
  : Q extends { readonly kind: "score" }
    ? ScoreAnswer
    : Q extends { readonly kind: "noul" }
      ? NoulAnswer
      : never;

/** `{ [id de la pregunta]: respuesta de su tipo }`. */
export type AnswersFor<Q extends readonly JudgmentQuestion[]> = {
  readonly [K in Q[number] as K["id"]]: AnswerFor<K>;
};

/* ------------------------------------------------------------------------ *
 * Coste y procedencia
 * ------------------------------------------------------------------------ */

/**
 * Lo que `DATA-033` necesita para que la comparación entre adaptadores (§25.4)
 * se haga con hechos: «`latencyMs` e `inputTokens` son los únicos datos que van
 * a permitir decidir con hechos en vez de con claims de fabricante».
 */
export interface JudgmentUsage {
  /** Medido por el adaptador, de extremo a extremo de la llamada. */
  readonly latencyMs: number;
  /** Ausente si el adaptador no lo reporta (p. ej. el stub de tests). */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * Quién respondió. Existe **sólo** para `DATA-033` y para el experimento de
 * §25.4, que compara adaptadores sobre exactamente el mismo estado.
 *
 * El código de producto puede loguearlo y persistirlo. **Ramificar sobre él
 * está prohibido**: es precisamente lo que el puerto existe para evitar.
 */
export interface JudgmentProvenance {
  /** `DATA-033`: `llm` | `jev` | `stub`. Abierto para no cerrar adaptadores. */
  readonly adapter: string;
  /** `DATA-033.model`. Ej. `jev-1.13.0`. Nunca un alias móvil. */
  readonly model: string;
}

/* ------------------------------------------------------------------------ *
 * Peticiones
 * ------------------------------------------------------------------------ */

interface JudgmentRequestBase {
  /** Para qué `DP` se pregunta. Es lo que permite elegir adaptador (§9.15.2). */
  readonly decisionPoint: DecisionPoint;
  /** Ya sanitizado y filtrado. Ver {@link JudgmentState}. */
  readonly state: JudgmentState;
  /**
   * §9.15.3.7: obligatorio en uso síncrono. Vencido, el adaptador lanza
   * `timeout` y el fallback lo aplica el consumidor — el puerto no puede
   * conocer el comportamiento por defecto de cada `DP`.
   */
  readonly timeoutMs?: number;
}

export interface ChoiceRequest<TOption extends string = string>
  extends JudgmentRequestBase {
  readonly question: ChoiceQuestion<string, TOption>;
}

export interface ScoreRequest extends JudgmentRequestBase {
  readonly question: ScoreQuestion;
}

export interface NoulRequest extends JudgmentRequestBase {
  readonly question: NoulQuestion;
}

export interface AskRequest<Q extends readonly JudgmentQuestion[]>
  extends JudgmentRequestBase {
  /** Ids únicos. Repetidos ⇒ `bad_request`. */
  readonly questions: Q;
}

export interface JudgmentOutcome<A extends JudgmentAnswer> {
  readonly answer: A;
  readonly usage: JudgmentUsage;
}

export interface JudgmentBatchOutcome<Q extends readonly JudgmentQuestion[]> {
  readonly answers: AnswersFor<Q>;
  /** Del lote entero, no por pregunta: es una sola llamada. */
  readonly usage: JudgmentUsage;
}

/* ------------------------------------------------------------------------ *
 * El puerto
 * ------------------------------------------------------------------------ */

export interface Judgment {
  /** Ver {@link JudgmentProvenance}: para persistir, no para decidir. */
  readonly provenance: JudgmentProvenance;

  choice<TOption extends string>(
    request: ChoiceRequest<TOption>,
  ): Promise<JudgmentOutcome<ChoiceAnswer<TOption>>>;

  score(request: ScoreRequest): Promise<JudgmentOutcome<ScoreAnswer>>;

  noul(request: NoulRequest): Promise<JudgmentOutcome<NoulAnswer>>;

  /**
   * Preguntas **independientes** sobre el mismo estado, en una sola llamada.
   *
   * `JV-1` hace exactamente esto: cinco preguntas de tres tipos distintos
   * sobre un item del catálogo, «una sola llamada, en paralelo». Independientes
   * quiere decir que la respuesta de una no condiciona a otra: quien necesite
   * encadenar, llama dos veces y compone en código.
   *
   * El parámetro `const` es para que `AnswersFor` conserve los ids y las
   * opciones sin obligar a escribir `as const` en cada llamada.
   */
  ask<const Q extends readonly JudgmentQuestion[]>(
    request: AskRequest<Q>,
  ): Promise<JudgmentBatchOutcome<Q>>;
}
