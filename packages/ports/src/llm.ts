/**
 * Puerto Llm — IMPL ADR-009, PRD §11 (`AI-001`…`AI-016`), §25.2.
 *
 * Qué lo obliga: ADR-009 elige «un gateway compatible con la API de OpenAI,
 * apuntando a modelos de pesos abiertos» *precisamente* para que cambiar de
 * modelo sea una variable de entorno, y deja explícito que se pasa a vLLM
 * self-hosted «cuando el volumen lo justifique, no antes». Un cambio de
 * hosting que obligara a tocar `AI-001`, `AI-003` y `AI-004` no sería una
 * variable de entorno. Además ADR-009 y `P1-JUDGE-006` prohíben fijar modelos
 * y precios en el código: si el nombre del modelo estuviera incrustado en el
 * caso de uso, la evaluación fechada de `P1-JUDGE-006` no tendría dónde
 * aterrizar.
 *
 * La frontera con `Judgment` es la parte que no hay que borrar (PRD §9.15.1 y
 * §25.2): **este puerto genera texto y nada más**. Captions, hooks, ángulos,
 * `Improve`/`Regenerate`, `aiExplanation`, `Why this lead?`, la síntesis de
 * `AI-016`. Clasificar, puntuar y verificar va por `Judgment`, que es más
 * barato y trae probabilidad (IMPL §5, driver 4: «clasificar no necesita un
 * modelo generativo»).
 *
 * `completeJson` existe por ADR-009: el `LlmJudgmentAdapter` se construye
 * sobre **decodificación restringida por JSON-schema**, «que es lo que hace
 * que la salida tipada sea una garantía real y no un parseo optimista».
 *
 * Errores (`PortError`):
 *  - `rate_limited` (con `retryAfterSeconds`), `provider_unavailable`,
 *    `timeout`, `quota_exceeded`, `unauthorized`.
 *  - `bad_request` — prompt por encima de la ventana del modelo, `maxOutputTokens`
 *    fuera de rango, `schema` inválido.
 *  - `provider_contract_violation` — `completeJson` devolvió algo que no valida
 *    contra el `schema` pedido. Con decodificación restringida no debería
 *    ocurrir nunca; si ocurre, el gateway no la está aplicando.
 *
 * El filtro de contenido (`NFR-018`) **no** es un error: viaja como
 * `finishReason: "content_filter"`. `NFR-018` exige «mensajes diferenciados por
 * causa» y `PORT_ERROR_CODES` no tiene un código para esto; convertirlo en
 * excepción perdería la causa y obligaría a inventar un código.
 */

export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  readonly role: LlmRole;
  readonly content: string;
}

/**
 * Texto de terceros: bios, captions, posts de Reddit, HTML scrapeado.
 *
 * Es un parámetro propio y no algo que quien llama concatene dentro de un
 * `LlmMessage` porque `FR-011.9` / `AI-016` / §9.15.3.4 exigen que ese
 * material vaya «dentro de un contenedor claramente delimitado y con
 * instrucción explícita de ignorar cualquier directiva incrustada». Si
 * delimitar fuera responsabilidad de quien llama, se olvidaría una vez y esa
 * vez sería la que importa. Acá el adaptador es el único que decide cómo se
 * delimita, y hay un solo lugar que auditar.
 *
 * **No sustituye a la sanitización determinística**, que va antes y es
 * obligatoria (§25.2, última fila).
 */
export interface UntrustedBlock {
  /** Etiqueta del contenedor. Ej. `instagram_bio`, `reddit_post`. */
  readonly label: string;
  readonly content: string;
  /** De dónde salió, para la trazabilidad de `fieldMeta`. */
  readonly sourceRef?: string;
}

export interface LlmGenerationOptions {
  /**
   * Identificador de modelo del gateway. Opcional: el adaptador tiene un
   * default por configuración. Fijarlo acá es para reproducir una evaluación
   * (`P1-JUDGE-006`), no para el camino normal.
   */
  readonly model?: string;
  /** [0, 2]. */
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly stop?: readonly string[];
  readonly timeoutMs?: number;
  /**
   * Misma semilla + mismo prompt ⇒ misma salida, si el proveedor lo soporta.
   * Es lo que hace comparables dos corridas de una evaluación. Un proveedor
   * que lo ignore no rompe el contrato: lo refleja en
   * {@link LlmCompletion.deterministic}.
   */
  readonly seed?: number;
}

export interface LlmCompletionRequest extends LlmGenerationOptions {
  readonly messages: readonly LlmMessage[];
  readonly untrusted?: readonly UntrustedBlock[];
}

export interface LlmJsonRequest extends LlmGenerationOptions {
  readonly messages: readonly LlmMessage[];
  readonly untrusted?: readonly UntrustedBlock[];
  /**
   * JSON Schema (draft 2020-12) que el decodificador **restringe**, no sugiere.
   * Se declara como `JsonSchema` propio y no como un tipo de `zod` porque
   * `packages/ports` no importa npm: quien llama convierte su esquema de
   * `packages/contracts` a JSON Schema antes de bajar acá.
   */
  readonly schema: JsonSchema;
  /** Nombre del esquema. Algunos gateways lo exigen. */
  readonly schemaName: string;
}

/**
 * JSON Schema sin tipar en detalle, a propósito: tiparlo entero acá sería
 * mantener una copia de la especificación dentro del puerto, y la validación
 * real la hace el gateway.
 */
export type JsonSchema = { readonly [key: string]: unknown };

export type LlmFinishReason =
  /** Terminó solo. */
  | "stop"
  /** Cortado por `maxOutputTokens`. La salida está incompleta. */
  | "length"
  /** `NFR-018`. `content` puede venir vacío; `contentFilterCause` dice por qué. */
  | "content_filter";

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LlmCompletion {
  readonly text: string;
  readonly finishReason: LlmFinishReason;
  /**
   * Sólo con `finishReason: "content_filter"`. `NFR-018` pide mensajes
   * diferenciados por causa; el string es del proveedor normalizado por el
   * adaptador, y quien llama lo mapea a copy.
   */
  readonly contentFilterCause?: string;
  readonly usage: LlmUsage;
  /** Modelo que respondió de verdad. Va a `DATA-033.model` y a los logs. */
  readonly model: string;
  /** `false` si se pidió `seed` y el proveedor no la honró. */
  readonly deterministic: boolean;
  readonly latencyMs: number;
}

export interface LlmJsonCompletion extends Omit<LlmCompletion, "text"> {
  /**
   * `unknown` a propósito. El esquema garantiza la *forma*, no la verdad
   * —`EVAL-JEV.md` §2: «Typed output guarantees the interface, not truth»— y
   * el puerto no puede prometer un tipo que no validó. Quien llama parsea con
   * su esquema de `packages/contracts`.
   */
  readonly value: unknown;
  /** El JSON crudo, para el log y para reparseo si cambia el esquema. */
  readonly raw: string;
}

export interface Llm {
  /** Prosa. Todo `AI-00x` que escribe copy pasa por acá. */
  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;

  /** Salida estructurada con decodificación restringida por esquema (ADR-009). */
  completeJson(request: LlmJsonRequest): Promise<LlmJsonCompletion>;
}
