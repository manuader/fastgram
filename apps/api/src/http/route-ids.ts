/**
 * Un id de ruta que no es uuid **no existe** — `NFR-006`, PRD §9.2.
 *
 * ## El bug que cierra
 *
 * Los ids del contrato son opacos (`z.string().min(1)`) y las columnas son
 * `uuid`. Mandarle `"no-soy-un-uuid"` a Postgres no devuelve cero filas: levanta
 * `22P02` (*invalid input syntax for type uuid*) y la ruta respondía **500**. Se
 * midió sobre las 17 operaciones con `{id}` del OpenAPI: **11 daban 500**. Sólo
 * `GET /posts/:id` lo comprobaba a mano (`isStorableId`); las demás que zafaban lo
 * hacían por accidente (buscaban en memoria sobre un listado).
 *
 * ## Por qué se reescribe el id y no se responde 404 desde acá
 *
 * Lo que `NFR-006` pide es que el que sondea **no pueda distinguir** nada. Un
 * 404 armado en este hook tendría que adivinar el mensaje de cada ruta
 * (`"content not found"`, `"brand source not found"`…), y peor: `DELETE
 * /media/:id` responde **204** a un id inexistente (borrado idempotente), así que
 * un 404 para la basura sería otra respuesta distinta de la de "no existe".
 *
 * En vez de eso, un id malformado se reemplaza por {@link NONEXISTENT_ID} —un
 * uuid bien formado que ninguna fila tiene— y la ruta sigue su camino normal.
 * Cada ruta contesta entonces **exactamente** lo que contesta para un id que no
 * existe, porque es lo que está recibiendo: mismo status, mismo cuerpo, byte a
 * byte. No depende de cómo la ruta llegue a la base (repositorio genérico,
 * `FOR UPDATE` a mano, búsqueda en memoria), que era justo lo que variaba y
 * rompía en tres de ellas.
 *
 * Lo mide `test/malformed-ids.int.test.ts`, que recorre todas las operaciones
 * con parámetros del OpenAPI y compara la respuesta a la basura contra la de un
 * uuid inexistente.
 *
 * ## Por qué el uuid nulo
 *
 * `00000000-0000-0000-0000-000000000000` no lo genera `gen_random_uuid()` (v4
 * fija bits de versión y variante), y ninguna ruta acepta un id del cliente para
 * crear. No puede resolver a una fila real.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

/** Canónico, como lo emite Postgres. Sin distinguir mayúsculas. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El uuid nulo: bien formado, sin fila posible. Ver la cabecera. */
export const NONEXISTENT_ID = "00000000-0000-0000-0000-000000000000";

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Qué parámetros de ruta son ids. Hoy todos se llaman `id`; se aceptan también
 * `fooId` para que una ruta anidada (`/content/:contentId/posts/:id`) no quede
 * fuera. Un parámetro que no es un id (un `:slug`, un `:platform`) **no** se
 * toca: reescribirlo cambiaría el significado de la petición.
 */
export function isIdParam(name: string): boolean {
  return name === "id" || /[a-z]Id$/.test(name);
}

/**
 * `preValidation`: corre después del hook de scope (una petición sin credencial
 * sigue siendo 401) y antes del schema de la ruta y del handler.
 */
export async function neutralizeMalformedIds(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const params = request.params;
  if (params === null || typeof params !== "object") return;

  const record = params as Record<string, unknown>;
  for (const [name, value] of Object.entries(record)) {
    if (!isIdParam(name) || typeof value !== "string" || isUuid(value)) continue;
    // Al log, sin el valor: puede ser cualquier cosa que el cliente escribió
    // (el barrido de test manda una inyección SQL). El nombre alcanza para saber
    // qué pasó; el valor no le sirve a nadie que lea el log.
    request.log.info({ param: name, reason: "malformed_id" }, "route id is not a uuid");
    record[name] = NONEXISTENT_ID;
  }
  await Promise.resolve();
}
