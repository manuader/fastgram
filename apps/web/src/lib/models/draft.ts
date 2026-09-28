/**
 * El borrador de una tarjeta de Settings → Models, sin React — `PU-MODEL-002`.
 *
 * Lo que decide esta lógica y conviene tener probado:
 *
 * - **La key nunca vuelve del servidor**, así que el borrador no la tiene: el
 *   campo arranca vacío y «vacío» significa «dejar la guardada». Borrarla es
 *   una acción explícita (`clearKey`), no vaciar el campo.
 * - **Cambiar de host descarta la key guardada** (lo hace el servidor, ver
 *   `applyTaskUpdate` en `core`). Acá sólo se avisa antes de guardar
 *   ({@link keyWillBeDropped}), porque enterarse después es enterarse tarde.
 * - **La ventana es del modelo**: si el proveedor la publica en `/models`, se
 *   completa sola al elegir el modelo, salvo que el usuario ya haya escrito una.
 */
import {
  isSystemOneModelProvider,
  type ListedModel,
  type ModelProvider,
  type ModelProviderPreset,
  type ModelTaskConfig,
  type TestModelConnectionRequest,
  type UpdateModelTaskRequest,
} from "@fastgram/contracts";

export interface TaskDraft {
  readonly provider: ModelProvider | "";
  readonly baseUrl: string;
  readonly model: string;
  /** Key nueva. Vacía = dejar la guardada (si hay). */
  readonly apiKey: string;
  /** Borrar la key guardada al guardar. */
  readonly clearKey: boolean;
  /** Como texto: es lo que tiene el input. */
  readonly contextWindow: string;
  /** La ventana la puso el autocompletado, no el usuario: se puede pisar. */
  readonly contextWindowAuto: boolean;
}

export function presetOf(
  presets: readonly ModelProviderPreset[],
  id: ModelProvider | "",
): ModelProviderPreset | undefined {
  return id === "" ? undefined : presets.find((p) => p.id === id);
}

/**
 * Lo guardado → borrador. Una tarea que corre con las `LLM_*` o que hereda de
 * `text` arranca vacía: no hay entrada propia que editar, y copiar la del
 * entorno a la pantalla la guardaría en el archivo al primer «Save».
 */
export function draftFrom(config: ModelTaskConfig): TaskDraft {
  const own = config.source === "registry" && config.inheritsFrom === null;
  const ownIncomplete = config.status === "incomplete" && config.inheritsFrom === null;
  const editable = own || ownIncomplete;
  return {
    provider: editable ? (config.provider ?? "") : "",
    baseUrl: editable ? (config.baseUrl ?? "") : "",
    model: editable ? (config.model ?? "") : "",
    apiKey: "",
    clearKey: false,
    contextWindow:
      editable && config.contextWindowTokens !== null
        ? String(config.contextWindowTokens)
        : "",
    contextWindowAuto: false,
  };
}

/**
 * Cambiar de proveedor: la base URL pasa a la del preset y el modelo se vacía
 * (los ids no se comparten entre proveedores) — salvo que el preset proponga
 * uno de su catálogo cerrado (sprint 9: Laya `auto`, Jev `jev-latest`). La key
 * escrita se conserva: puede que el usuario la haya pegado antes de elegir.
 */
export function withProvider(
  draft: TaskDraft,
  provider: ModelProvider,
  presets: readonly ModelProviderPreset[],
): TaskDraft {
  if (provider === draft.provider) return draft;
  return {
    ...draft,
    provider,
    baseUrl: presetOf(presets, provider)?.baseUrl ?? "",
    model: presetOf(presets, provider)?.defaultModel ?? "",
    contextWindow: "",
    contextWindowAuto: false,
  };
}

/** Elegir un modelo; si el proveedor publica la ventana, se completa. */
export function withModel(
  draft: TaskDraft,
  model: string,
  listed: readonly ListedModel[] | null,
): TaskDraft {
  const found = listed?.find((m) => m.id === model);
  const canAutofill = draft.contextWindow.trim() === "" || draft.contextWindowAuto;
  if (found?.contextWindowTokens !== undefined && canAutofill) {
    return {
      ...draft,
      model,
      contextWindow: String(found.contextWindowTokens),
      contextWindowAuto: true,
    };
  }
  return { ...draft, model };
}

