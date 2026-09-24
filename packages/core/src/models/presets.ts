/**
 * Presets de proveedores y qué tarea acepta qué — `PU-MODEL-001`,
 * `docs/PLAN-USO-PERSONAL.md` §4.
 *
 * Un preset es **una base URL sugerida y si pide key**. Nada más: todos hablan
 * la API de OpenAI y los atiende el mismo adaptador (`OpenAiCompatibleLlm`),
 * que es lo que ADR-009 compró al elegir un gateway compatible.
 *
 * ## Qué está verificado y qué no
 *
 * Las base URLs son las documentadas por cada proveedor para su endpoint
 * compatible con OpenAI, verificadas por el coordinador el 2026-09-24.
 * **DeepSeek no**: su base URL no se verificó, así que el preset va sin default
 * y el usuario la escribe. Poner una de memoria sería inventar un endpoint de
 * un tercero, y un default equivocado no falla: manda la key a otro lado.
 *
 * ## Por qué no hay ningún modelo
 *
 * ADR-009 y `P1-JUDGE-006`: los ids de modelo cambian mes a mes. El usuario lo
 * escribe o lo elige de lo que el proveedor lista en `GET {baseUrl}/models`.
 */
import type { ModelProvider, ModelTask } from "@fastgram/ports";

export interface ModelProviderPreset {
  readonly id: ModelProvider;
  /** Nombre para la UI. Es una marca, no copy: no se traduce. */
  readonly label: string;
  /**
   * Base URL por defecto, o `null` si no hay una verificada (`deepseek`) o no
   * tiene sentido (`custom`). Siempre editable.
   */
  readonly baseUrl: string | null;
  /** `false` = se puede hablar sin `Authorization` (servidores locales). */
  readonly requiresKey: boolean;
  /** Corre en la máquina del usuario. */
  readonly local: boolean;
  /**
   * Algo que el usuario tiene que saber antes de elegirlo, en inglés porque va
   * directo a la UI. Sólo hechos del plan (§4), nada de marketing.
   */
  readonly note?: string;
}

export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    local: false,
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    requiresKey: true,
    local: false,
  },
  {
    id: "gemini",
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    requiresKey: true,
    local: false,
    // PLAN-USO-PERSONAL §4: «tier gratis; los datos se usan para entrenar».
    note: "On the free tier, Google may use your prompts to train its models.",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    requiresKey: true,
    local: false,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    // Sin verificar: ver la cabecera.
    baseUrl: null,
    requiresKey: true,
    local: false,
    note: "Enter the base URL from DeepSeek's API docs.",
  },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    requiresKey: false,
    local: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    requiresKey: false,
    local: true,
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: null,
    // Puede o no pedirla: vLLM sin `--api-key` no la pide. La decide el usuario.
    requiresKey: false,
    local: false,
    note: "Any endpoint that speaks the OpenAI API (vLLM, a gateway, …).",
  },
];

export function providerPreset(id: ModelProvider): ModelProviderPreset {
  const preset = MODEL_PROVIDER_PRESETS.find((p) => p.id === id);
  // El array cubre el enum entero (lo fija un test): esto no puede pasar.
  if (preset === undefined) throw new Error(`model provider preset missing: ${id}`);
  return preset;
}

/**
 * Qué hace falta para usar cada tarea.
 *
 * - `llm`: habla la API de OpenAI (chat completions). `text` y `judgment`
 *   tienen adaptador hoy; `vision` se guarda y no lo consume nadie todavía.
 * - `reserved`: imagen, video y recorte de fondo. D-14 los quiere, pero sus
 *   puertos (`ImageGen`, `VideoGen`, `BackgroundRemoval`) no existen, y los
 *   proveedores del plan (Higgsfield, fal, ComfyUI) **no** son compatibles con
 *   OpenAI. Se guarda la configuración (`custom`: base URL, modelo, key) y nada
 *   más; ni se lista ni se prueba, porque no hay un protocolo que probar.
 */
export type ModelTaskKind = "llm" | "reserved";

export interface ModelTaskSpec {
  readonly task: ModelTask;
  readonly kind: ModelTaskKind;
  /** Hay un consumidor en el código que la usa hoy. */
  readonly wired: boolean;
  readonly providers: readonly ModelProvider[];
}

const LLM_PROVIDERS: readonly ModelProvider[] = MODEL_PROVIDER_PRESETS.map((p) => p.id);
const RESERVED_PROVIDERS: readonly ModelProvider[] = ["custom"];

export const MODEL_TASK_SPECS: readonly ModelTaskSpec[] = [
  { task: "text", kind: "llm", wired: true, providers: LLM_PROVIDERS },
  { task: "judgment", kind: "llm", wired: true, providers: LLM_PROVIDERS },
  { task: "vision", kind: "llm", wired: false, providers: LLM_PROVIDERS },
  { task: "image", kind: "reserved", wired: false, providers: RESERVED_PROVIDERS },
  { task: "video", kind: "reserved", wired: false, providers: RESERVED_PROVIDERS },
  {
    task: "background_removal",
    kind: "reserved",
    wired: false,
    providers: RESERVED_PROVIDERS,
  },
];

export function taskSpec(task: ModelTask): ModelTaskSpec {
  const spec = MODEL_TASK_SPECS.find((s) => s.task === task);
  if (spec === undefined) throw new Error(`model task spec missing: ${task}`);
  return spec;
}
