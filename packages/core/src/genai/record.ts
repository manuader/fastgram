/**
 * Una generación de AI Studio — `PU-LATER-005` (FR-090 adaptado al plan de uso
 * personal), `PU-MODEL-003`/`004`.
 *
 * Lógica pura: la forma del registro, cómo se lee de disco (lo guarda
 * `JsonFileCollection` en `~/.fastgram/ai-studio/<companyId>/<id>.json`, sin
 * migración) y los códigos de error estables que ve la UI.
 *
 * ## Los estados
 *
 * ```
 *   queued ──► generating ──► ready
 *                  │  └─────► failed | nsfw | canceled
 *   queued ──────────────────► failed (presupuesto, sin configuración, …)
 * ```
 *
 * `queued` = la API lo aceptó y el job está en la cola; `generating` = el
 * proveedor lo aceptó (hay `providerRequest`). `ready` = la media ya está en
 * **nuestro** storage y en el Media Bank: los links del proveedor expiran.
 */
import {
  GEN_ASPECT_RATIOS,
  type GenAspectRatio,
  type GenMediaKind,
  type PortErrorCode,
} from "@fastgram/ports";

import { BLITZ_MEDIA_CATEGORIES } from "../discovery/blitz-media.js";

export const GENERATION_STATUSES = [
  "queued",
  "generating",
  "ready",
  "failed",
  "nsfw",
  "canceled",
] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const TERMINAL_GENERATION_STATUSES: readonly GenerationStatus[] = [
  "ready",
  "failed",
  "nsfw",
  "canceled",
];

/**
 * Códigos estables del error de una generación. Son contrato con la UI (cada
 * uno tiene su copy), no con ningún proveedor.
 */
export const GENERATION_ERROR_CODES = [
  /** El proveedor rechazó el prompt, la imagen o el resultado por contenido. */
  "nsfw_rejected",
  /** El proveedor terminó el pedido como fallido. No se cobra. */
  "generation_failed",
  "provider_unavailable",
  /** La cuenta del proveedor no tiene saldo. */
  "quota_exceeded",
  /** Pasaría el tope mensual de FastGram. */
  "budget_exceeded",
  "rate_limited",
  /** La credencial guardada fue rechazada. */
  "unauthorized",
  "bad_request",
  "not_found",
  "timeout",
  "provider_contract_violation",
  /** La tarea no está configurada en Settings → Models. */
  "not_configured",
  /** No se pudo copiar el resultado a nuestro storage antes de que expire. */
  "download_failed",
] as const;
export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];

export interface GenerationError {
  readonly code: GenerationErrorCode;
  /** En inglés, apto para mostrar. Nunca el cuerpo crudo del proveedor. */
  readonly message: string;
}

export interface GenerationEstimate {
  readonly usd: number;
  readonly source: "provider" | "price_list";
  readonly basis: string;
  readonly sourceUrl: string | null;
}

export interface GenerationProviderRequest {
  readonly requestId: string;
  readonly statusUrl: string;
  readonly responseUrl: string | null;
}

