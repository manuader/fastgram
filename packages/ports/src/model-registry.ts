/**
 * Puerto `ModelRegistry` — `PU-MODEL-001`, `docs/PLAN-USO-PERSONAL.md` §4, ADR-009.
 *
 * Qué lo obliga: ADR-009 dice que cambiar de modelo tiene que ser configuración,
 * y D-14 agrega que se elige **por tarea** (texto, juicio, imagen, video,
 * recorte de fondo) desde una pantalla. Hasta acá la única configuración eran
 * las cuatro `LLM_*` del entorno, que se leen una vez al arrancar: cambiar el
 * modelo exigía reiniciar el worker, y no había forma de tener un modelo para
 * captions y otro para juicios.
 *
 * El registro guarda **una configuración por tarea**. Dónde vive es del
 * adaptador (hoy un archivo local fuera del repo, `~/.fastgram/models.json`).
 *
 * ## Las API keys
 *
 * Este puerto sí devuelve la key en claro, porque el worker la necesita para
 * hablar con el proveedor. **Nunca cruza hacia afuera**: la API la reemplaza
 * por `hasKey` y los últimos cuatro caracteres (`packages/core/src/models`), y
 * ningún log la imprime. Si mañana aparece otro consumidor, la regla es la
 * misma que la de `PortError.cause`.
 *
 * ## Por qué no hay ids de modelo en ningún lado de este archivo
 *
 * ADR-009 y `P1-JUDGE-006`: los modelos cambian mes a mes. El id lo escribe el
 * usuario o lo elige de lo que el proveedor lista en `GET {baseUrl}/models`.
 */

/**
 * Las tareas. `text` y `judgment` tienen adaptador (`Llm` y
 * `LlmJudgmentAdapter`); el resto se guarda y todavía no lo consume nadie
 * (D-14: faltan los puertos `ImageGen`, `VideoGen` y `BackgroundRemoval`).
 */
export const MODEL_TASKS = [
  "text",
  "judgment",
  // `P1-JUDGE-004` (§9.15.2: el adaptador se elige **por punto de decisión**):
  // overrides opcionales de `judgment`. Sin entrada propia heredan `judgment`
  // (que a su vez hereda `text`). El piloto necesita un modelo más grande que
  // el resto; Engagement y la marca pueden quedarse con el barato.
  "judgment.autopilot",
  "judgment.brand",
  "judgment.engagement",
  "vision",
  "image",
  "video",
  "background_removal",
] as const;

export type ModelTask = (typeof MODEL_TASKS)[number];

/**
 * Los puntos de decisión con modelo propio opcional (`P1-JUDGE-004`). Cada uno
 * cae a `judgment` si no tiene entrada completa: agregar uno nunca apaga a
 * quien ya andaba con el modelo de juicio general.
 */
export const JUDGMENT_OVERRIDE_TASKS = [
  "judgment.autopilot",
  "judgment.brand",
  "judgment.engagement",
] as const;

export type JudgmentOverrideTask = (typeof JUDGMENT_OVERRIDE_TASKS)[number];

/** El juicio de un punto de decisión: el general o su override. */
export type JudgmentTask = "judgment" | JudgmentOverrideTask;

export function isJudgmentOverrideTask(task: string): task is JudgmentOverrideTask {
  return (JUDGMENT_OVERRIDE_TASKS as readonly string[]).includes(task);
}

/**
 * Proveedores de texto: **presets de endpoints compatibles con OpenAI**, más
 * `custom`. Un preset es sólo una base URL sugerida y si pide key; el
 * adaptador es el mismo para todos (`OpenAiCompatibleLlm`).
 */
