/**
 * El formulario de AI Studio, sin React — `PU-LATER-005`.
 *
 * Qué decide esta lógica:
 *
 * - **Los controles salen de la ficha del modelo** (`GenModelSpec`): relaciones,
 *   cantidades y duraciones son las que el modelo documenta, no una lista fija.
 *   Al cambiar de modelo, lo elegido que el nuevo no acepta se corrige al
 *   primer valor válido en vez de quedar inválido en silencio.
 * - **Se estima sólo un pedido que el servidor aceptaría**: sin prompt (si el
 *   modelo lo pide) o sin imagen (si es image-to-video) no hay pedido que
 *   estimar, y preguntarle al proveedor sería gastar una llamada en un 400.
 */
import type {
  AiStudioOptions,
  AiStudioTaskOptions,
  GenAspectRatio,
  GenKind,
  GenModelSpec,
  Generation,
  GenerationErrorCode,
  GenerationRequest,
  GenerationStatus,
} from "@fastgram/contracts";

import type { CopyKey } from "../i18n/t";

export interface StudioForm {
  readonly kind: GenKind;
  readonly model: string;
  readonly prompt: string;
  readonly aspectRatio: GenAspectRatio;
  readonly count: number;
  readonly durationSeconds: number | null;
  readonly imageUrl: string;
}

/** Vertical primero: es lo que publica la app. */
const RATIO_PREFERENCE: readonly GenAspectRatio[] = [
  "9:16",
  "4:5",
  "3:4",
  "1:1",
  "16:9",
  "4:3",
];

export function taskFor(options: AiStudioOptions, kind: GenKind): AiStudioTaskOptions {
  return kind === "image" ? options.image : options.video;
}

export function specFor(
  options: AiStudioOptions,
  form: Pick<StudioForm, "kind" | "model">,
): GenModelSpec | undefined {
  return taskFor(options, form.kind).models.find((m) => m.id === form.model);
}

/** Ajusta lo elegido a lo que la ficha acepta. */
export function fitToSpec(form: StudioForm, spec: GenModelSpec | undefined): StudioForm {
  if (spec === undefined) return form;
  const aspectRatio =
    spec.aspectFromImage || spec.aspectRatios.includes(form.aspectRatio)
      ? form.aspectRatio
      : (RATIO_PREFERENCE.find((r) => spec.aspectRatios.includes(r)) ?? form.aspectRatio);
  const count = spec.counts.includes(form.count) ? form.count : (spec.counts[0] ?? 1);
  const durationSeconds =
    spec.kind === "video"
      ? form.durationSeconds !== null &&
        spec.durationsSeconds.includes(form.durationSeconds)
        ? form.durationSeconds
        : (spec.durationsSeconds[0] ?? null)
      : null;
  const imageUrl = spec.imageInput === "none" ? "" : form.imageUrl;
  return { ...form, aspectRatio, count, durationSeconds, imageUrl };
}

/** El formulario inicial de una clase: el modelo de Settings, o el primero. */
export function initialForm(
  options: AiStudioOptions,
  kind: GenKind,
  previous?: StudioForm,
): StudioForm {
  const task = taskFor(options, kind);
  const model =
    task.defaultModel !== null && task.models.some((m) => m.id === task.defaultModel)
      ? task.defaultModel
      : (task.models[0]?.id ?? "");
  const base: StudioForm = {
    kind,
    model,
    prompt: previous?.prompt ?? "",
    aspectRatio: previous?.aspectRatio ?? "9:16",
    count: 1,
    durationSeconds: null,
    imageUrl: "",
  };
  return fitToSpec(base, specFor(options, base));
}

export function withModel(
  options: AiStudioOptions,
  form: StudioForm,
  model: string,
): StudioForm {
  const next = { ...form, model };
  return fitToSpec(next, specFor(options, next));
}

export type StudioField = "prompt" | "imageUrl";

/** Lo que falta para poder pedir (sin preguntarle al servidor). */
export function formErrors(
  form: StudioForm,
  spec: GenModelSpec | undefined,
): Partial<Record<StudioField | "model", CopyKey>> {
  const errors: Partial<Record<StudioField | "model", CopyKey>> = {};
  if (spec === undefined) errors.model = "aiStudio.model.label";
  if (spec?.promptRequired !== false && form.prompt.trim() === "") {
    errors.prompt = "aiStudio.estimate.idle";
  }
  if (spec?.imageInput === "required" && !/^https:\/\/\S+$/i.test(form.imageUrl.trim())) {
    errors.imageUrl = "aiStudio.image.hint";
  }
  return errors;
}

