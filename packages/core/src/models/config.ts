/**
 * Registro de modelos por tarea: validar, fusionar, resolver y enmascarar —
 * `PU-MODEL-001`, `docs/PLAN-USO-PERSONAL.md` §4, ADR-009.
 *
 * Lógica pura. El archivo lo lee y escribe `packages/adapters/src/model-registry`,
 * la API la expone (`apps/api/src/routes/v1/models.ts`) y el worker la usa para
 * elegir con qué LLM hablar en cada job (`apps/worker/src/llm/`).
 *
 * ## Tres reglas que no se ven en los tipos
 *
 * 1. **La key nunca sale.** {@link toPublicTaskConfig} es el único camino hacia
 *    afuera y devuelve `hasKey` y los últimos cuatro caracteres, y ni eso si la
 *    key es tan corta que cuatro caracteres serían buena parte de ella.
 * 2. **Una key guardada no viaja a otro host.** Si una edición cambia el origen
 *    de la base URL y no trae key nueva, la guardada se descarta
 *    ({@link applyTaskUpdate}). Si no, pasar de OpenRouter a un endpoint
 *    `custom` mandaría la key de OpenRouter a ese tercero sin que nadie la
 *    haya vuelto a escribir. Lo mismo al probar con la key guardada
 *    ({@link storedKeyFor}).
 * 3. **Sin registro, nada cambia.** {@link resolveLlmConfig} usa el registro
 *    sólo si la tarea está completa ahí; si no, cae a las cuatro `LLM_*` del
 *    entorno, exactamente como antes de que existiera el registro.
 */
import {
  MODEL_PROVIDERS,
  MODEL_TASKS,
  type ModelProvider,
  type ModelRegistrySnapshot,
  type ModelTask,
  type ModelTaskConfig,
} from "@fastgram/ports";

import { providerPreset, taskSpec, type ModelTaskKind } from "./presets.js";

/** Topes de sanidad del input, no del producto. Ninguno es un número del PRD. */
const MAX_MODEL_ID_LENGTH = 256;
const MAX_BASE_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 1024;
/** Ninguna ventana publicada se acerca; es sólo para rechazar un typo de ceros. */
const MAX_CONTEXT_WINDOW_TOKENS = 100_000_000;
/** Con menos, cuatro caracteres serían una fracción grande de la key. */
const MIN_KEY_LENGTH_TO_SHOW_LAST4 = 12;

/** Mismo patrón que valida el archivo en `packages/adapters/src/model-registry`. */
export const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function isModelTask(value: string): value is ModelTask {
  return (MODEL_TASKS as readonly string[]).includes(value);
}

export function isModelProvider(value: string): value is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------------ *
 * URLs
 * ------------------------------------------------------------------------ */

export type BaseUrlCheck =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly message: string };

/**
 * Una base URL usable: `http(s)`, sin credenciales embebidas, sin query ni
 * fragmento. Se devuelve **tal como la escribió el usuario** (recortada): la de
 * Gemini termina en `/` y así figura en su documentación.
 *
 * Las credenciales en la URL se rechazan porque terminarían en el archivo,
 * en la respuesta de `GET /models` y en los logs, que es justo lo que el campo
 * de key existe para evitar.
 */
export function checkBaseUrl(raw: string): BaseUrlCheck {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, message: "Base URL is required." };
  if (value.length > MAX_BASE_URL_LENGTH) {
    return { ok: false, message: "Base URL is too long." };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "Base URL must be a full http:// or https:// URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "Base URL must start with http:// or https://." };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      message: "Put the API key in its own field, not inside the URL.",
    };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, message: "Base URL cannot have a query string or fragment." };
  }
  return { ok: true, baseUrl: value };
}

