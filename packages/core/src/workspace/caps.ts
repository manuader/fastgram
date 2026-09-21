/**
 * Caps por workspace — PRD §16.2, `FR-056`, `NFR-025`, `FR-011.6`.
 *
 * **El problema que resuelve este archivo no es "faltan los números".** Los
 * números ya existían, con su test, en `quota/plans.ts`. Lo que faltaba era
 * que alguien los mirara antes de escribir: la base aceptaba el ángulo 101, el
 * influencer activo 51 y la sexta brand source. Un cap declarado y no aplicado
 * es peor que no tenerlo, porque el equipo cree que está cubierto.
 *
 * Los cuatro son **conteos**, y los cuatro se equivocan del mismo modo:
 *
 * 1. **Contando lo borrado.** El PRD dice «borrar libera slot» y el borrado es
 *    soft-delete. Si el `count` no excluye `deletedAt`, el workspace se queda
 *    trabado en 100 ángulos para siempre y el usuario no puede hacer nada,
 *    porque los que ve son 80.
 *
 * 2. **Contando lo inactivo.** El cap de influencers es sobre los **activos**.
 *    Un workspace Pro puede tener 2 000 personajes creados y sólo 50 activos a
 *    la vez; contar los 2 000 lo bloquea con 49 activos.
 *
 * 3. **Comparando con `>` en vez de `>=`.** Deja pasar exactamente uno de más.
 *    Es el error que ningún test que pruebe "1 y 200" detecta; hay que probar
 *    el borde. Por eso todos los tests de acá prueban `N-1`, `N` y `N+1`.
 *
 * 4. **Chequeando fuera de la transacción.** Dos peticiones concurrentes leen
 *    99 y las dos crean. El chequeo va dentro de la misma transacción que la
 *    inserción; estas funciones son puras, y quien las llama es responsable de
 *    que el conteo venga de la misma transacción que escribe.
 */
import { DomainError } from "../errors.js";
import { HARD_CAPS } from "../quota/plans.js";

/**
 * Códigos literales que el PRD nombra para estos caps.
 *
 * Los de ángulos viven en `angles/angles.ts` (`ANGLE_ERROR_CODES`); acá están
 * los que el PRD nombra en otras secciones. Los que el PRD **no** nombra no se
 * inventan: viajan sólo con `out_of_range` y el mensaje.
 */
export const WORKSPACE_CAP_CODES = {
  /** `ERR-B10` · §19.5.1. */
  maxBrandSources: "ERR-B10",
} as const;

/**
 * Influencers **activos** por workspace — 50 (§16.2).
 *
 * `activeCount` son los que ya están activos, sin contar el que se quiere
 * activar. El cap es sobre activos y no sobre creados: es un límite de
 * capacidad de generación, no de almacenamiento.
 */
export function assertCanActivateInfluencer(activeCount: number): void {
  if (activeCount >= HARD_CAPS.activeInfluencers) {
    throw new DomainError(
      "out_of_range",
      `You can have up to ${HARD_CAPS.activeInfluencers} active influencers. Deactivate one to make room.`,
      { cap: HARD_CAPS.activeInfluencers, activeCount },
    );
  }
}

/**
 * Brand sources por workspace — 5 (`FR-011.6`, `DATA-031`).
 *
 * El mensaje es el literal del PRD (`ERR-B10`): «You can analyse up to 5
 * sources per workspace.» Se conserva palabra por palabra porque §19.5.1 lo
 * lista como copy, no como descripción.
 */
export function assertCanAddBrandSource(currentCount: number): void {
  if (currentCount >= HARD_CAPS.brandSources) {
    throw new DomainError(
      "out_of_range",
      `You can analyse up to ${HARD_CAPS.brandSources} sources per workspace.`,
      { code: WORKSPACE_CAP_CODES.maxBrandSources, cap: HARD_CAPS.brandSources },
    );
  }
}

/**
 * Generaciones de AI Studio **en vuelo** por workspace — 10 (`NFR-025`, §9.5 #6).
 *
 * "En vuelo" es el estado, no el total histórico: encoladas o corriendo. Es un
 * límite de concurrencia contra la GPU, así que se libera cuando la generación
 * termina —bien o mal—, no cuando el usuario borra el resultado.
 *
 * Se aplica **antes de encolar**, como dice el puerto `Queue`: «`NFR-025` se
 * aplica antes de encolar». Aplicarlo en el worker sería tarde: los 200 jobs
 * ya están en la cola y alguien tiene que decidir qué hacer con ellos.
 */
export function assertCanStartGeneration(inFlightCount: number): void {
  if (inFlightCount >= HARD_CAPS.inFlightGenerations) {
    throw new DomainError(
      "out_of_range",
      `You already have ${HARD_CAPS.inFlightGenerations} generations running. Wait for one to finish.`,
      { cap: HARD_CAPS.inFlightGenerations, inFlightCount },
    );
  }
}

/**
 * Ids por operación en lote — 100 (§16.2).
 *
 * No estaba en el encargo, pero es el mismo tipo de cap y el mismo tipo de
 * agujero: un `POST /posts/delete` con 40 000 ids es un `DELETE ... IN (...)`
 * que bloquea la tabla. Va acá porque es un conteo, no una cuota.
 */
export function assertBatchSize(ids: readonly string[]): void {
  if (ids.length === 0) {
    throw new DomainError("out_of_range", "Send at least one id.", { count: 0 });
  }
  if (ids.length > HARD_CAPS.idsPerBatch) {
    throw new DomainError(
      "out_of_range",
      `You can send up to ${HARD_CAPS.idsPerBatch} ids at a time.`,
      { cap: HARD_CAPS.idsPerBatch, count: ids.length },
    );
  }
}
