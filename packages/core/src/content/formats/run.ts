/**
 * Una corrida de un formato generativo — `P4-FORMAT-001`.
 *
 * ```
 *   queued ─► generating ─► building ─► ready
 *      └─────────┴──────────────┴─────► failed | nsfw
 * ```
 *
 * ## Dónde vive y por qué su id es el de la generación
 *
 * El clip es **una generación de AI Studio** (`GenerationRecord`, kind
 * `video`): mismo estimador, misma reserva en el tope mensual, mismo worker
 * que envía, hace polling y copia a storage. La corrida es lo que se agrega
 * encima: qué formato, qué texto y qué pieza salió. Vive al lado, en
 * `~/.fastgram/format-runs/<marca>/<id>.json`, con **el mismo id que la
 * generación**: el worker, al terminar una generación, la busca por id sin
 * índice y sin tocar el registro de AI Studio.
 *
 * El estado no se guarda dos veces: sale de la generación (`queued`,
 * `generating`, `failed`, `nsfw`) y de la pieza (`BUILDING` → `building`,
 * `CREATED` → `ready`, `FAILED` → `failed`). La corrida sólo guarda lo que
 * nadie más sabe: la pieza que creó (`contentId`) o por qué no pudo.
 *
 * La pieza **usa el id de la corrida** (`contents.id = run.id`). Así, si el
 * worker muere entre crear la pieza y anotarla acá, la reentrega la
 * encuentra por id en vez de crear otra.
 */
import type { GenerationStatus } from "../../genai/record.js";
import { isGenerativeFormatId, type GenerativeFormatId } from "./catalog.js";

/**
 * Carpeta de las corridas dentro de `FASTGRAM_HOME`. Una sola constante para
 * la API (que escribe) y el worker (que lee): un nombre escrito de los dos
 * lados ya divergió una vez (trampa 19).
 */
export const FORMAT_RUNS_DIR_NAME = "format-runs";

export const FORMAT_RUN_STATUSES = [
  "queued",
  "generating",
  "building",
  "ready",
  "failed",
  "nsfw",
] as const;
export type FormatRunStatus = (typeof FORMAT_RUN_STATUSES)[number];

/** Por qué la corrida no llegó a pieza, cuando el clip sí salió. */
export const FORMAT_RUN_ERROR_CODES = [
  /** El clip ya no está en el Media Bank (se borró antes de armar la pieza). */
  "clip_missing",
  /** No se pudo crear la pieza o encolar su build. */
  "content_failed",
] as const;
export type FormatRunErrorCode = (typeof FORMAT_RUN_ERROR_CODES)[number];

/** Quién la pidió: la pantalla del formato o «Create from prompt» de Blitz. */
export type FormatRunSource = "studio" | "blitz";

export interface FormatRunRecord {
  readonly version: 1;
  /** = id de la generación de AI Studio = id de la pieza. */
  readonly id: string;
  readonly companyId: string;
  readonly formatId: GenerativeFormatId;
  readonly topic: string | null;
  readonly overlayText: string;
  readonly videoPrompt: string;
  readonly source: FormatRunSource;
  readonly contentId: string | null;
  readonly error: { readonly code: FormatRunErrorCode; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

export function parseFormatRunRecord(value: unknown): FormatRunRecord | null {
  if (!isObj(value) || value["version"] !== 1) return null;
  const v = value;
  const formatId = v["formatId"];
  if (
    !str(v["id"]) ||
    !str(v["companyId"]) ||
    !str(formatId) ||
    !isGenerativeFormatId(formatId) ||
    !str(v["overlayText"]) ||
    !str(v["videoPrompt"]) ||
    !str(v["createdAt"]) ||
    !str(v["updatedAt"]) ||
    (v["topic"] !== null && !str(v["topic"])) ||
    (v["contentId"] !== null && !str(v["contentId"])) ||
    (v["source"] !== "studio" && v["source"] !== "blitz")
  ) {
    return null;
  }
  let error: FormatRunRecord["error"] = null;
  if (v["error"] !== null) {
    const e = v["error"];
    if (
      !isObj(e) ||
      !str(e["message"]) ||
      !str(e["code"]) ||
      !(FORMAT_RUN_ERROR_CODES as readonly string[]).includes(e["code"])
    ) {
      return null;
    }
    error = { code: e["code"] as FormatRunErrorCode, message: e["message"] };
  }
  return {
    version: 1,
    id: v["id"],
    companyId: v["companyId"],
    formatId,
    topic: v["topic"] as string | null,
    overlayText: v["overlayText"],
    videoPrompt: v["videoPrompt"],
    source: v["source"],
    contentId: v["contentId"] as string | null,
    error,
    createdAt: v["createdAt"],
    updatedAt: v["updatedAt"],
  };
}

export function newFormatRunRecord(input: {
  readonly id: string;
  readonly companyId: string;
  readonly formatId: GenerativeFormatId;
  readonly topic: string | null;
  readonly overlayText: string;
  readonly videoPrompt: string;
  readonly source: FormatRunSource;
  readonly now: string;
}): FormatRunRecord {
  return {
    version: 1,
    id: input.id,
    companyId: input.companyId,
    formatId: input.formatId,
    topic: input.topic,
    overlayText: input.overlayText,
    videoPrompt: input.videoPrompt,
    source: input.source,
    contentId: null,
    error: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export type ContentBuildStatus = "BUILDING" | "CREATED" | "FAILED";

/**
 * El estado visible. `generation` es `null` si el registro de AI Studio se
 * perdió (archivo borrado): la corrida no puede seguir y se ve `failed`.
 * `content` es el estado de la pieza, o `null` si todavía no existe o ya se
 * borró.
 */
export function formatRunStatus(
  run: Pick<FormatRunRecord, "contentId" | "error">,
  generation: GenerationStatus | null,
  content: ContentBuildStatus | null,
): FormatRunStatus {
  if (run.error !== null) return "failed";
  if (generation === null) return "failed";
  switch (generation) {
    case "queued":
      return "queued";
    case "generating":
      return "generating";
    case "nsfw":
      return "nsfw";
    case "failed":
    case "canceled":
      return "failed";
    case "ready":
      if (run.contentId === null) return "building";
      if (content === "CREATED") return "ready";
      if (content === "FAILED") return "failed";
      // `BUILDING`, o la pieza todavía no se ve (misma transacción en curso).
      return content === null ? "failed" : "building";
  }
}

export function isTerminalFormatRun(status: FormatRunStatus): boolean {
  return status === "ready" || status === "failed" || status === "nsfw";
}