export const MODEL_PROVIDERS = [
  "openrouter",
  "groq",
  "gemini",
  "cerebras",
  "deepseek",
  "ollama",
  "lmstudio",
  "custom",
  // `PU-MODEL-003`/`004`: imagen y video. No hablan la API de OpenAI: tienen
  // adaptador propio (`packages/adapters/src/{higgsfield,fal}`).
  "higgsfield",
  "fal",
  // `PU-LATER-003`: ComfyUI local (imagen y video). El «modelo» es un workflow
  // en formato API que el usuario exporta y guarda en `comfyWorkflow`.
  "comfyui",
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** Lo que se guarda por tarea. */
export interface ModelTaskConfig {
  readonly provider: ModelProvider;
  /** Base del endpoint compatible con OpenAI, **incluida** la versión (`…/v1`). */
  readonly baseUrl: string;
  /** Id de modelo tal como lo nombra el proveedor. Sin default: ver cabecera. */
  readonly model: string;
  /**
   * La key en claro, si se guardó en el archivo. Ausente = sin key guardada:
   * se usa `apiKeyEnv` si está, o se habla sin credencial (Ollama, LM Studio).
   */
  readonly apiKey?: string;
  /**
   * Nombre de una variable de entorno de la que sacar la key, para quien no la
   * quiere en el archivo. Gana `apiKey` si están las dos.
   */
  readonly apiKeyEnv?: string;
  /**
   * Ventana del modelo en tokens. `OpenAiCompatibleLlm` la exige y es una
   * propiedad del modelo, así que viaja con él. Sin default: sale de la ficha
   * del proveedor (o de lo que devuelva su `/models`, si la publica).
   */
  readonly contextWindowTokens?: number;
  /**
   * Sólo `comfyui` (`PU-LATER-003`): el workflow y qué inputs son el prompt,
   * el tamaño, la semilla y la imagen de entrada. Ausente en todo lo demás.
   */
  readonly comfyWorkflow?: ComfyWorkflowConfig;
  /** ISO-8601. La pone el adaptador al escribir. */
  readonly updatedAt?: string;
}

/** Un input de un nodo de un workflow de ComfyUI: `workflow[nodeId].inputs[input]`. */
export interface ComfyInputRef {
  readonly nodeId: string;
  readonly input: string;
}

/**
 * Un workflow de ComfyUI **en formato API** (el que exporta «Export (API)» y
 * que `POST /prompt` recibe en `prompt`): un objeto `{ [nodeId]: { class_type,
 * inputs } }`. Los ids de nodo son los del usuario, arbitrarios.
 *
 * Los `ComfyInputRef` dicen dónde inyectar cada cosa. Sólo `prompt` es
 * obligatorio; sin `width`/`height` el tamaño es el del workflow, sin `seed`
 * se repite la del workflow, y con `image` el workflow toma una imagen de
 * entrada (video: primer cuadro).
 */
export interface ComfyWorkflowConfig {
  readonly workflow: Readonly<Record<string, unknown>>;
  readonly prompt: ComfyInputRef;
  readonly width?: ComfyInputRef;
  readonly height?: ComfyInputRef;
  readonly seed?: ComfyInputRef;
  readonly image?: ComfyInputRef;
  /**
   * Sólo video: cuántos segundos produce el workflow. Lo declara el usuario
   * (el largo lo fija el workflow, no FastGram); sirve para la ficha y para la
   * duración de la media.
   */
  readonly durationSeconds?: number;
}

/** Todo el registro. Una tarea sin entrada = sin configurar. */
export interface ModelRegistrySnapshot {
  readonly tasks: Readonly<Partial<Record<ModelTask, ModelTaskConfig>>>;
}

export interface ModelRegistry {
  /**
   * El registro entero. Un registro que no existe todavía es `{ tasks: {} }`,
   * no un error: es el estado de una instalación nueva.
   *
   * Errores: `provider_contract_violation` si el archivo existe y no se puede
   * leer como registro (JSON roto, versión desconocida). No se «repara»
   * pisándolo: podría tener keys que el usuario no tiene en otro lado.
   */
  read(): Promise<ModelRegistrySnapshot>;

  /**
   * Reemplaza la configuración de una tarea; `null` la borra. Atómico: quien
   * lea en el medio ve el registro viejo o el nuevo, nunca uno a medio escribir.
   */
  write(task: ModelTask, config: ModelTaskConfig | null): Promise<void>;
}

/* ------------------------------------------------------------------------ *
 * Catálogo del proveedor: listar modelos y probar la conexión
 * ------------------------------------------------------------------------ */

/** Con qué hablarle a un endpoint compatible con OpenAI. */
export interface ModelEndpoint {
  readonly baseUrl: string;
  /** Vacía o ausente = sin `Authorization` (Ollama, LM Studio). */
  readonly apiKey?: string;
}

export interface ListedModel {
  readonly id: string;
  /**
   * Ventana en tokens, **sólo si el proveedor la publica** en `/models`
   * (OpenRouter la llama `context_length`, Groq `context_window`). Nunca se
   * inventa: ausente = el proveedor no la dice.
   */
  readonly contextWindowTokens?: number;
  readonly ownedBy?: string;
}

export interface ConnectionTestResult {
  /** Modelo que contestó, según el proveedor. */
  readonly model: string;
  readonly latencyMs: number;
}

/**
 * Errores (`PortError`), los mismos códigos que `Llm`: `unauthorized`,
 * `not_found` (el modelo o el endpoint no existen), `rate_limited`,
 * `quota_exceeded`, `timeout`, `provider_unavailable` (no se pudo conectar),
 * `bad_request` y `provider_contract_violation` (contestó algo que no es la
 * API de OpenAI).
 */
export interface ModelCatalog {
  /** `GET {baseUrl}/models`. */
  listModels(endpoint: ModelEndpoint): Promise<readonly ListedModel[]>;
  /** Una llamada mínima a `POST {baseUrl}/chat/completions` con `model`. */
  testConnection(
    endpoint: ModelEndpoint & { readonly model: string },
  ): Promise<ConnectionTestResult>;
}
