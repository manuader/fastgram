/**
 * El job que lee una referencia — Inspiration de uso personal (`F-041`).
 *
 * ## Por qué viaja por la cola `media-import`
 *
 * Una cola nueva pedía tocar `JOB_QUEUES`, el catálogo del worker, el
 * invariante de `check-consistency` y los grants: archivos compartidos para
 * una política que es **la misma** del import por link (es `yt-dlp` contra un
 * sitio de terceros, dos intentos, uno a la vez). Mismo criterio que «crear
 * desde prompt» sobre `discovery-refill`: el payload lleva
 * `inspirationItemId` y el despachador del worker lo manda a su handler
 * (`apps/worker/src/inspiration/dispatcher.ts`). Un payload de import nunca
 * tiene ese campo, así que lo de siempre sigue yendo al handler de siempre.
 *
 * La `singletonKey` lleva el id de la referencia, nuevo en cada alta: no se
 * repite nunca (trampas 39 y 45).
 */

export interface InspirationIngestJob {
  readonly companyId: string;
  readonly inspirationItemId: string;
  /** El link que pegó el dueño, ya validado por `checkImportUrl`. */
  readonly url: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ¿Es un payload de Inspiration? Lo decide la presencia del campo, como `promptRequestId`. */
export function isInspirationIngestPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" && payload !== null && "inspirationItemId" in payload
  );
}

export function parseInspirationIngestJob(
  payload: unknown,
): { ok: true; job: InspirationIngestJob } | { ok: false; reason: string } {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "el payload no es un objeto" };
  }
  const p = payload as Record<string, unknown>;
  for (const field of ["companyId", "inspirationItemId"] as const) {
    const v = p[field];
    if (typeof v !== "string" || !UUID.test(v)) {
      return { ok: false, reason: `${field} ausente o no es un uuid` };
    }
  }
  if (typeof p["url"] !== "string" || p["url"].length === 0) {
    return { ok: false, reason: "url ausente" };
  }
  return {
    ok: true,
    job: {
      companyId: p["companyId"] as string,
      inspirationItemId: p["inspirationItemId"] as string,
      url: p["url"],
    },
  };
}

export function inspirationIngestSingletonKey(itemId: string): string {
  return `inspiration:${itemId}`;
}

/** Tope duro de la lectura de metadata (sin bajar el clip): una página, no un video. */
export const INSPIRATION_INGEST_TIMEOUT_MS = 90_000;

/** Tope de la miniatura que se copia al storage. */
export const INSPIRATION_THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;