export interface GenerationRecord {
  readonly version: 1;
  readonly id: string;
  readonly companyId: string;
  readonly kind: GenMediaKind;
  /** `higgsfield` | `fal`: el proveedor con el que se estimó y se generó. */
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly aspectRatio: GenAspectRatio;
  readonly count: number;
  /** Sólo video. */
  readonly durationSeconds: number | null;
  /** Sólo image-to-video. */
  readonly imageUrl: string | null;
  readonly status: GenerationStatus;
  readonly estimate: GenerationEstimate;
  /** Mes del gasto reservado (`YYYY-MM`, UTC). Ver `budget.ts`. */
  readonly spendMonth: string;
  readonly providerRequest: GenerationProviderRequest | null;
  /** Filas de `media` creadas (Media Bank). */
  readonly mediaIds: readonly string[];
  readonly error: GenerationError | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function isTerminalGeneration(status: GenerationStatus): boolean {
  return TERMINAL_GENERATION_STATUSES.includes(status);
}

/** `PortError.code` → el código estable de la generación. */
export function generationErrorFromPort(code: PortErrorCode): GenerationErrorCode {
  switch (code) {
    case "unauthorized":
    case "forbidden":
      return "unauthorized";
    case "quota_exceeded":
      return "quota_exceeded";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "not_found":
      return "not_found";
    case "bad_request":
    case "conflict":
      return "bad_request";
    case "provider_contract_violation":
      return "provider_contract_violation";
    case "provider_unavailable":
      return "provider_unavailable";
  }
}

/* ------------------------------------------------------------------------ *
 * Lectura desde disco
 * ------------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const nullableStr = (v: unknown): v is string | null =>
  v === null || typeof v === "string";
const nonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

function parseEstimate(v: unknown): GenerationEstimate | null {
  if (!isObj(v)) return null;
  if (!nonNegative(v["usd"]) || !str(v["basis"]) || !nullableStr(v["sourceUrl"]))
    return null;
  if (v["source"] !== "provider" && v["source"] !== "price_list") return null;
  return {
    usd: v["usd"],
    source: v["source"],
    basis: v["basis"],
    sourceUrl: v["sourceUrl"],
  };
}

function parseProviderRequest(v: unknown): GenerationProviderRequest | null | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  if (!str(v["requestId"]) || !str(v["statusUrl"]) || !nullableStr(v["responseUrl"])) {
    return undefined;
  }
  return {
    requestId: v["requestId"],
    statusUrl: v["statusUrl"],
    responseUrl: v["responseUrl"],
  };
}

function parseError(v: unknown): GenerationError | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !str(v["message"])) return undefined;
  const code = v["code"];
  if (!str(code) || !(GENERATION_ERROR_CODES as readonly string[]).includes(code)) {
    return undefined;
  }
  return { code: code as GenerationErrorCode, message: v["message"] };
}

/**
 * Lo que hay en disco → un registro, o `null` si no tiene la forma. No se
 * «repara»: un registro ilegible se ignora en la galería y un 404 en el detalle.
 */
export function parseGenerationRecord(value: unknown): GenerationRecord | null {
  if (!isObj(value) || value["version"] !== 1) return null;
  const v = value;
  if (
    !str(v["id"]) ||
    !str(v["companyId"]) ||
    !str(v["provider"]) ||
    !str(v["model"]) ||
    !str(v["prompt"]) ||
    !str(v["spendMonth"]) ||
    !str(v["createdAt"]) ||
    !str(v["updatedAt"]) ||
    !nullableStr(v["imageUrl"])
  ) {
    return null;
  }
  if (v["kind"] !== "image" && v["kind"] !== "video") return null;
  const aspect = v["aspectRatio"];
  if (!str(aspect) || !(GEN_ASPECT_RATIOS as readonly string[]).includes(aspect))
    return null;
  const status = v["status"];
  if (!str(status) || !(GENERATION_STATUSES as readonly string[]).includes(status))
    return null;
  const count = v["count"];
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) return null;
  const duration = v["durationSeconds"];
  if (duration !== null && !nonNegative(duration)) return null;
  const estimate = parseEstimate(v["estimate"]);
  const providerRequest = parseProviderRequest(v["providerRequest"]);
  const error = parseError(v["error"]);
  const mediaIds = v["mediaIds"];
  if (
    estimate === null ||
    providerRequest === undefined ||
    error === undefined ||
    !Array.isArray(mediaIds) ||
    !mediaIds.every(str)
  ) {
    return null;
  }
  return {
    version: 1,
    id: v["id"],
    companyId: v["companyId"],
    kind: v["kind"],
    provider: v["provider"],
    model: v["model"],
    prompt: v["prompt"],
    aspectRatio: aspect as GenAspectRatio,
    count,
    durationSeconds: duration,
    imageUrl: v["imageUrl"],
    status: status as GenerationStatus,
    estimate,
    spendMonth: v["spendMonth"],
    providerRequest,
    mediaIds: mediaIds,
    error,
    createdAt: v["createdAt"],
    updatedAt: v["updatedAt"],
  };
}

/** Más nuevas primero; empate por id, para que el orden sea estable. */
export function sortGenerations(
  records: readonly GenerationRecord[],
): GenerationRecord[] {
  return [...records].sort((a, b) =>
    a.createdAt === b.createdAt
      ? b.id.localeCompare(a.id)
      : b.createdAt.localeCompare(a.createdAt),
  );
}

/* ------------------------------------------------------------------------ *
 * Transiciones
 * ------------------------------------------------------------------------ */

export function markSubmitted(
  record: GenerationRecord,
  request: GenerationProviderRequest,
  now: string,
): GenerationRecord {
  return { ...record, status: "generating", providerRequest: request, updatedAt: now };
}

export function markReady(
  record: GenerationRecord,
  mediaIds: readonly string[],
  now: string,
): GenerationRecord {
  return {
    ...record,
    status: "ready",
    mediaIds: [...mediaIds],
    error: null,
    updatedAt: now,
  };
}

export function markFailed(
  record: GenerationRecord,
  error: GenerationError,
  now: string,
): GenerationRecord {
  const status: GenerationStatus = error.code === "nsfw_rejected" ? "nsfw" : "failed";
  return { ...record, status, error, updatedAt: now };
}

/** Las categorías del Media Bank con las que nace el resultado (FR-100). */
export function mediaCategoriesFor(kind: GenMediaKind): readonly string[] {
  const c = BLITZ_MEDIA_CATEGORIES;
  // Las mismas que el kit de fondos de marca: elegibles por Blitz.
  return kind === "image"
    ? [c.slideshowImage, c.greenScreenBackground]
    : [c.backgroundVideo];
}

export interface NewGenerationInput {
  readonly id: string;
  readonly companyId: string;
  readonly kind: GenMediaKind;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly aspectRatio: GenAspectRatio;
  readonly count: number;
  readonly durationSeconds: number | null;
  readonly imageUrl: string | null;
  readonly estimate: GenerationEstimate;
  readonly spendMonth: string;
  readonly now: string;
}

export function newGenerationRecord(input: NewGenerationInput): GenerationRecord {
  return {
    version: 1,
    id: input.id,
    companyId: input.companyId,
    kind: input.kind,
    provider: input.provider,
    model: input.model,
    prompt: input.prompt.trim(),
    aspectRatio: input.aspectRatio,
    count: input.count,
    durationSeconds: input.kind === "video" ? input.durationSeconds : null,
    imageUrl: input.imageUrl,
    status: "queued",
    estimate: input.estimate,
    spendMonth: input.spendMonth,
    providerRequest: null,
    mediaIds: [],
    error: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
