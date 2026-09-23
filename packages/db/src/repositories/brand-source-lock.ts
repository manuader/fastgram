/**
 * La lectura bloqueante de `POST /brand/sources/:id/reanalyse` — `ERR-B11`,
 * `DATA-031`.
 *
 * ## La carrera que cierra
 *
 * La ruta decide sobre lo que lee —`startAnalysis` rechaza una fuente que ya
 * está `analyzing` y aplica el cooldown sobre `analysisCount`— y después
 * escribe el estado nuevo y encola. Con una lectura sin bloqueo:
 *
 * ```
 *   pedido 1: lee la fuente, status = ready
 *   pedido 2: lee la fuente, status = ready          ← nadie la bloqueó
 *   pedido 1: UPDATE → analyzing, encola, commit
 *   pedido 2: UPDATE → analyzing (espera y pasa), encola, commit
 * ```
 *
 * Dos jobs para un solo re-análisis. El `UPDATE` del pedido 2 **no** hace de
 * guarda (trampa 37 al revés): espera al 1, reevalúa su `WHERE`, y el `WHERE`
 * es sólo `id` + `companyId`, que siguen siendo ciertos. Lo que la ruta decidió
 * —«no está `analyzing`»— vive en TypeScript, no en el `WHERE`.
 *
 * Con {@link lockBrandSource} el pedido 2 espera en la **lectura** hasta que el
 * 1 confirma, y lee `analyzing`: `startAnalysis` lo rechaza con `409`.
 *
 * ## Por qué un `FOR UPDATE` y no un `UPDATE … WHERE status <> 'analyzing'`
 *
 * El cooldown de `ERR-B11` también depende de lo leído (`analysisCount`,
 * `lastAnalysedAt`), y codificar `assertCanReanalyse` en SQL duplicaría una
 * regla de `core` en dos lenguajes. Con el bloqueo, `core` sigue siendo el
 * único que decide y lo hace sobre la fila que va a quedar.
 *
 * ## Por qué vive en `packages/db`
 *
 * `apps/api` no importa `drizzle-orm`. El `WHERE` lleva `companyId` además de
 * RLS: el test de `brand-source-lock.int.test.ts` lo mide sin GUC (trampa 26).
 */

import { and, eq } from "drizzle-orm";

import type { Executor } from "../client.js";
import { brandSources } from "../schema/index.js";
import type { TenantScope } from "./base.js";

type BrandSourceLockRow = typeof brandSources.$inferSelect;

/**
 * Lee la fuente y la deja **bloqueada** hasta el fin de la transacción.
 *
 * `null` si no existe o es de otro workspace — los dos son el mismo `404` de
 * §9.2 para quien llama. `brand_sources` no tiene soft-delete: el borrado es
 * real, así que no hay filtro de `deletedAt` que olvidar.
 *
 * Quien llame tiene que estar dentro de una transacción: fuera de una, el
 * `FOR UPDATE` se libera al terminar la sentencia y no protege nada.
 */
export async function lockBrandSource(
  exec: Executor,
  scope: TenantScope,
  brandSourceId: string,
): Promise<BrandSourceLockRow | null> {
  const filas = await exec
    .select()
    .from(brandSources)
    .where(
      and(
        eq(brandSources.companyId, scope.companyId),
        eq(brandSources.id, brandSourceId),
      ),
    )
    .for("update")
    .limit(1);
  return filas[0] ?? null;
}