function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

/** La key guardada no se va a mandar al host nuevo (el servidor la descarta). */
export function keyWillBeDropped(draft: TaskDraft, config: ModelTaskConfig): boolean {
  if (!config.apiKey.hasKey || config.apiKey.source !== "file") return false;
  if (draft.apiKey.trim() !== "" || draft.clearKey) return false;
  if (config.baseUrl === null) return false;
  const before = originOf(config.baseUrl);
  const after = originOf(draft.baseUrl);
  return before !== null && after !== null && before !== after;
}

export type DraftField = "provider" | "baseUrl" | "model" | "contextWindow";

/**
 * ¿Lleva ventana de contexto? Las tareas LLM sí; un motor SystemOne (Laya,
 * Jev) en una tarea de juicio no (sprint 9, D-18).
 */
export function needsContextWindow(
  kind: ModelTaskConfig["kind"],
  provider: ModelProvider | "",
): boolean {
  return kind === "llm" && !isSystemOneModelProvider(provider);
}

/** Lo que se puede decir sin preguntarle al servidor. El resto lo dice él. */
export function draftErrors(
  draft: TaskDraft,
  kind: ModelTaskConfig["kind"],
): Partial<Record<DraftField, string>> {
  const errors: Partial<Record<DraftField, string>> = {};
  if (draft.provider === "") errors.provider = "Choose a provider.";
  const base = draft.baseUrl.trim();
  if (base === "") errors.baseUrl = "Base URL is required.";
  else if (originOf(base) === null || !/^https?:\/\//i.test(base)) {
    errors.baseUrl = "Use a full http:// or https:// URL.";
  }
  if (draft.model.trim() === "") errors.model = "Model is required.";
  const w = draft.contextWindow.trim();
  if (w !== "" && !/^\d+$/.test(w)) errors.contextWindow = "Whole number of tokens.";
  else if (needsContextWindow(kind, draft.provider) && w === "") {
    errors.contextWindow = "Needed to keep prompts inside the model's limit.";
  }
  return errors;
}

/** Borrador → `PUT /models/:task`. `null` si todavía no se puede mandar. */
export function toUpdateRequest(
  draft: TaskDraft,
  config: ModelTaskConfig,
): UpdateModelTaskRequest | null {
  if (draft.provider === "" || draft.model.trim() === "") return null;
  const key = draft.apiKey.trim();
  // Un SystemOne no lleva ventana: no se manda aunque el campo tenga algo.
  const w = isSystemOneModelProvider(draft.provider) ? "" : draft.contextWindow.trim();
  const hadWindow = config.source === "registry" && config.contextWindowTokens !== null;
  return {
    provider: draft.provider,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    ...(key !== "" ? { apiKey: key } : draft.clearKey ? { apiKey: null } : {}),
    ...(w !== "" && /^\d+$/.test(w)
      ? { contextWindowTokens: Number(w) }
      : hadWindow
        ? { contextWindowTokens: null }
        : {}),
  };
}

/** Borrador → `POST /models/test`. Sin key escrita, prueba con la guardada. */
export function toTestRequest(
  task: ModelTaskConfig["task"],
  draft: TaskDraft,
): TestModelConnectionRequest | null {
  if (draft.provider === "") return null;
  const key = draft.apiKey.trim();
  const model = draft.model.trim();
  return {
    task,
    provider: draft.provider,
    baseUrl: draft.baseUrl.trim(),
    ...(key === "" ? {} : { apiKey: key }),
    ...(model === "" ? {} : { model }),
  };
}

/** Hay algo que guardar. */
export function isDirty(draft: TaskDraft, config: ModelTaskConfig): boolean {
  const saved = draftFrom(config);
  return (
    draft.apiKey.trim() !== "" ||
    draft.clearKey ||
    draft.provider !== saved.provider ||
    draft.baseUrl.trim() !== saved.baseUrl ||
    draft.model.trim() !== saved.model ||
    draft.contextWindow.trim() !== saved.contextWindow
  );
}
