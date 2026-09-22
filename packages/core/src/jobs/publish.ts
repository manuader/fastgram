/**
 * El payload del job `publishing` — PRD §9.5 #8, `FR-060`.
 *
 * Mismo criterio que `content-build.ts` y por la misma razón: el payload es
 * contrato entre dos procesos y vuelve de la cola como `unknown`, porque viajó
 * por JSON en una tabla de Postgres. Un `as` ahí es una mentira que el
 * compilador no puede desmentir, y el modo de falla no es un crash: es un
 * `WHERE id = 'undefined'` que no encuentra nada y hace concluir al handler que
 * el post se borró.
 *
 * ## Por qué es tan chico
 *
 * Lleva **sólo** a quién releer, y eso es deliberado. La ruta que lo encola lo
 * dice: *"el worker relee la fila con su propio scope. Copiar caption, cuenta o
 * privacidad acá los congelaría en el momento de programar, y un `Reschedule`
 * posterior publicaría lo viejo."* Un payload gordo es un snapshot que envejece.
 */

/** Lo que viaja en la cola `publishing`. */
export interface PublishJob {
  readonly companyId: string;
  readonly postId: string;
}

export type ParsedPublishJob =
  | { readonly ok: true; readonly payload: PublishJob }
  | { readonly ok: false; readonly reason: string };

/**
 * Valida un payload que vuelve de la cola.
 *
 * Devuelve un resultado en vez de lanzar porque el llamador **no debe
 * reintentar**: acá no hay reintentos que gastar (`maxAttempts: 1`, `NFR-005`),
 * y un payload mal formado es un bug del productor, no un fallo de
 * infraestructura.
 */
export function parsePublishJob(raw: unknown): ParsedPublishJob {
  if (typeof raw !== "object" || raw === null)
    return { ok: false, reason: "payload is not an object" };
  const source = raw as Record<string, unknown>;

  const { companyId, postId } = source;
  if (typeof companyId !== "string" || companyId.length === 0)
    return { ok: false, reason: "companyId is missing" };
  if (typeof postId !== "string" || postId.length === 0)
    return { ok: false, reason: "postId is missing" };

  return { ok: true, payload: { companyId, postId } };
}
