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
    description: "Backgrounds and slides. No adapter yet — config only.",
  },
  video: {
    title: "Video",
    description: "Clips and reactions. No adapter yet — config only.",
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
