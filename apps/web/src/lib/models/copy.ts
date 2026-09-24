/**
 * Copy de Settings → Models (`PU-MODEL-002`).
 *
 * Vive acá y no en el catálogo (`packages/ui/src/i18n` o
 * `lib/i18n/messages.ts`) porque esos archivos los está tocando otro agente en
 * este sprint. Mudarlo es mecánico: son claves planas en inglés, igual que el
 * catálogo. Hasta entonces la pantalla no pasa por `tw()`.
 */
import type { ModelProbeError, ModelTask } from "@fastgram/contracts";

export const TASK_COPY: Readonly<
  Record<ModelTask, { title: string; description: string }>
> = {
  text: {
    title: "Text",
    description: "Captions, content angles and brand profile synthesis.",
  },
  judgment: {
    title: "Judgment",
    description: "Scoring and yes/no checks with structured output.",
  },
  vision: {
    title: "Vision",
    description: "Tagging images and clips. Saved now, used once meme tagging lands.",
  },
  image: {
    title: "Image",
    description:
      "Backgrounds and slides for AI Studio, with Higgsfield, fal or your own ComfyUI.",
  },
  video: {
    title: "Video",
    description:
      "Background clips for AI Studio, with Higgsfield, fal or your own ComfyUI.",
  },
  background_removal: {
    title: "Background removal",
    description: "Cutting memes out of their background. No adapter yet — config only.",
  },
};

export const MODELS_COPY = {
  pageTitle: "Models",
  pageDescription:
    "Pick a provider and model for each task. Keys are stored on this machine only and are never shown again.",
  sectionActive: "In use",
  sectionReserved: "Coming next",
  sectionReservedHint:
    "These tasks have no adapter yet. You can save an endpoint now; nothing calls it until the feature ships.",
  emptyTitle: "No model configured yet",
  emptyBody:
    "Content generation waits for a text model. Start with Text — Ollama works offline and needs no key.",
  provider: "Provider",
  providerPlaceholder: "Choose a provider",
  baseUrl: "Base URL",
  baseUrlPlaceholder: "https://…/v1",
  apiKey: "API key",
  apiKeyPlaceholder: "Paste a key",
  apiKeyOptional: "Optional for local servers",
  apiKeySaved: (last4: string | null) =>
    last4 === null
      ? "Saved key — type to replace"
      : `Saved key ••••${last4} — type to replace`,
  apiKeyFromEnv: (envVar: string | null) =>
    envVar === null
      ? "Key comes from an environment variable"
      : `Key comes from ${envVar}`,
  removeKey: "Remove saved key",
  keepKey: "Keep saved key",
  keyWillBeDropped:
    "The base URL points to a different host, so the saved key won't be sent there. Paste a key for this host.",
  model: "Model",
  modelPlaceholder: "Model id, e.g. from the provider's docs",
  modelPick: "Choose a model",
  modelOther: "Other (type it)…",
  loadModels: "Load models",
  loadingModels: "Loading…",
  modelsLoaded: (n: number) =>
    n === 1 ? "1 model available" : `${String(n)} models available`,
  noModelsListed:
    "The provider returned no models. For Ollama, pull one first (ollama pull <model>).",
  contextWindow: "Context window (tokens)",
  contextWindowHint:
    "From the model's page. Filled in automatically when the provider publishes it.",
  test: "Test connection",
  testing: "Testing…",
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  reset: "Discard changes",
  testOk: (model: string, ms: number) =>
    `Connected — ${model} answered in ${String(ms)} ms`,
  listOkOnly: (n: number) =>
    `Reached the provider — ${n === 1 ? "1 model" : `${String(n)} models`} listed. Pick a model to test a call.`,
  status: {
    ready: "Ready",
    incomplete: "Incomplete",
    unset: "Not set",
  },
  usingEnv: "Running on the LLM_* environment variables.",
  usingEnvIncomplete:
    "This entry is incomplete, so the worker keeps using the LLM_* environment variables.",
  inherits: "Not set — uses the Text model.",
  missing: {
    apiKey: "API key",
    contextWindowTokens: "context window",
  },
  missingPrefix: "Missing: ",
  saveFailed: "Couldn't save.",
} as const;

export const PROBE_ERROR_COPY: Readonly<Record<ModelProbeError["code"], string>> = {
  unauthorized: "The provider rejected the API key.",
  forbidden: "The provider rejected the API key.",
  not_found:
    "The provider doesn't know that model or URL. Check the base URL and the model id.",
  rate_limited: "The provider is rate limiting requests. Try again in a moment.",
  quota_exceeded: "The provider account is out of credit.",
  timeout:
    "The provider didn't answer in time. Local models can take a while to load the first time — try again.",
  provider_unavailable:
    "Couldn't reach the provider. Is the URL right and the server running?",
  bad_request: "The provider rejected the request.",
  provider_contract_violation: "That URL doesn't answer like an OpenAI-compatible API.",
  conflict: "The provider rejected the request.",
};

/** La tarjeta del tope mensual (`PU-MODEL-005`). */
export const BUDGET_COPY = {
  title: "Monthly AI budget",
  description:
    "Image and video generations stop once this month's spend would pass the budget. Counted in UTC months.",
  label: "Budget (USD per month)",
  hint: "Whole dollars and cents, e.g. 30 or 42.50.",
  invalid: "Enter an amount between $0 and $100,000.",
  save: "Save budget",
  saving: "Saving…",
  saved: "Saved",
  reset: "Use default",
  source: {
    settings: "Set here.",
    env: "From FASTGRAM_MONTHLY_BUDGET_USD.",
    default: "Default ($30). Change it here.",
  },
  estimateNote:
    "Higgsfield quotes each generation for your account; fal uses the list price from the model page, so it's an estimate. ComfyUI runs on your machine and costs nothing.",
  error: "Couldn't load the budget.",
} as const;

/** El workflow de ComfyUI en las tarjetas de imagen y video (`PU-LATER-003`). */
export const COMFY_COPY = {
  modelLabel: "Workflow name",
  modelPlaceholder: "e.g. sdxl-basic",
  modelHint: "How this workflow shows up in AI Studio.",
  workflow: "Workflow (API format)",
  workflowHint:
    "In ComfyUI, export the workflow in API format and paste the JSON here, or load the file.",
  workflowPlaceholder: '{ "3": { "class_type": "KSampler", "inputs": { … } }, … }',
  loadFile: "Load .json file",
  fileError: "Couldn't read that file.",
  nodes: (n: number) => (n === 1 ? "1 node" : `${String(n)} nodes`),
  detected: "Detected automatically — check them before saving.",
  bindingsTitle: "Where FastGram writes each value",
  notSet: "— not set —",
  bindings: {
    prompt: "Prompt",
    width: "Width",
    height: "Height",
    seed: "Seed",
    image: "Start image",
  },
  bindingHints: {
    prompt: "Required. Usually the positive CLIPTextEncode text.",
    size: "Optional. Without them, the workflow's own size is used and the aspect ratio can't be picked.",
    seed: "Optional. A new random seed each run; without it every run repeats the same seed.",
    image: "Optional. The LoadImage input that receives the first frame.",
  },
  duration: "Clip length (seconds)",
  durationHint: "What this workflow produces — FastGram doesn't change it.",
  noInputs: "No plain inputs of this type in the workflow.",
} as const;
