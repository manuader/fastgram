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
  isJudgmentOverrideTask,
  isSystemOneProvider,
  type ComfyWorkflowConfig,
  type JudgmentTask,
  type SystemOneProvider,
  type ModelProvider,
  type ModelRegistrySnapshot,
  type ModelTask,
  type ModelTaskConfig,
} from "@fastgram/ports";

import { checkComfyWorkflowConfig, type ComfyWorkflowInput } from "./comfy-workflow.js";
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
  /**
   * Sólo `comfyui` (`PU-LATER-003`). Ausente = dejar el guardado (si la
   * entrada ya era de ComfyUI); `null` = borrarlo, lo que con `comfyui` es un
   * error: sin workflow no hay qué ejecutar.
   */
  readonly comfyWorkflow?: ComfyWorkflowInput | null | undefined;
}

export type ModelTaskUpdateField =
  | "provider"
  | "baseUrl"
  | "model"
  | "apiKey"
  | "apiKeyEnv"
  | "contextWindowTokens"
  | "comfyWorkflow";

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
    } else if (update.provider === "higgsfield" && !/^[^:]+:[^:]+$/.test(key)) {
      // docs.higgsfield.ai/docs/authentication: `Key {key_id}:{key_secret}`.
      return {
        ok: false,
        field: "apiKey",
        message: "Paste the Higgsfield credential as KEY_ID:KEY_SECRET.",
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
  if (isSystemOneProvider(update.provider)) {
    // D-18: un motor SystemOne no tiene ventana que el adaptador use (el
    // estado lo recorta el server, 50 000 caracteres en Laya). Guardarla sería
    // un número que nadie lee y que la pantalla mostraría como si importara.
    contextWindowTokens = undefined;
  } else if (update.contextWindowTokens === null) {
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

  // ComfyUI: el workflow es el modelo. Los demás proveedores no lo llevan.
  let comfyWorkflow: ComfyWorkflowConfig | undefined;
  if (update.provider === "comfyui") {
    const raw =
      update.comfyWorkflow === undefined
        ? current?.provider === "comfyui"
          ? current.comfyWorkflow
          : undefined
        : (update.comfyWorkflow ?? undefined);
    if (raw === undefined) {
      return {
        ok: false,
        field: "comfyWorkflow",
        message: "Paste a ComfyUI workflow exported in API format.",
      };
    }
    const checked = checkComfyWorkflowConfig(task, raw);
    if (!checked.ok) {
      return { ok: false, field: "comfyWorkflow", message: checked.message };
    }
    comfyWorkflow = checked.config;
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
      ...(comfyWorkflow === undefined ? {} : { comfyWorkflow }),
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
  /**
   * Sprint 8: con el registro entero, una tarea de voz sin key propia no la
   * «pierde» si otra tarea de fal del mismo origen la tiene ({@link taskApiKey}).
   */
  snapshot?: ModelRegistrySnapshot,
): MissingField[] {
  const missing: MissingField[] = [];
  const key =
    snapshot === undefined
      ? resolveApiKey(config, secrets)
      : taskApiKey(task, config, snapshot, secrets);
  if (providerPreset(config.provider).requiresKey && key === null) {
    missing.push("apiKey");
  }
  // `OpenAiCompatibleLlm` la exige; las reservadas no tienen adaptador que la use,
  // y un motor SystemOne (D-18) tampoco.
  if (
    taskSpec(task).kind === "llm" &&
    !isSystemOneProvider(config.provider) &&
    config.contextWindowTokens === undefined
  ) {
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

/** Las tareas que las cuatro `LLM_*` cubrían antes del registro. */
function usesLegacyEnv(task: ModelTask): boolean {
  return task === "text" || task === "judgment" || isJudgmentOverrideTask(task);
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

/**
 * Qué entrada del registro sirve para una tarea, y si es heredada.
 *
 * Con `llmOnly`, una entrada SystemOne (D-18) cuenta como ausente: es lo que
 * necesita quien arma un **LLM** (`resolveLlmConfig`), para el que Laya no es
 * un modelo. Sin él —la pantalla— se muestra lo que hay guardado.
 */
function entryFor(
  task: ModelTask,
  snapshot: ModelRegistrySnapshot,
  llmOnly = false,
): { readonly entry: ModelTask; readonly config: ModelTaskConfig } | null {
  const own = snapshot.tasks[task];
  if (own !== undefined && !(llmOnly && isSystemOneProvider(own.provider))) {
    return { entry: task, config: own };
  }
  // `P1-JUDGE-004`: un punto de decisión sin modelo propio usa el de juicio
  // general (y éste, el de texto). Es lo que hace compatible un `models.json`
  // escrito antes de que existieran los overrides.
  if (isJudgmentOverrideTask(task)) return entryFor("judgment", snapshot, llmOnly);
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
  if (isJudgmentOverrideTask(task)) {
    // Un override **incompleto** no tapa al juicio general: lo mismo que la
    // regla 3 de la cabecera, un paso más abajo. Guardar a medias el modelo
    // del piloto no puede dejar al piloto sin juicio.
    const own = snapshot.tasks[task];
    if (
      own === undefined ||
      isSystemOneProvider(own.provider) ||
      missingFields(task, own, secrets).length > 0
    ) {
      return resolveLlmConfig("judgment", snapshot, legacy, secrets);
    }
  }
  // D-18: una entrada SystemOne no es un LLM. `judgment` apuntando a Laya deja
  // como LLM de juicio (el fallback) al de texto, como si no tuviera entrada.
  const found = entryFor(task, snapshot, true);
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
  if (legacy !== null && usesLegacyEnv(task)) {
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
 * Juicio: LLM o SystemOne (sprint 9, D-18)
 * ------------------------------------------------------------------------ */

/** Un motor SystemOne listo para hablarle: base, key (vacía = sin key) y modelo. */
export interface ResolvedSystemOneConfig {
  readonly engine: "systemone";
  /** La entrada del registro que se usó (un override puede heredar `judgment`). */
  readonly entry: ModelTask;
  readonly provider: SystemOneProvider;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export type ResolvedJudgmentConfig =
  ResolvedSystemOneConfig | { readonly engine: "llm"; readonly llm: ResolvedLlmConfig };

/**
 * Con qué motor juzga una tarea de juicio: un SystemOne (Laya, Jev) o un LLM.
 *
 * Se recorre la cadena de herencia de siempre (`judgment.x` → `judgment`) y
 * **gana la primera entrada completa**: si es SystemOne, ése; si es un LLM, el
 * LLM de esa tarea. Una entrada incompleta no tapa a la de abajo (la misma
 * regla 3 de la cabecera). Si ninguna de la cadena está completa, el LLM que
 * `resolveLlmConfig` encuentre (hereda `text` y las `LLM_*`): D-18 deja el LLM
 * de fallback.
 *
 * Ojo con lo que implica: con `judgment` en Laya, **todos** los puntos de
 * decisión sin override propio pasan a Laya (el piloto, la marca, Engagement,
 * los assets). Es lo que D-18 pide («los `JV-*` pueden correr sin costo»);
 * quien quiera el piloto en un LLM le pone override.
 */
export function resolveJudgmentConfig(
  task: JudgmentTask,
  snapshot: ModelRegistrySnapshot,
  legacy: LegacyLlmEnv | null,
  secrets: SecretEnv,
): ResolvedJudgmentConfig | null {
  const chain: readonly JudgmentTask[] =
    task === "judgment" ? ["judgment"] : [task, "judgment"];
  for (const link of chain) {
    const own = snapshot.tasks[link];
    if (own === undefined || missingFields(link, own, secrets).length > 0) continue;
    if (isSystemOneProvider(own.provider)) {
      return {
        engine: "systemone",
        entry: link,
        provider: own.provider,
        baseUrl: own.baseUrl,
        apiKey: resolveApiKey(own, secrets)?.key ?? "",
        model: own.model,
      };
    }
    // Un LLM completo en la cadena: ése, con las reglas de `resolveLlmConfig`.
    break;
  }
  const llm = resolveLlmConfig(task, snapshot, legacy, secrets);
  return llm === null ? null : { engine: "llm", llm };
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
  /** Sólo `comfyui`: el workflow guardado (no es un secreto: la UI lo edita). */
  readonly comfyWorkflow: ComfyWorkflowConfig | null;
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
    const missing = missingFields(found.entry, config, secrets, snapshot);
    const complete = missing.length === 0;
    // Una entrada propia incompleta con el entorno configurado: el worker usa
    // el entorno (ver `resolveLlmConfig`) y la pantalla tiene que decirlo.
    const usesEnv = !complete && legacy !== null && usesLegacyEnv(task);
    return {
      ...base,
      status: complete ? "ready" : "incomplete",
      source: usesEnv ? "env" : "registry",
      inheritsFrom: found.entry === task ? null : found.entry,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      contextWindowTokens: config.contextWindowTokens ?? null,
      apiKey: publicKey(taskApiKey(found.entry, config, snapshot, secrets)),
      apiKeyEnv: config.apiKeyEnv ?? null,
      missing,
      comfyWorkflow:
        found.entry === task && config.provider === "comfyui"
          ? (config.comfyWorkflow ?? null)
          : null,
      updatedAt: config.updatedAt ?? null,
    };
  }

  if (legacy !== null && usesLegacyEnv(task)) {
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
      comfyWorkflow: null,
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
    comfyWorkflow: null,
    updatedAt: null,
  };
}

/* ------------------------------------------------------------------------ *
 * Imagen y video (`PU-MODEL-003`/`004`)
 * ------------------------------------------------------------------------ */

export interface ResolvedGenAiConfig {
  readonly task: "image" | "video";
  readonly provider: ModelProvider;
  readonly baseUrl: string;
  readonly model: string;
  /** Vacía para un proveedor local sin key (`comfyui`). */
  readonly apiKey: string;
  /** Sólo `comfyui`: el workflow y dónde inyectar cada cosa. */
  readonly comfyWorkflow?: ComfyWorkflowConfig;
}

/**
 * Con qué proveedor generar imagen o video, o `null` si la tarea no está
 * configurada **completa** con un proveedor que tenga adaptador. No hay
 * fallback de entorno: estas tareas nacieron con el registro.
 */
export function resolveGenAiConfig(
  task: "image" | "video",
  snapshot: ModelRegistrySnapshot,
  secrets: SecretEnv,
): ResolvedGenAiConfig | null {
  const config = snapshot.tasks[task];
  if (config === undefined) return null;
  if (!taskSpec(task).providers.includes(config.provider)) return null;
  if (missingFields(task, config, secrets).length > 0) return null;
  const key = resolveApiKey(config, secrets);
  if (config.provider === "comfyui") {
    // Local y sin key (`PU-LATER-003`); sin workflow no hay qué ejecutar.
    if (config.comfyWorkflow === undefined) return null;
    return {
      task,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: key?.key ?? "",
      comfyWorkflow: config.comfyWorkflow,
    };
  }
  if (key === null) return null;
  return {
    task,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: key.key,
  };
}

/* ------------------------------------------------------------------------ *
 * Voz, talking avatar y character swap (sprint 8, agente L)
 * ------------------------------------------------------------------------ */

export const VOICE_TASKS = ["speech", "avatar", "swap"] as const;
export type VoiceTask = (typeof VOICE_TASKS)[number];

export function isVoiceTask(task: string): task is VoiceTask {
  return (VOICE_TASKS as readonly string[]).includes(task);
}

/** Las tareas de las que una tarea de voz puede tomar prestada la key de fal. */
const FAL_KEY_DONORS: readonly ModelTask[] = [
  "speech",
  "avatar",
  "swap",
  "video",
  "image",
  "background_removal",
];

/**
 * La key con la que corre una tarea. Para las de voz, si la entrada no tiene
 * una propia, la de **otra tarea de fal del mismo origen** (el brief: «la key
 * de fal ya existe para imagen/video: reusala»). El mismo origen es la regla
 * 2 de la cabecera: una key nunca viaja a un host distinto del que la pidió.
 */
export function taskApiKey(
  task: ModelTask,
  config: ModelTaskConfig,
  snapshot: ModelRegistrySnapshot,
  secrets: SecretEnv,
): ResolvedKey | null {
  const own = resolveApiKey(config, secrets);
  if (own !== null || !isVoiceTask(task) || config.provider !== "fal") return own;
  for (const donor of FAL_KEY_DONORS) {
    if (donor === task) continue;
    const entry = snapshot.tasks[donor];
    if (entry === undefined || entry.provider !== "fal") continue;
    if (!sameOrigin(entry.baseUrl, config.baseUrl)) continue;
    const key = resolveApiKey(entry, secrets);
    if (key !== null) return key;
  }
  return null;
}

export interface ResolvedVoiceConfig {
  readonly task: VoiceTask;
  readonly provider: "fal";
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

/**
 * Con qué generar voz, talking avatar o character swap, o `null` si la tarea
 * no está configurada con fal y una key (propia o prestada).
 */
export function resolveVoiceConfig(
  task: VoiceTask,
  snapshot: ModelRegistrySnapshot,
  secrets: SecretEnv,
): ResolvedVoiceConfig | null {
  const config = snapshot.tasks[task];
  if (config === undefined || config.provider !== "fal") return null;
  const key = taskApiKey(task, config, snapshot, secrets);
  if (key === null) return null;
  return {
    task,
    provider: "fal",
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: key.key,
  };
}
