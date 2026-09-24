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
  /*
   * `PU-MODEL-003`/`004`: imagen y video. **No** hablan la API de OpenAI:
   * cada uno tiene su adaptador (`packages/adapters/src/{higgsfield,fal}`).
   * Las bases son las documentadas: `https://api.higgsfield.ai`
   * (docs.higgsfield.ai/docs/authentication) y `https://queue.fal.run`
   * (fal.ai/docs/documentation/model-apis/inference/queue).
   */
  {
    id: "higgsfield",
    label: "Higgsfield",
    baseUrl: "https://api.higgsfield.ai",
    requiresKey: true,
    local: false,
    // docs.higgsfield.ai/docs/authentication: «Each credential consists of a
    // key ID and a secret», y viajan juntos en `Authorization: Key id:secret`.
    note: "Paste the credential as KEY_ID:KEY_SECRET (both parts, from console.higgsfield.ai).",
  },
  {
    id: "fal",
    label: "fal",
    baseUrl: "https://queue.fal.run",
    requiresKey: true,
    local: false,
    note: "Prices shown for fal are list prices from each model's page — an estimate.",
  },
  /*
   * `PU-LATER-003`: ComfyUI en la máquina del usuario. «The server runs at
   * http://127.0.0.1:8188 by default»
   * (https://docs.comfy.org/development/comfyui-server/comms_overview; el
   * ejemplo oficial `script_examples/websockets_api_example.py` usa
   * `server_address = "127.0.0.1:8188"`). Sin key: el servidor no la pide.
   * El «modelo» es un workflow en formato API (`comfyWorkflow`).
   */
  {
    id: "comfyui",
    label: "ComfyUI",
    baseUrl: "http://127.0.0.1:8188",
    requiresKey: false,
    local: true,
    note: "Runs on your own ComfyUI: no cost, no budget used. Paste a workflow exported in API format.",
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
 *   tienen adaptador hoy; `vision` la usa el etiquetado de clips (PU-MEME-003).
 * - `genai`: imagen y video (`PU-MODEL-003`/`004`) con los puertos `ImageGen`
 *   y `VideoGen`. Proveedores con adaptador propio (Higgsfield, fal); el
 *   modelo sale del catálogo verificado de cada adaptador.
 * - `reserved`: recorte de fondo. Se guarda la configuración (fal o `custom`:
 *   base URL, modelo, key); ni se lista ni se prueba. La usa el import de memes.
 */
export type ModelTaskKind = "llm" | "genai" | "reserved";

export interface ModelTaskSpec {
  readonly task: ModelTask;
  readonly kind: ModelTaskKind;
  /** Hay un consumidor en el código que la usa hoy. */
  readonly wired: boolean;
  readonly providers: readonly ModelProvider[];
}

/** Los de imagen y video: no hablan OpenAI, no sirven para texto. */
export const GENAI_PROVIDERS: readonly ModelProvider[] = ["higgsfield", "fal", "comfyui"];
const LLM_PROVIDERS: readonly ModelProvider[] = MODEL_PROVIDER_PRESETS.map(
  (p) => p.id,
).filter((id) => !GENAI_PROVIDERS.includes(id));
const RESERVED_PROVIDERS: readonly ModelProvider[] = ["custom"];
/** Voz, talking avatar y character swap: sólo fal tiene adaptador. */
const VOICE_PROVIDERS: readonly ModelProvider[] = ["fal"];

export const MODEL_TASK_SPECS: readonly ModelTaskSpec[] = [
  { task: "text", kind: "llm", wired: true, providers: LLM_PROVIDERS },
  { task: "judgment", kind: "llm", wired: true, providers: LLM_PROVIDERS },
  // `P1-JUDGE-004`: overrides por punto de decisión. Mismo adaptador que
  // `judgment`; sin entrada propia heredan de ahí (`resolveLlmConfig`).
  { task: "judgment.autopilot", kind: "llm", wired: true, providers: LLM_PROVIDERS },
  { task: "judgment.brand", kind: "llm", wired: true, providers: LLM_PROVIDERS },
  { task: "judgment.engagement", kind: "llm", wired: true, providers: LLM_PROVIDERS },
  { task: "vision", kind: "llm", wired: true, providers: LLM_PROVIDERS },
  { task: "image", kind: "genai", wired: true, providers: GENAI_PROVIDERS },
  { task: "video", kind: "genai", wired: true, providers: GENAI_PROVIDERS },
  {
    task: "background_removal",
    kind: "reserved",
    // PU-MEME-002: el worker recorta con fal BiRefNet cuando esta tarea apunta a
    // la cola de fal (`https://queue.fal.run`) con key; `custom` sigue sirviendo
    // para cualquier endpoint compatible.
    wired: true,
    providers: ["fal", ...RESERVED_PROVIDERS],
  },
  // Sprint 8 (agente L): formatos con voz. Sólo fal (el catálogo verificado de
  // `packages/adapters/src/genai/fal-voice-catalog.ts`). Sin key propia usan la
  // de otra tarea de fal del mismo origen (`resolveGenAiConfig`).
  { task: "speech", kind: "genai", wired: true, providers: VOICE_PROVIDERS },
  { task: "avatar", kind: "genai", wired: true, providers: VOICE_PROVIDERS },
  { task: "swap", kind: "genai", wired: true, providers: VOICE_PROVIDERS },
];

export function taskSpec(task: ModelTask): ModelTaskSpec {
  const spec = MODEL_TASK_SPECS.find((s) => s.task === task);
  if (spec === undefined) throw new Error(`model task spec missing: ${task}`);
  return spec;
}
