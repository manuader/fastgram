/**
 * La cola `media-import` atiende dos cosas: el import por link de siempre
 * (`PU-MEME-001`) y la lectura de referencias de Inspiration. Esto elige por
 * el payload: con `inspirationItemId`, Inspiration; sin él, exactamente lo que
 * el import recibía antes. Mismo patrón que `createDiscoveryDispatcher` para
 * «crear desde prompt» (ver `core/src/inspiration/ingest-job.ts`).
 */
import { isInspirationIngestPayload } from "@fastgram/core";
import type { JobHandler } from "@fastgram/ports";

export function createMediaImportDispatcher(handlers: {
  readonly mediaImport: JobHandler<unknown>;
  readonly inspiration: JobHandler<unknown>;
}): JobHandler<unknown> {
  return (ctx) =>
    isInspirationIngestPayload(ctx.payload)
      ? handlers.inspiration(ctx)
      : handlers.mediaImport(ctx);
}
