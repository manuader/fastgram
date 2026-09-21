/**
 * El lado de la base del handler de `content-build` — `FR-050`, IMPL §2.3.
 *
 * ## Por qué no alcanza con `contentRepository`
 *
 * Porque lo que hace falta acá es **leer bloqueando**, y la fábrica genérica no
 * lo hace. El handler del build corre en otro proceso y compite con la API: el
 * usuario puede estar editando la misma pieza mientras el render corre.
 *
 * La carrera concreta, con el aislamiento por defecto de Postgres:
 *
 * ```
 *   worker: lee la pieza, revision = 2        ← sin bloqueo
 *   api:    PATCH /content/:id → revision = 3, status = BUILDING, encola otro build
 *   worker: escribe files + status = CREATED  ← pisa la edición
 * ```
 *
 * El resultado es una pieza en `CREATED` con el render **anterior** a la
 * edición y una `revision` que dice 3. No falla nada, no hay log, y el usuario
 * ve su edición aplicada en los metadatos y ausente en el video. El segundo
 * build llega después y lo arregla… o no, si corrió primero.
 *
 * {@link lockContent} cierra esa ventana: a partir del `FOR UPDATE`, el `PATCH`
 * de la API espera a que el handler confirme, y entonces la comparación de
 * `revision` que hace el handler vale de verdad. Es el mismo patrón —y por la
 * misma razón— que `quotaLedgerStore.lockPeriod`.
 *
 * ## Por qué vive en `packages/db` y no en el worker
 *
 * Porque es SQL, y `apps/worker` no puede importar `drizzle-orm`: no es
 * alcanzable a propósito, igual que en `apps/api`. Es lo que impide que un
 * proceso arme su propio `WHERE` y se olvide el tenant.
 */

import { and, eq, isNull } from "drizzle-orm";

import type { Executor } from "../client.js";
import { contents } from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type ContentRow = typeof contents.$inferSelect;

/**
 * Lee la pieza y la deja **bloqueada** hasta el fin de la transacción.
 *
 * Devuelve `null` si no existe, es de otro workspace o está borrada — los tres
 * casos son lo mismo para quien llama, y para el handler significan «no hay
 * nada que construir», que no es un error.
 *
 * Quien llame tiene que estar dentro de una transacción: fuera de una, el
 * `FOR UPDATE` se libera al terminar la sentencia y no protege nada. El
 * `Executor` no distingue, así que queda escrito.
 */
export async function lockContent(
  exec: Executor,
  scope: TenantScope,
  contentId: string,
): Promise<ContentRow | null> {
  const filas = await exec
    .select()
    .from(contents)
    .where(
      and(
        eq(contents.companyId, scope.companyId),
        eq(contents.id, contentId),
        // Una pieza borrada no se construye ni se marca `FAILED`: el borrado
        // **no** devuelve el save (DATA-008 y §16.2 lo dicen dos veces), así
        // que reembolsarla acá sería regalar cuota por borrar a tiempo.
        isNull(contents.deletedAt),
      ),
    )
    .for("update")
    .limit(1);

  return filas[0] ?? null;
}

export const contentBuildStore = {
  table: contents,
  lockContent,
};
