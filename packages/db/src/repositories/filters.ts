/**
 * Filtros declarativos para los repositorios — `P1-DATA-014`.
 *
 * ## Por qué esto existe
 *
 * Hasta acá, filtrar un listado pedía un `SQL` de Drizzle en `ListOptions.where`.
 * Eso lo vuelve **inusable desde `apps/api`**: `drizzle-orm` vive sólo en
 * `packages/db/node_modules` y las rutas no pueden importarlo — ni deben, porque ahí
 * el aislamiento por tenant pasaría a depender de que nadie se olvide un `WHERE`.
 *
 * El resultado concreto era que `GET /content?type=`, `GET /media?type=` y
 * `GET /posts?status=` devolvían `400 bad_request` diciendo "todavía no se puede
 * filtrar". Un filtro **data** —un objeto plano, sin una sola referencia a Drizzle—
 * cruza esa frontera; el SQL lo arma este archivo, de este lado.
 *
 * ## Por qué operadores explícitos y no "escalar = igual, array = in"
 *
 * Esa versión es más corta de escribir y tiene un modo de falla silencioso: varias
 * columnas del schema son `jsonb` y Drizzle las tipa como `unknown`, así que un valor
 * que *es* un array —`angleWeights`, `position`, cualquier documento— se interpretaría
 * como un `IN` de sus elementos. Sale una consulta válida, sin error, con el resultado
 * equivocado. `{ eq: … }` y `{ in: [ … ] }` no se pueden confundir.
 */

import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/** Los cuatro operadores que hacen falta. Se agregan cuando haya un caso, no antes. */
export type ColumnPredicate<TValue> =
  | { readonly eq: TValue }
  | { readonly in: readonly TValue[] }
  | { readonly isNull: true }
  | { readonly isNotNull: true };

/**
 * Filtro por columnas de una tabla. Las claves son las del schema (camelCase), no los
 * nombres SQL, y el tipo del valor lo impone la columna: `{ status: { in: ["draft"] } }`
 * no compila si `"draft"` no es uno de los valores del enum.
 */
export type RowFilter<TTable extends PgTable> = {
  // El `| undefined` explícito no es redundante: el repo compila con
  // `exactOptionalPropertyTypes`, donde "ausente" y "presente en undefined" son cosas
  // distintas. Sin él, el patrón normal de una ruta —
  // `{ status: q.status === undefined ? undefined : { in: q.status } }`— no compila,
  // y la alternativa es armar el objeto con spreads condicionales en cada handler.
  readonly [K in keyof TTable["$inferSelect"]]?:
    ColumnPredicate<TTable["$inferSelect"][K]> | undefined;
};

/**
 * Nunca coincide con nada.
 *
 * Es la traducción de `{ in: [] }`, y la decisión no es obvia, así que queda escrita:
 * `IN ()` es un error de sintaxis en Postgres, de modo que hay que elegir. La
 * alternativa —omitir la condición— convierte "filtrame por esta lista vacía" en
 * "traeme todo", que es exactamente la respuesta que un cliente no esperaba y que no
 * se nota hasta que alguien mira la lista. Un conjunto vacío no contiene a nadie.
 */
const MATCHES_NOTHING = sql`false`;

/**
 * Compila el filtro a un `SQL`, o `undefined` si no hay nada que filtrar.
 *
 * `companyId` está prohibido a propósito: el scope del repositorio ya lo impone y
 * volver a nombrarlo acá sólo puede significar dos cosas —que alguien cree que así
 * consulta otro workspace (no puede: va en `AND` con el scope y el resultado es vacío)
 * o que un filtro se armó desde input del usuario sin filtrar las claves. Las dos son
 * bugs, y un error ruidoso los muestra en el primer test en vez de en producción.
 */
export function compileFilter<TTable extends PgTable>(
  table: TTable,
  filter: RowFilter<TTable> | undefined,
): SQL | undefined {
  if (filter === undefined) return undefined;

  const columns = getTableColumns(table);
  const conditions: SQL[] = [];

  for (const [key, predicate] of Object.entries(filter)) {
    if (predicate === undefined) continue;

    if (key === "companyId") {
      throw new Error(
        "No se filtra por `companyId`: el scope del repositorio ya lo impone. " +
          "Si el filtro viene de input del usuario, filtrá las claves antes.",
      );
    }

    const column = columns[key];
    if (column === undefined) {
      throw new Error(
        `La columna '${key}' no existe en la tabla del repositorio. Las claves del ` +
          "filtro son las del schema (camelCase), no los nombres SQL.",
      );
    }

    if ("eq" in predicate) {
      // `eq(col, null)` genera `= NULL`, que en SQL nunca es verdadero — ni siquiera
      // para las filas con NULL. Se redirige a `IS NULL`, que es lo que se quiso decir.
      conditions.push(predicate.eq === null ? isNull(column) : eq(column, predicate.eq));
    } else if ("in" in predicate) {
      conditions.push(
        predicate.in.length === 0 ? MATCHES_NOTHING : inArray(column, [...predicate.in]),
      );
    } else if ("isNull" in predicate) {
      conditions.push(isNull(column));
    } else {
      conditions.push(isNotNull(column));
    }
  }

  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : and(...conditions);
}