/** El cuerpo de estimar/generar, o `null` si todavía no se puede pedir. */
export function toRequest(
  form: StudioForm,
  spec: GenModelSpec | undefined,
): GenerationRequest | null {
  if (spec === undefined || Object.keys(formErrors(form, spec)).length > 0) return null;
  return {
    kind: form.kind,
    model: form.model,
    prompt: form.prompt.trim(),
    aspectRatio: form.aspectRatio,
    count: form.count,
    ...(form.kind === "video" && form.durationSeconds !== null
      ? { durationSeconds: form.durationSeconds }
      : {}),
    ...(spec.imageInput !== "none" && form.imageUrl.trim() !== ""
      ? { imageUrl: form.imageUrl.trim() }
      : {}),
  };
}

/* ------------------------------------------------------------------------ *
 * Galería
 * ------------------------------------------------------------------------ */

export const GENERATION_STATUS_TONE: Readonly<
  Record<GenerationStatus, "neutral" | "info" | "success" | "warning" | "danger">
> = {
  queued: "neutral",
  generating: "info",
  ready: "success",
  failed: "danger",
  nsfw: "warning",
  canceled: "neutral",
};

export const GENERATION_STATUS_COPY: Readonly<Record<GenerationStatus, CopyKey>> = {
  queued: "aiStudio.status.queued",
  generating: "aiStudio.status.generating",
  ready: "aiStudio.status.ready",
  failed: "aiStudio.status.failed",
  nsfw: "aiStudio.status.nsfw",
  canceled: "aiStudio.status.canceled",
};

export const GENERATION_ERROR_COPY: Readonly<Record<GenerationErrorCode, CopyKey>> = {
  nsfw_rejected: "aiStudio.error.nsfw_rejected",
  generation_failed: "aiStudio.error.generation_failed",
  provider_unavailable: "aiStudio.error.provider_unavailable",
  quota_exceeded: "aiStudio.error.quota_exceeded",
  budget_exceeded: "aiStudio.error.budget_exceeded",
  rate_limited: "aiStudio.error.rate_limited",
  unauthorized: "aiStudio.error.unauthorized",
  bad_request: "aiStudio.error.bad_request",
  not_found: "aiStudio.error.not_found",
  timeout: "aiStudio.error.timeout",
  provider_contract_violation: "aiStudio.error.provider_contract_violation",
  not_configured: "aiStudio.error.not_configured",
  download_failed: "aiStudio.error.download_failed",
};

export function isInFlight(g: Pick<Generation, "status">): boolean {
  return g.status === "queued" || g.status === "generating";
}

/**
 * Pasado este tiempo en vuelo, la tarjeta dice ERR-L09 (*"Taking longer than
 * expected…"*, PRD §19.2) — `P5-ERR-001`.
 *
 * El PRD no da el umbral. 3 minutos es la decisión conservadora: los
 * proveedores de imagen devuelven en segundos y un video corto tarda del orden
 * de un minuto o dos, así que antes de eso el aviso sería ruido. Si se ajusta,
 * que sea con latencias medidas, no a ojo.
 */
export const SLOW_GENERATION_MS = 3 * 60_000;

export function isSlow(
  g: Pick<Generation, "status" | "createdAt">,
  nowMs: number,
): boolean {
  if (!isInFlight(g)) return false;
  const started = Date.parse(g.createdAt);
  return Number.isFinite(started) && nowMs - started >= SLOW_GENERATION_MS;
}

/**
 * Cada cuánto se vuelve a pedir la galería: rápido mientras algo está en
 * vuelo (el worker hace polling al proveedor cada 2–10 s), nada si no.
 */
export const GALLERY_POLL_MS = 4_000;

export function galleryRefetchInterval(
  items: readonly Generation[] | undefined,
): number | false {
  return items?.some(isInFlight) === true ? GALLERY_POLL_MS : false;
}

/** «Higgsfield», «fal»: son marcas, van tal cual. */
export function providerLabel(provider: string | null): string {
  if (provider === "higgsfield") return "Higgsfield";
  if (provider === "fal") return "fal";
  return provider ?? "";
}
