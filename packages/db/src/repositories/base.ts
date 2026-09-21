/**
 * Repositorios tipados — IMPL §2.4 capa 2.
 *
 * **La regla que este archivo existe para hacer cumplir:** no hay `findById(id)`.
 * Toda lectura y toda escritura exigen `TenantScope` en la firma, así que olvidarse
 * del `companyId` no es un descuido que compila: es un error de tipos.
 *
 * El acceso cruzado devuelve `null`, nunca una excepción de permisos. El `404` lo
 * traduce la capa de arriba (PRD §9.2: *"nunca 403, para no filtrar existencia"*);
 * desde acá un recurso ajeno y uno inexistente son indistinguibles a propósito.
 *
 * RLS (capa 1) hace lo mismo desde la base. Las dos capas son redundantes **a
 * propósito**: ésta da tipos y mensajes; la otra sigue ahí cuando alguien escribe SQL
 * a mano o cuando un repositorio nuevo se olvida del `WHERE`.
 */

import { and, eq, getTableColumns, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";

import type { Executor } from "../client";
import {
  buildPage,
  cursorCondition,
  cursorOrderBy,
  fetchLimit,
  normalizeLimit,
  type Page,
  type PageRequest,
} from "../pagination";

/** Lo único que abre la puerta a los datos de un workspace. */
export interface TenantScope {
  readonly companyId: string;
}

export interface CompanyScopedTable<TTable extends PgTable> {
  readonly table: TTable;
  /** Clave primaria de la fila. Puede llamarse `id`, `mediaId`, `uploadId`, … */
  readonly id: PgColumn;
  readonly companyId: PgColumn;
  readonly createdAt: PgColumn;
  /** Presente sólo en las tablas con soft-delete (P1-DATA-012). */
  readonly deletedAt?: PgColumn;
}

export interface ListOptions extends PageRequest {
  /**
   * Incluir filas borradas. Default `false`: PRD §9.4 exige
   * *"exclusión por defecto en todos los listados"*. Que haya que pedirlo
   * explícitamente es la mitad del requisito.
   */
  readonly includeDeleted?: boolean;
  /** Filtros adicionales, siempre en AND con el scope de tenant. */
  readonly where?: SQL | undefined;
}

export interface CountOptions {
  readonly includeDeleted?: boolean;
  readonly where?: SQL | undefined;
}

export interface CompanyScopedRepository<TTable extends PgTable> {
  readonly table: TTable;
  findById(
    exec: Executor,
    scope: TenantScope,
    id: string,
    options?: { readonly includeDeleted?: boolean },
  ): Promise<TTable["$inferSelect"] | null>;
  list(
    exec: Executor,
    scope: TenantScope,
    options?: ListOptions,
  ): Promise<Page<TTable["$inferSelect"]>>;
  count(exec: Executor, scope: TenantScope, options?: CountOptions): Promise<number>;
  /** Marca la fila como borrada. `false` si no existía, ya estaba borrada o es ajena. */
  softDelete(exec: Executor, scope: TenantScope, id: string): Promise<boolean>;
}

export function createCompanyScopedRepository<TTable extends PgTable>(
  config: CompanyScopedTable<TTable>,
): CompanyScopedRepository<TTable> {
  type Row = TTable["$inferSelect"];

  // Drizzle devuelve las filas con la clave del schema (camelCase), no con el nombre
  // SQL de la columna. Se resuelve una sola vez, acá, en vez de adivinar con un regex.
  const idKey = propertyKeyOf(config.table, config.id);
  const createdAtKey = propertyKeyOf(config.table, config.createdAt);
  const deletedAtKey =
    config.deletedAt === undefined
      ? undefined
      : propertyKeyOf(config.table, config.deletedAt);

  const liveOnly = (includeDeleted: boolean): SQL | undefined =>
    !includeDeleted && config.deletedAt !== undefined
      ? isNull(config.deletedAt)
      : undefined;

  return {
    table: config.table,

    async findById(exec, scope, id, options = {}) {
      const rows = await exec
        .select()
        .from(config.table as PgTable)
        .where(
          and(
            eq(config.companyId, scope.companyId),
            eq(config.id, id),
            liveOnly(options.includeDeleted ?? false),
          ),
        )
        .limit(1);
      // `select()` sobre un `PgTable` genérico pierde el shape concreto de la fila; se
      // recupera acá. No es `any`: el shape lo garantiza la tabla del propio config.
      return (rows[0] as Row | undefined) ?? null;
    },

    async list(exec, scope, options = {}) {
      const limit = normalizeLimit(options.limit);
      const rows = (await exec
        .select()
        .from(config.table as PgTable)
        .where(
          and(
            eq(config.companyId, scope.companyId),
            liveOnly(options.includeDeleted ?? false),
            options.where,
            cursorCondition(config.createdAt, config.id, options.cursor),
          ),
        )
        .orderBy(...cursorOrderBy(config.createdAt, config.id))
        .limit(fetchLimit(limit))) as Row[];

      return buildPage(rows, limit, (row) => {
        const record = row as Record<string, unknown>;
        const createdAt = record[createdAtKey];
        if (!(createdAt instanceof Date)) {
          throw new Error(
            `Se esperaba una fecha en '${createdAtKey}' para armar el cursor y llegó ` +
              `${typeof createdAt}. La columna tiene que ser timestamptz mode 'date'.`,
          );
        }
        return { createdAt, id: String(record[idKey]) };
      });
    },

    async count(exec, scope, options = {}) {
      const rows = await exec
        .select({ value: sql<number>`count(*)::int` })
        .from(config.table as PgTable)
        .where(
          and(
            eq(config.companyId, scope.companyId),
            liveOnly(options.includeDeleted ?? false),
            options.where,
          ),
        );
      return rows[0]?.value ?? 0;
    },

    async softDelete(exec, scope, id) {
      const deletedAt = config.deletedAt;
      if (deletedAt === undefined || deletedAtKey === undefined) {
        throw new Error(
          "Esta tabla no tiene soft-delete: falta `deletedAt` en el config del " +
            "repositorio. El borrado duro no pasa por acá.",
        );
      }
      // Se usa el query builder y no `sql` crudo por dos razones que costaron un
      // ciclo de test cada una:
      //  - dentro de `SET` va el nombre pelado de la columna; interpolar la columna
      //    renderiza `"contents"."deleted_at"` y Postgres lo rechaza;
      //  - `column.name` es la clave del schema (`deletedAt`), no el nombre SQL: la
      //    conversión a snake_case la hace el dialecto al renderizar, no la columna.
      // El builder resuelve las dos cosas. El cast es sólo porque la columna es
      // dinámica (viene del config) y `set` está tipado por tabla concreta.
      const updated = await exec
        .update(config.table)
        .set({ [deletedAtKey]: new Date() } as PgUpdateSetSource<TTable>)
        .where(
          and(
            eq(config.companyId, scope.companyId),
            eq(config.id, id),
            isNull(deletedAt),
          ),
        )
        .returning({ ok: config.id });
      return updated.length > 0;
    },
  };
}

/** Encuentra la clave del objeto de schema que corresponde a una columna. */
function propertyKeyOf(table: PgTable, column: PgColumn): string {
  for (const [key, candidate] of Object.entries(getTableColumns(table))) {
    if (candidate === column) return key;
  }
  throw new Error(
    `La columna '${column.name}' no pertenece a la tabla del repositorio. ` +
      "Casi siempre es un copy-paste entre dos configs de repositorio.",
  );
}
