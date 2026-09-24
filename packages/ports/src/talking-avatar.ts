/**
 * Puerto `TalkingAvatar` (imagen + audio → video de alguien diciéndolo) —
 * sprint 8 (agente L), `P4-FORMAT-002`, `P4-INFL-011`.
 *
 * Ciclo, errores y entradas: ver `speech.ts`.
 */
import type { GenCostEstimate, GenListPrice, GenSubmission } from "./image-gen.js";
import type { VoiceProviderClient } from "./speech.js";

/** Una resolución de salida y cuánto audio acepta con ella. */
export interface AvatarResolution {
  /** El valor que va en el pedido (`720p`). */
  readonly id: string;
  /** Tope del audio de entrada con esta resolución, en segundos. */
  readonly maxAudioSeconds: number;
}

export interface TalkingAvatarModelSpec {
  readonly id: string;
  readonly label: string;
  /** En el orden en que se ofrecen; la primera es la default de FastGram. */
  readonly resolutions: readonly AvatarResolution[];
  /** Acepta un prompt de texto que guía el video. */
  readonly promptSupported: boolean;
  readonly docsUrl: string;
  readonly listPrice: GenListPrice | null;
}

export interface TalkingAvatarRequest {
  readonly model: string;
  /** El retrato: URL pública o data URI. */
  readonly imageUrl: string;
  /** La voz: URL pública o data URI. */
  readonly audioUrl: string;
  /** Una de `TalkingAvatarModelSpec.resolutions`. */
  readonly resolution: string;
  /**
   * Cuánto dura el audio, en segundos. Es lo que se cobra y lo que se valida
   * contra el tope de la resolución; no se manda al proveedor.
   */
  readonly audioSeconds: number;
  readonly prompt?: string;
}

export interface TalkingAvatar extends VoiceProviderClient {
  avatarModels(): readonly TalkingAvatarModelSpec[];
  estimateAvatar(request: TalkingAvatarRequest): Promise<GenCostEstimate>;
  /** No idempotente: ver `ImageGen.generateImage`. */
  generateAvatar(request: TalkingAvatarRequest): Promise<GenSubmission>;
}
