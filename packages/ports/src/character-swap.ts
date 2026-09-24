/**
 * Puerto `CharacterSwap` (imagen de personaje + video → el mismo video con el
 * personaje reemplazado) — sprint 8 (agente L), `P4-FORMAT-002`
 * (`character-swap` de `F-070`).
 *
 * Ciclo, errores y entradas: ver `speech.ts`.
 */
import type { GenCostEstimate, GenListPrice, GenSubmission } from "./image-gen.js";
import type { VoiceProviderClient } from "./speech.js";

export interface CharacterSwapModelSpec {
  readonly id: string;
  readonly label: string;
  /** Valores de resolución del esquema, del más barato al más caro. */
  readonly resolutions: readonly string[];
  readonly docsUrl: string;
  readonly listPrice: GenListPrice | null;
}

export interface CharacterSwapRequest {
  readonly model: string;
  /** El personaje: URL pública o data URI. */
  readonly imageUrl: string;
  /** El video de origen: URL pública o data URI. */
  readonly videoUrl: string;
  readonly resolution: string;
  /** Duración del video de origen, en segundos. Sólo para estimar. */
  readonly videoSeconds: number;
  /**
   * Cuadros por segundo del video de origen, si se conocen. Sólo para
   * estimar: sin él, el adaptador estima con un tope conservador.
   */
  readonly fps?: number;
}

export interface CharacterSwap extends VoiceProviderClient {
  swapModels(): readonly CharacterSwapModelSpec[];
  estimateSwap(request: CharacterSwapRequest): Promise<GenCostEstimate>;
  /** No idempotente: ver `ImageGen.generateImage`. */
  generateSwap(request: CharacterSwapRequest): Promise<GenSubmission>;
}
