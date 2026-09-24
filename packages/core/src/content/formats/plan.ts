/**
 * De un formato generativo a un pedido de video y a una pieza — `P4-FORMAT-001`.
 *
 * Lógica pura:
 *
 * 1. {@link planGenerativeFormat}: el prompt de video (escena del formato +
 *    tema del usuario o lo que ofrece la marca) y el texto que va encima.
 * 2. {@link pickDuration}: la duración que se pide, de las que el modelo
 *    configurado documenta.
 * 3. {@link generativeFormatBuildPayload}: el clip ya copiado a nuestro
 *    storage + el texto → el payload `wall-of-text` que el render compone,
 *    con el mismo estilo de caption que Blitz (`composeBlitzBuildPayload`).
 *
 * ## El texto del usuario en el prompt de video
 *
 * El tema y los campos del perfil van a un modelo de **video**, no a un LLM
 * con herramientas: no hay instrucciones que secuestrar. Igual se aplanan
 * (sin saltos de línea) y se cortan, para que el prompt no pase el tope de
 * `MAX_GENERATION_PROMPT_LENGTH` ni lo domine un perfil largo.
 */
import {
  composeBlitzBuildPayload,
  SUGGESTION_BUILD_PLAN_VERSION,
  type BlitzBuildPayload,
} from "../../discovery/blitz-build.js";
import { MAX_GENERATION_PROMPT_LENGTH } from "../../genai/request.js";
import { findGenerativeFormat, type AvailableGenerativeFormat } from "./catalog.js";

/** Tope del texto que va encima del clip. Decisión nuestra: es un caption. */
export const FORMAT_OVERLAY_MAX_CHARS = 300;
/** Tope del tema del usuario dentro del prompt de video. */
export const FORMAT_TOPIC_MAX_CHARS = 300;
/** Cuánto del perfil de la marca entra como sujeto. */
const BRAND_SUBJECT_MAX_CHARS = 160;

/** Lo del perfil de la marca que puede entrar a la escena (`DATA-004`). */
export interface GenerativeBrandBrief {
  readonly productOffering?: string | null;
  readonly coreIdentity?: string | null;
}

export interface GenerativeFormatPlanInput {
  readonly formatId: string;
  /** Detalle opcional de la escena («a coffee shop»). */
  readonly topic?: string | undefined;
  /** El texto que va encima del clip. Obligatorio. */
  readonly overlayText: string;
  readonly brand?: GenerativeBrandBrief | null | undefined;
  /** Default `true`: lo que ofrece la marca puede entrar a la escena. */
  readonly includeBrand?: boolean | undefined;
}

export interface GenerativeFormatPlan {
  readonly format: AvailableGenerativeFormat;
  readonly videoPrompt: string;
  readonly overlayText: string;
  readonly topic: string | null;
}

export type GenerativeFormatPlanField = "formatId" | "overlayText" | "topic";

export type GenerativeFormatPlanResult =
  | { readonly ok: true; readonly plan: GenerativeFormatPlan }
  | {
      readonly ok: false;
      readonly field: GenerativeFormatPlanField;
      readonly message: string;
    };

/** Una línea, sin espacios repetidos. */
export function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clampWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

function brandSubject(brand: GenerativeBrandBrief | null | undefined): string | null {
  const raw = flatten(brand?.productOffering ?? "") || flatten(brand?.coreIdentity ?? "");
  return raw === "" ? null : clampWords(raw, BRAND_SUBJECT_MAX_CHARS);
}

export function planGenerativeFormat(
  input: GenerativeFormatPlanInput,
): GenerativeFormatPlanResult {
  const format = findGenerativeFormat(input.formatId);
  if (format === undefined) {
    return { ok: false, field: "formatId", message: "That format doesn't exist." };
  }
  if (format.status === "blocked") {
    return { ok: false, field: "formatId", message: format.why };
  }
  if (format.status !== "available") {
    // Sprint 8: los formatos con voz y el character swap tienen su propio
    // pedido (`speaking.ts`); no son «clip + texto».
    return {
      ok: false,
      field: "formatId",
      message: "This format is made with a voice or a source video, not from a scene.",
    };
  }
  const overlayText = input.overlayText.trim();
  if (overlayText === "") {
    return { ok: false, field: "overlayText", message: "Write the text for the video." };
  }
  if (overlayText.length > FORMAT_OVERLAY_MAX_CHARS) {
    return {
      ok: false,
      field: "overlayText",
      message: `Keep the text under ${String(FORMAT_OVERLAY_MAX_CHARS)} characters.`,
    };
  }
  const topicRaw = flatten(input.topic ?? "");
  if (topicRaw.length > FORMAT_TOPIC_MAX_CHARS) {
    return {
      ok: false,
      field: "topic",
      message: `Keep the scene details under ${String(FORMAT_TOPIC_MAX_CHARS)} characters.`,
    };
  }
  const topic = topicRaw === "" ? null : topicRaw;
  const subject =
    topic ??
    (format.subject === "brand" && input.includeBrand !== false
      ? brandSubject(input.brand)
      : null);
  const parts = [format.scene];
  if (subject !== null) parts.push(format.subjectTemplate.replace("{subject}", subject));
  const videoPrompt = clampWords(`${parts.join(", ")}.`, MAX_GENERATION_PROMPT_LENGTH);
  return {
    ok: true,
    plan: { format, videoPrompt, overlayText, topic },
  };
}

/**
 * La duración a pedir: la que quiere quien llama si el modelo la acepta; si
 * no, la preferida del formato si está; si no, la documentada más cercana
 * (empate: la más corta, que es la más barata). `null` si el modelo no
 * publica duraciones.
 */
export function pickDuration(
  format: Pick<AvailableGenerativeFormat, "preferredDurationSeconds">,
  documented: readonly number[],
  wanted?: number,
): number | null {
  if (documented.length === 0) return null;
  if (wanted !== undefined && documented.includes(wanted)) return wanted;
  const target = format.preferredDurationSeconds;
  return [...documented].sort(
    (a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b,
  )[0] as number;
}

/**
 * El clip del Media Bank + el texto → el payload de build. Es `wall-of-text`
 * (`FR-070`: `{canvas, video, text}`, sin `audio`: el clip ya trae el suyo o
 * sale mudo), con el caption de Blitz.
 */
export function generativeFormatBuildPayload(input: {
  readonly clip: { readonly mediaId: string; readonly url: string };
  readonly overlayText: string;
  readonly textStylePresetId?: string | null | undefined;
}): BlitzBuildPayload {
  return composeBlitzBuildPayload(
    {
      version: SUGGESTION_BUILD_PLAN_VERSION,
      media: { format: "wall-of-text", video: input.clip },
      texts: [input.overlayText],
    },
    { textStylePresetId: input.textStylePresetId },
  );
}