/**
 * `{baseUrl}/{path}` con la convención del SDK de OpenAI: la base **incluye**
 * la versión y se le pega el recurso. Es la que hace funcionar a Gemini
 * (`…/v1beta/openai/`) y a Groq (`…/openai/v1`).
 *
 * Ojo: `OpenAiCompatibleLlm` normaliza distinto (le agrega `/v1` a una base
 * que no termina en `/v1`), y con la de Gemini eso da una URL que no existe.
 * Por eso el worker, para lo que sale del registro, le fija el endpoint con
 * esta función (ver `apps/worker/src/llm/`).
 */
export function openAiEndpoint(
  baseUrl: string,
  path: "models" | "chat/completions",
): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/${path}`;
}

/** Mismo esquema, host y puerto. `false` si alguna no parsea. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a.trim()).origin === new URL(b.trim()).origin;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------------ */

export type KeySource = "file" | "env";

export interface ResolvedKey {
  readonly key: string;
  readonly source: KeySource;
  /** Sólo con `source: "env"`. */
  readonly envVar?: string;
}

/** Lo que el proceso ve de su entorno, para `apiKeyEnv`. */
export type SecretEnv = Readonly<Record<string, string | undefined>>;

/** La key de una entrada: la del archivo, o la de su variable de entorno. */
export function resolveApiKey(
  config: ModelTaskConfig,
  secrets: SecretEnv,
): ResolvedKey | null {
  if (config.apiKey !== undefined && config.apiKey.length > 0) {
    return { key: config.apiKey, source: "file" };
  }
  if (config.apiKeyEnv !== undefined) {
    const value = secrets[config.apiKeyEnv];
    if (value !== undefined && value.trim().length > 0) {
      return { key: value.trim(), source: "env", envVar: config.apiKeyEnv };
    }
  }
  return null;
}

/** Los últimos cuatro, o `null` si la key es tan corta que mostrarlos la expone. */
export function keyLast4(key: string): string | null {
  return key.length >= MIN_KEY_LENGTH_TO_SHOW_LAST4 ? key.slice(-4) : null;
}

/**
 * La key guardada de una tarea para **probar** contra `baseUrl`, sólo si el
 * origen coincide con el guardado (regla 2 de la cabecera). La UI nunca tiene
 * la key, así que «probar con la guardada» es la única forma de probar una
 * configuración ya guardada.
 */
export function storedKeyFor(
  entry: ModelTaskConfig | undefined,
  baseUrl: string,
  secrets: SecretEnv,
): string | null {
  if (entry === undefined || !sameOrigin(entry.baseUrl, baseUrl)) return null;
  return resolveApiKey(entry, secrets)?.key ?? null;
}

/* ------------------------------------------------------------------------ *
 * Escritura: validar y fusionar un PUT
 * ------------------------------------------------------------------------ */

/**
 * El cuerpo de `PUT /models/:task`, ya parseado por el contrato.
 *
 * Para los campos opcionales: **ausente = dejar lo que había**, `null` =
 * borrarlo. Es lo que permite editar el modelo sin reenviar la key, que la UI
 * no tiene.
 */
export interface ModelTaskUpdate {
  readonly provider: ModelProvider;
  /** Vacío o ausente = la del preset, si tiene. */
  readonly baseUrl?: string | undefined;
  readonly model: string;
  readonly apiKey?: string | null | undefined;
  readonly apiKeyEnv?: string | null | undefined;
  readonly contextWindowTokens?: number | null | undefined;
}

export type ModelTaskUpdateField =
  "provider" | "baseUrl" | "model" | "apiKey" | "apiKeyEnv" | "contextWindowTokens";

export type ApplyTaskUpdateResult =
  | { readonly ok: true; readonly config: ModelTaskConfig }
  | {
      readonly ok: false;
      readonly field: ModelTaskUpdateField;
      readonly message: string;
    };

export function applyTaskUpdate(
  task: ModelTask,
  current: ModelTaskConfig | undefined,
  update: ModelTaskUpdate,
  now: string,
): ApplyTaskUpdateResult {
  const spec = taskSpec(task);
  if (!spec.providers.includes(update.provider)) {
    return {
      ok: false,
      field: "provider",
      message:
        spec.kind === "reserved"
          ? "This task has no adapter yet: only a custom endpoint can be saved."
          : "That provider is not available for this task.",
    };
  }

  const preset = providerPreset(update.provider);
  const rawBase =
    update.baseUrl === undefined || update.baseUrl.trim() === ""
      ? (preset.baseUrl ?? "")
      : update.baseUrl;
  const base = checkBaseUrl(rawBase);
  if (!base.ok) return { ok: false, field: "baseUrl", message: base.message };

  const model = update.model.trim();
  if (model.length === 0) {
    return { ok: false, field: "model", message: "Model is required." };
  }
  if (model.length > MAX_MODEL_ID_LENGTH) {
    return { ok: false, field: "model", message: "Model id is too long." };
  }

  // La key: nueva, borrada, o la de antes **sólo si el origen no cambió**.
  let apiKey: string | undefined;
  if (update.apiKey === null) {
    apiKey = undefined;
  } else if (update.apiKey !== undefined) {
    const key = update.apiKey.trim();
    if (key.length === 0) {
      apiKey = undefined;
    } else if (key.length > MAX_API_KEY_LENGTH || /\s/.test(key)) {
      return {
        ok: false,
        field: "apiKey",
        message: "That does not look like an API key.",
      };
    } else {
      apiKey = key;
    }
  } else if (current !== undefined && sameOrigin(current.baseUrl, base.baseUrl)) {
    apiKey = current.apiKey;
  }

  let apiKeyEnv: string | undefined;
  if (update.apiKeyEnv === null) {
    apiKeyEnv = undefined;
  } else if (update.apiKeyEnv !== undefined) {
    const name = update.apiKeyEnv.trim();
    if (name.length === 0) {
      apiKeyEnv = undefined;
    } else if (!ENV_VAR_NAME.test(name)) {
      return {
        ok: false,
        field: "apiKeyEnv",
        message: "Use an environment variable name like MY_PROVIDER_API_KEY.",
      };
    } else {
      apiKeyEnv = name;
    }
  } else {
    apiKeyEnv = current?.apiKeyEnv;
  }

  // La ventana es del modelo: si el modelo cambió y no vino una nueva, la
  // vieja no vale.
  let contextWindowTokens: number | undefined;
  if (update.contextWindowTokens === null) {
    contextWindowTokens = undefined;
  } else if (update.contextWindowTokens !== undefined) {
    const n = update.contextWindowTokens;
    if (!Number.isInteger(n) || n <= 0 || n > MAX_CONTEXT_WINDOW_TOKENS) {
      return {
        ok: false,
        field: "contextWindowTokens",
        message: "Context window must be a positive whole number of tokens.",
      };
    }
    contextWindowTokens = n;
  } else if (current !== undefined && current.model === model) {
    contextWindowTokens = current.contextWindowTokens;
  }

  return {
    ok: true,
    config: {
      provider: update.provider,
      baseUrl: base.baseUrl,
      model,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      updatedAt: now,
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Lectura: qué le falta a una entrada y con qué LLM habla el worker
 * ------------------------------------------------------------------------ */

export type MissingField = "apiKey" | "contextWindowTokens";

/**
 * Qué le falta a una entrada guardada para poder usarse. `baseUrl` y `model`
 * no aparecen: una entrada no se guarda sin ellos.
 */
export function missingFields(
  task: ModelTask,
  config: ModelTaskConfig,
  secrets: SecretEnv,
): MissingField[] {
  const missing: MissingField[] = [];
  if (
    providerPreset(config.provider).requiresKey &&
    resolveApiKey(config, secrets) === null
  ) {
    missing.push("apiKey");
  }
  // `OpenAiCompatibleLlm` la exige; las reservadas no tienen adaptador que la use.
  if (taskSpec(task).kind === "llm" && config.contextWindowTokens === undefined) {
    missing.push("contextWindowTokens");
  }
  return missing;
}

/** Las cuatro `LLM_*` del entorno, ya validadas por quien las leyó. */
export interface LegacyLlmEnv {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly contextWindowTokens: number;
}

/**
 * Las cuatro `LLM_*` leídas **sin exigir nada**: `null` si falta alguna o no
 * valen. Es para quien sólo necesita *mostrarlas* (la API, que no las usa para
 * hablar con nadie). El worker tiene su validación estricta en `env.ts`, que
 * sí tira el arranque con una mitad configurada.
 */
export function legacyLlmFromEnv(env: SecretEnv): LegacyLlmEnv | null {
  const baseUrl = env["LLM_BASE_URL"]?.trim() ?? "";
  const apiKey = env["LLM_API_KEY"]?.trim() ?? "";
  const model = env["LLM_MODEL"]?.trim() ?? "";
  const windowRaw = env["LLM_CONTEXT_WINDOW_TOKENS"]?.trim() ?? "";
  const contextWindowTokens = /^\d+$/.test(windowRaw) ? Number(windowRaw) : NaN;
  if (
    baseUrl === "" ||
    apiKey === "" ||
    model === "" ||
    !checkBaseUrl(baseUrl).ok ||
    !Number.isSafeInteger(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return null;
  }
  return { baseUrl, apiKey, model, contextWindowTokens };
}

export interface ResolvedLlmConfig {
  /** De dónde salió: el registro, o las `LLM_*` de siempre. */
  readonly source: "registry" | "env";
  /** La entrada del registro que se usó (`judgment` puede heredar de `text`). */
  readonly entry: ModelTask | null;
  readonly provider: ModelProvider | null;
  readonly baseUrl: string;
  /** Vacía = sin `Authorization` (servidor local). */
  readonly apiKey: string;
  readonly model: string;
  readonly contextWindowTokens: number;
}

/** Qué entrada del registro sirve para una tarea, y si es heredada. */
function entryFor(
  task: ModelTask,
  snapshot: ModelRegistrySnapshot,
): { readonly entry: ModelTask; readonly config: ModelTaskConfig } | null {
  const own = snapshot.tasks[task];
  if (own !== undefined) return { entry: task, config: own };
  // `judgment` corre sobre el mismo puerto `Llm` que `text` (`LlmJudgmentAdapter`
  // recibe un `Llm`): sin entrada propia, usa la de texto. Es lo que pasaba
  // antes con las `LLM_*`, que eran una sola configuración para todo.
  if (task === "judgment") {
    const text = snapshot.tasks.text;
    if (text !== undefined) return { entry: "text", config: text };
  }
  return null;
}

/**
 * Con qué LLM hablar para `task`, o `null` si no hay ninguno configurado.
 *
 * Orden: la entrada del registro **si está completa** → las `LLM_*` del
 * entorno (sólo `text` y `judgment`, que son las que las usaban) → nada. Una
 * entrada incompleta no tapa al entorno: un registro a medio llenar desde la
 * pantalla no puede apagar un worker que andaba.
 */
export function resolveLlmConfig(
  task: ModelTask,
  snapshot: ModelRegistrySnapshot,
  legacy: LegacyLlmEnv | null,
  secrets: SecretEnv,
): ResolvedLlmConfig | null {
  if (taskSpec(task).kind !== "llm") return null;
  const found = entryFor(task, snapshot);
  if (found !== null && missingFields(found.entry, found.config, secrets).length === 0) {
    const { config } = found;
    const contextWindowTokens = config.contextWindowTokens;
    if (contextWindowTokens !== undefined) {
      return {
        source: "registry",
        entry: found.entry,
        provider: config.provider,
        baseUrl: config.baseUrl,
        apiKey: resolveApiKey(config, secrets)?.key ?? "",
        model: config.model,
        contextWindowTokens,
      };
    }
  }
  if (legacy !== null && (task === "text" || task === "judgment")) {
    return {
      source: "env",
      entry: null,
      provider: null,
      baseUrl: legacy.baseUrl,
      apiKey: legacy.apiKey,
      model: legacy.model,
      contextWindowTokens: legacy.contextWindowTokens,
    };
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * Hacia afuera
 * ------------------------------------------------------------------------ */

export interface PublicKeyInfo {
  readonly hasKey: boolean;
  readonly last4: string | null;
  readonly source: KeySource | null;
  readonly envVar: string | null;
}

export type TaskStatus = "ready" | "incomplete" | "unset";

/** Lo que `GET /models` devuelve por tarea. Sin la key. */
export interface PublicTaskConfig {
  readonly task: ModelTask;
  readonly kind: ModelTaskKind;
  readonly wired: boolean;
  readonly status: TaskStatus;
  readonly source: "registry" | "env" | "none";
  /** `text` si `judgment` no tiene entrada propia y usa la de texto. */
  readonly inheritsFrom: ModelTask | null;
  readonly provider: ModelProvider | null;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly contextWindowTokens: number | null;
  readonly apiKey: PublicKeyInfo;
  readonly apiKeyEnv: string | null;
  readonly missing: readonly MissingField[];
  readonly updatedAt: string | null;
}

const NO_KEY: PublicKeyInfo = { hasKey: false, last4: null, source: null, envVar: null };

function publicKey(key: ResolvedKey | null): PublicKeyInfo {
  if (key === null) return NO_KEY;
  return {
    hasKey: true,
    last4: keyLast4(key.key),
    source: key.source,
    envVar: key.envVar ?? null,
  };
}

/** Env var de la key de las `LLM_*`, para que la UI diga de dónde sale. */
export const LEGACY_LLM_KEY_ENV = "LLM_API_KEY";

export function toPublicTaskConfig(
  task: ModelTask,
  snapshot: ModelRegistrySnapshot,
  legacy: LegacyLlmEnv | null,
  secrets: SecretEnv,
): PublicTaskConfig {
  const spec = taskSpec(task);
  const base = { task, kind: spec.kind, wired: spec.wired };
  const found = entryFor(task, snapshot);

  if (found !== null) {
    const { config } = found;
    const missing = missingFields(found.entry, config, secrets);
    const complete = missing.length === 0;
    // Una entrada propia incompleta con el entorno configurado: el worker usa
    // el entorno (ver `resolveLlmConfig`) y la pantalla tiene que decirlo.
    const usesEnv =
      !complete && legacy !== null && (task === "text" || task === "judgment");
    return {
      ...base,
      status: complete ? "ready" : "incomplete",
      source: usesEnv ? "env" : "registry",
      inheritsFrom: found.entry === task ? null : found.entry,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      contextWindowTokens: config.contextWindowTokens ?? null,
      apiKey: publicKey(resolveApiKey(config, secrets)),
      apiKeyEnv: config.apiKeyEnv ?? null,
      missing,
      updatedAt: config.updatedAt ?? null,
    };
  }

  if (legacy !== null && (task === "text" || task === "judgment")) {
    return {
      ...base,
      status: "ready",
      source: "env",
      inheritsFrom: null,
      provider: null,
      baseUrl: legacy.baseUrl,
      model: legacy.model,
      contextWindowTokens: legacy.contextWindowTokens,
      apiKey: publicKey({
        key: legacy.apiKey,
        source: "env",
        envVar: LEGACY_LLM_KEY_ENV,
      }),
      apiKeyEnv: null,
      missing: [],
      updatedAt: null,
    };
  }

  return {
    ...base,
    status: "unset",
    source: "none",
    inheritsFrom: null,
    provider: null,
    baseUrl: null,
    model: null,
    contextWindowTokens: null,
    apiKey: NO_KEY,
    apiKeyEnv: null,
    missing: [],
    updatedAt: null,
  };
}
