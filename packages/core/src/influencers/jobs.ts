/**
 * Lo que viaja por la cola `influencer-pipeline` — `PU-LATER-004`, `FR-080`,
 * `FR-081`.
 *
 * La misma cola atiende dos trabajos, como `discovery-refill` atiende el
 * refill y «crear desde prompt»:
 *
 * - **`train`**: crear el personaje en el proveedor. Es el payload de siempre
 *   (`POST /influencers`, `parseInfluencerPipelineJob`); no lleva `op` y así
 *   sigue valiendo lo que ya estaba encolado.
 * - **`image`**: un pedido de imágenes del personaje (`influencer_generations`).
 *   Sólo ids: todo lo demás está en la fila.
 *
 * Una cola y no dos: la segunda pedía registrar un nombre nuevo en el
 * catálogo de colas y en el montaje del worker, que no son de este cambio, y
 * la política de la que existe (2 intentos, 45 min) sirve para las dos.
 */
import { parseInfluencerPipelineJob } from "../jobs/influencer-pipeline.js";

export type InfluencerQueueJob =
  | { readonly op: "train"; readonly companyId: string; readonly influencerId: string }
  | {
      /** `video` (sprint 7): animar una imagen del personaje (`F-099`). */
      readonly op: "image" | "video";
      readonly companyId: string;
      readonly influencerId: string;
      readonly generationId: string;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseInfluencerQueueJob(
  raw: unknown,
): { ok: true; payload: InfluencerQueueJob } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "payload is not an object" };
  }
  const source = raw as Record<string, unknown>;
  if (source["op"] === "image" || source["op"] === "video") {
    const op = source["op"];
    const { companyId, influencerId, generationId } = source;
    if (typeof companyId !== "string" || !UUID.test(companyId))
      return { ok: false, reason: "companyId is not a uuid" };
    if (typeof influencerId !== "string" || !UUID.test(influencerId))
      return { ok: false, reason: "influencerId is not a uuid" };
    if (typeof generationId !== "string" || !UUID.test(generationId))
      return { ok: false, reason: "generationId is not a uuid" };
    return { ok: true, payload: { op, companyId, influencerId, generationId } };
  }
  if (source["op"] !== undefined && source["op"] !== "train") {
    return { ok: false, reason: `unknown op ${String(source["op"])}` };
  }
  const parsed = parseInfluencerPipelineJob(raw);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    payload: {
      op: "train",
      companyId: parsed.payload.companyId,
      influencerId: parsed.payload.influencerId,
    },
  };
}

/** Un pedido de imágenes se encola una sola vez por fila. */
export function influencerImageSingletonKey(generationId: string): string {
  return `influencer-image:${generationId}`;
}

export const INFLUENCER_GENERATION_STATUSES = [
  "queued",
  "generating",
  "ready",
  "failed",
  "nsfw",
] as const;
export type InfluencerGenerationStatus = (typeof INFLUENCER_GENERATION_STATUSES)[number];

export function isTerminalInfluencerGeneration(status: string): boolean {
  return status === "ready" || status === "failed" || status === "nsfw";
}

/**
 * Las categorías del Media Bank con que nacen las imágenes del personaje:
 * **ninguna**. Una categoría las haría elegibles para los pools automáticos
 * del workspace (`FR-100`), y entonces aparecerían en contenido "sin
 * influencer" —con `influencerChance = 0` Blitz seguiría mostrando la cara
 * del personaje (`FR-055` criterio 4). Entran a Blitz por el set `SLIDESHOW`
 * del influencer (`FR-083`), que es la elección explícita.
 */
export const INFLUENCER_MEDIA_CATEGORIES: readonly string[] = [];

/** El nombre del set de imágenes que crea el pipeline para cada influencer. */
export function influencerImageSetName(influencerName: string): string {
  return `${influencerName} · images`;
}

/** Clave determinista: una reentrega no duplica objetos ni filas de `media`. */
export function influencerImageStorageKey(input: {
  readonly companyId: string;
  readonly influencerId: string;
  readonly generationId: string;
  readonly index: number;
  readonly ext: string;
}): string {
  return `media/${input.companyId}/influencers/${input.influencerId}/${input.generationId}-${String(input.index + 1)}.${input.ext}`;
}

/** Un video del personaje se encola una sola vez por fila. */
export function influencerVideoSingletonKey(generationId: string): string {
  return `influencer-video:${generationId}`;
}
