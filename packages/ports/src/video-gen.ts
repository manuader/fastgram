/**
 * Puerto `VideoGen` — `PU-MODEL-004`, `docs/PLAN-USO-PERSONAL.md` §4, D-14.
 *
 * Mismo ciclo que `ImageGen` (enviar → seguir por `poll` → copiar el
 * resultado a nuestro storage), y comparte con él los tipos de pedido,
 * estado y costo (`image-gen.ts`). Ver la cabecera de ese archivo para los
 * errores y el filtro de contenido.
 */
import type {
  GenAspectRatio,
  GenCostEstimate,
  GenProviderClient,
  GenSubmission,
} from "./image-gen.js";

export interface VideoGenRequest {
  readonly prompt: string;
  /** URL **pública** del primer cuadro. Obligatoria en los image-to-video. */
  readonly imageUrl?: string;
  /** Tiene que ser una de `GenModelSpec.durationsSeconds` del modelo. */
  readonly durationSeconds: number;
  /** Ignorado (y no enviado) si el modelo toma la relación de la imagen. */
  readonly aspectRatio: GenAspectRatio;
  /** Endpoint id del catálogo. */
  readonly model: string;
}

export interface VideoGen extends GenProviderClient {
  estimateVideo(request: VideoGenRequest): Promise<GenCostEstimate>;
  /** No idempotente: ver `ImageGen.generateImage`. */
  generateVideo(request: VideoGenRequest): Promise<GenSubmission>;
}
