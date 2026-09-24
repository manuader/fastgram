/**
 * El personaje de un influencer — `PU-LATER-004`, `FR-080`, `F-094`.
 *
 * Lógica pura: qué necesita el pipeline del proveedor ({@link CharacterGen}),
 * cómo se traduce su estado al de `DATA-013` (`generating_variations →
 * training → ready | failed` con `progress` 0–100) y con qué códigos estables
 * falla.
 *
 * ## Por qué Higgsfield y no un LoRA de fal
 *
 * Verificado en la documentación oficial el 2026-09-24:
 *
 * - Higgsfield documenta **por API** crear un personaje desde fotos
 *   (`POST /v1/custom-references`, «Soul ID») y generar imágenes con él
 *   (`custom_reference_id` en SOUL V2). Es un solo proveedor, sin archivo de
 *   pesos que guardar.
 * - fal documenta el entrenamiento (`fal-ai/flux-lora-fast-training`, un zip
 *   de fotos → `diffusers_lora_file`) y la inferencia con LoRA
 *   (`fal-ai/flux-lora`, `loras[].path`), que es el `ADR-010` del plan. Es un
 *   camino válido pero más largo (armar el zip, guardar el archivo de pesos) y
 *   no se construyó: queda como alternativa.
 *
 * ## El `progress`
 *
 * Higgsfield no informa avance: sólo el estado. El número es **por fase**
 * (subir fotos 5–40, en cola 50, entrenando 75, listo 100), que es lo único
 * honesto que se puede mostrar. Subir las fotos sí es medible (n de N).
 */
import type {
  GenAspectRatio,
  GenCostEstimate,
  GenJobHandle,
  GenJobState,
  GenSubmission,
  PortErrorCode,
} from "@fastgram/ports";

import type { BudgetSummary } from "../genai/budget.js";

/**
 * Cuántas fotos de referencia. Higgsfield acepta 1–100
 * (`/docs/models/soul-id/create-character`); 4–20 es decisión nuestra: con
 * menos de 4 un personaje "consistente" sale de una sola cara, y 20 cubre
 * ángulos y luces sin convertir el wizard en una subida masiva.
 */
export const INFLUENCER_REFERENCE_LIMITS = { min: 4, max: 20 } as const;

/** El único proveedor con personajes por API que está construido. */
export const INFLUENCER_CHARACTER_PROVIDER = "higgsfield";

/**
 * Con qué modelo se generan las imágenes del personaje: SOUL V2, el que acepta
 * `custom_reference_id` (`/docs/models/soul-2/generate`). Es el mismo id que
 * usa `HiggsfieldClient.generateCharacterImage`; se repite acá porque `core`
 * no importa adaptadores.
 */
export const INFLUENCER_IMAGE_MODEL = "higgsfield-ai/soul/v2/standard";

/** SOUL V2 (`/docs/models/soul-2/generate`) ∩ los formatos de la app. */
export const INFLUENCER_IMAGE_ASPECT_RATIOS: readonly GenAspectRatio[] = [
  "9:16",
  "3:4",
  "1:1",
  "4:3",
  "16:9",
];
/** `batch_size` de SOUL V2. */
export const INFLUENCER_IMAGE_COUNTS: readonly number[] = [1, 4];

export type CharacterProviderStatus =
  "not_ready" | "queued" | "in_progress" | "completed" | "failed";

export interface CharacterSnapshot {
  readonly id: string;
  readonly status: CharacterProviderStatus;
  readonly thumbnailUrl: string | null;
  readonly failReason: string | null;
}

export interface CharacterImageRequest {
  readonly characterId: string;
  readonly prompt: string;
  readonly aspectRatio: GenAspectRatio;
  readonly n: number;
  readonly strength?: number;
}

/**
 * Lo que el pipeline necesita del proveedor. `HiggsfieldClient`
 * (`@fastgram/adapters`) lo cumple por estructura: `core` no importa
 * adaptadores.
 */
export interface CharacterGen {
  uploadImage(input: {
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<string>;
  createCharacter(input: {
    readonly name: string;
    readonly imageUrls: readonly string[];
  }): Promise<CharacterSnapshot>;
  getCharacter(id: string): Promise<CharacterSnapshot>;
  estimateCharacterImage(request: CharacterImageRequest): Promise<GenCostEstimate>;
  generateCharacterImage(request: CharacterImageRequest): Promise<GenSubmission>;
  poll(handle: GenJobHandle): Promise<GenJobState>;
}

/** Por qué un influencer quedó `failed`. Contrato con la UI, no con un proveedor. */
export const INFLUENCER_FAILURE_CODES = [
  /** Higgsfield no está configurado en Settings → Models. */
  "not_configured",
  /** Menos fotos de las necesarias (borradas del Media Bank, o nunca hubo). */
  "references_missing",
  /** No se pudo leer una foto de nuestro storage o subirla al proveedor. */
  "upload_failed",
  /** El proveedor terminó el entrenamiento como fallido. */
  "training_failed",
  /** La cuenta del proveedor no tiene saldo. */
  "quota_exceeded",
  /** La credencial guardada fue rechazada. */
  "unauthorized",
  "rate_limited",
  "provider_unavailable",
  "bad_request",
  "timeout",
  "provider_contract_violation",
] as const;
export type InfluencerFailureCode = (typeof INFLUENCER_FAILURE_CODES)[number];

export interface InfluencerFailure {
  readonly code: InfluencerFailureCode;
  /** En inglés, apto para mostrar. */
  readonly message: string;
}

export function influencerFailureFromPort(code: PortErrorCode): InfluencerFailureCode {
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
    case "provider_contract_violation":
      return "provider_contract_violation";
    case "provider_unavailable":
      return "provider_unavailable";
    case "not_found":
    case "bad_request":
    case "conflict":
      return "bad_request";
  }
}

export type ReferenceCountCheck =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export function checkReferenceCount(n: number): ReferenceCountCheck {
  const { min, max } = INFLUENCER_REFERENCE_LIMITS;
  if (n < min) {
    return { ok: false, message: `Pick at least ${String(min)} reference photos.` };
  }
  if (n > max) {
    return { ok: false, message: `Pick at most ${String(max)} reference photos.` };
  }
  return { ok: true };
}

/** Subiendo la foto `done` de `total`: 5 → 40. */
export function uploadProgress(done: number, total: number): number {
  if (total <= 0) return 5;
  const ratio = Math.max(0, Math.min(1, done / total));
  return Math.round(5 + 35 * ratio);
}

export interface InfluencerPhase {
  readonly status: "training" | "ready" | "failed";
  readonly progress: number;
}

/** El estado del personaje en el proveedor → el de `DATA-013`. */
export function phaseFromCharacter(status: CharacterProviderStatus): InfluencerPhase {
  switch (status) {
    case "not_ready":
    case "queued":
      return { status: "training", progress: 50 };
    case "in_progress":
      return { status: "training", progress: 75 };
    case "completed":
      return { status: "ready", progress: 100 };
    case "failed":
      return { status: "failed", progress: 100 };
  }
}

/**
 * ¿Se puede crear un personaje con lo que queda del tope del mes?
 *
 * Higgsfield **no publica** el precio de `custom-references` ni un estimador
 * para ese endpoint, así que no hay un número que reservar. La regla
 * conservadora: se crea sólo si el mes todavía tiene saldo. Lo que cobre
 * Higgsfield por el entrenamiento no entra al libro (no hay de dónde sacarlo)
 * y la UI lo dice.
 */
export function canStartCharacter(summary: BudgetSummary): boolean {
  return summary.remainingUsd > 0;
}
