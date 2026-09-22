/**
 * El lado de la base del handler de publicación — `NFR-005`, `NFR-015`,
 * `DATA-020`.
 *
 * ## Por qué el bloqueo importa acá MÁS que en el build
 *
 * Porque publicar **no es idempotente**. El job tiene `maxAttempts: 1` por eso:
 * un segundo intento puede dejar **dos posts en la cuenta del usuario**, y eso
 * no se deshace desde este lado. Un build que se repite gasta CPU; una
 * publicación que se repite es un post de más en una cuenta real.
 *
 * La carrera concreta, con el aislamiento por defecto de Postgres:
 *
 * ```
 *   worker: lee el post, status = SCHEDULED       ← sin bloqueo
 *   api:    POST /posts/:id/cancel → status = CANCELLED
 *   worker: publica igual, y escribe POSTED
 * ```
 *
 * …o el mismo par al revés, y entonces la fila dice `POSTED` y el cancel la pisa
 * con `CANCELLED`. Los dos finales son el mismo bug visto desde dos lados: **un
 * post publicado que la UI muestra como cancelado**. Nada falla, no hay log, y
 * el usuario sólo se entera mirando su cuenta.
 *
 * {@link lockPost} cierra esa ventana: a partir del `FOR UPDATE`, el cancel
 * espera a que el handler confirme, y la decisión que el handler tomó sobre el
 * estado que leyó sigue siendo válida cuando escribe.
 *
 * ## Por qué vive en `packages/db`
 *
 * Igual que `content-build.ts`: es SQL, y `apps/worker` no puede importar
 * `drizzle-orm`. Es lo que impide que un proceso arme su propio `WHERE` y se
 * olvide el tenant.
 */

import { and, eq } from "drizzle-orm";

import type { Executor } from "../client.js";
import { posts } from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type PostRow = typeof posts.$inferSelect;

/**
 * Lee el post y lo deja **bloqueado** hasta el fin de la transacción.
 *
 * Devuelve `null` si no existe o es de otro workspace. Los dos casos son lo
 * mismo para quien llama (PRD §9.2: el `404` invisible), y para el handler
 * significan «no hay nada que publicar», que no es un error. Si esto trajera la
 * fila de otro workspace, un payload manipulado en la cola alcanzaría para
 * publicar en la cuenta de otro cliente.
 *
 * **No hay filtro de soft-delete, y no es un olvido:** `posts` no tiene
 * `deletedAt`. `DELETED` es un valor de `post_status` y el borrado es real, así
 * que el estado terminal lo decide el handler leyendo `status` — que es
 * exactamente lo que este bloqueo protege. Copiar el `isNull(deletedAt)` de
 * `lockContent` acá ni siquiera compilaría.
 *
 * Devuelve la fila entera: el handler necesita `platform`, `connectionId` /
 * `warmedAccountId`, `caption`, `status` y `externalPostId`, y proyectar sólo
 * dejaría una lista que hay que mantener sincronizada con el handler.
 *
 * Quien llame tiene que estar dentro de una transacción: fuera de una, el
 * `FOR UPDATE` se libera al terminar la sentencia y no protege nada. El
 * `Executor` no distingue, así que queda escrito.
 */
export async function lockPost(
  exec: Executor,
  scope: TenantScope,
  postId: string,
): Promise<PostRow | null> {
  const filas = await exec
    .select()
    .from(posts)
    .where(and(eq(posts.companyId, scope.companyId), eq(posts.id, postId)))
    .for("update")
    .limit(1);

  return filas[0] ?? null;
}

export const postPublishStore = {
  table: posts,
  lockPost,
};
