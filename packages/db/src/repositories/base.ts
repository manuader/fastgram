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
 *
 * ## Escritura (`P1-DATA-014`)
 *
 * La propiedad que sostiene todo lo de abajo es más fuerte que "acordate del scope":
 * **`companyId` no está en el tipo de los valores**. `create` lo inyecta desde el
 * scope y `update` lo rechaza. No es que no debas crear una fila en otro workspace:
 * es que no tenés dónde escribir el campo.
 */

import {
  and,
  eq,
  getTableColumns,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";

import type { Executor } from "../client.js";
import {
  buildOffsetPage,
  buildPage,
  cursorCondition,
  cursorOrderBy,
  fetchLimit,
  normalizeLimit,
  normalizePage,
  offsetOf,
  type OffsetPage,
  type OffsetPageRequest,
  type Page,
  type PageRequest,
} from "../pagination.js";
import { compileFilter, type RowFilter } from "./filters.js";

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
  /**
   * Columnas del índice único sobre el que resuelve `upsert`.
   *
   * Es **explícito y opcional** en vez de deducirse de `id`, porque deducirlo se
   * equivoca justo donde más duele: en `quota_ledgers` la PK es `(companyId, period)`
   * y `id` apunta sólo a `period`, que no es único por sí solo. Postgres rechazaría
   * ese `ON CONFLICT` en tiempo de ejecución, no de compilación. Sin este campo,
   * `upsert` no existe para la tabla y lo dice.
   */
  readonly upsertTarget?: readonly PgColumn[];
}

export interface ListOptions<TTable extends PgTable> extends PageRequest {
  /**
   * Incluir filas borradas. Default `false`: PRD §9.4 exige
   * *"exclusión por defecto en todos los listados"*. Que haya que pedirlo
   * explícitamente es la mitad del requisito.
   */
  readonly includeDeleted?: boolean;
  /** Filtro declarativo, siempre en AND con el scope de tenant. Ver `filters.ts`. */
  readonly filter?: RowFilter<TTable>;
}

export interface OffsetListOptions<TTable extends PgTable> extends OffsetPageRequest {
  readonly includeDeleted?: boolean;
  readonly filter?: RowFilter<TTable>;
}

export interface CountOptions<TTable extends PgTable> {
  readonly includeDeleted?: boolean;
  readonly filter?: RowFilter<TTable>;
}

/**
 * Valores para crear una fila.
 *
 * `companyId` sale del tipo a propósito: lo pone el repositorio desde el scope. Que
 * el campo no exista es lo que hace imposible —y no sólo desaconsejable— crear una
 * fila en otro workspace.
 */
export type InsertValues<TTable extends PgTable> = Omit<
  TTable["$inferInsert"],
  "companyId"
>;

/** Igual que `InsertValues` pero parcial: un `PATCH` toca lo que toca. */
export type UpdateValues<TTable extends PgTable> = Partial<InsertValues<TTable>>;

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
    options?: ListOptions<TTable>,
  ): Promise<Page<TTable["$inferSelect"]>>;

  /** Paginación numerada (`Page X of Y`, PRD §9.10). Cuesta un `COUNT(*)` por request. */
  listByPage(
    exec: Executor,
    scope: TenantScope,
    options?: OffsetListOptions<TTable>,
  ): Promise<OffsetPage<TTable["$inferSelect"]>>;

  count(exec: Executor, scope: TenantScope, options?: CountOptions<TTable>): Promise<number>;

  /** Crea una fila en el workspace del scope. Devuelve la fila tal como quedó. */
  create(
    exec: Executor,
    scope: TenantScope,
    values: InsertValues<TTable>,
  ): Promise<TTable["$inferSelect"]>;

  /** Inserta varias en una sola sentencia. Con lista vacía no toca la base. */
  createMany(
    exec: Executor,
    scope: TenantScope,
    values: readonly InsertValues<TTable>[],
  ): Promise<TTable["$inferSelect"][]>;

  /** `null` si no existía, es ajena o está borrada. */
  update(
    exec: Executor,
    scope: TenantScope,
    id: string,
    values: UpdateValues<TTable>,
  ): Promise<TTable["$inferSelect"] | null>;

  /**
   * Inserta, o actualiza si ya existe. Requiere `upsertTarget` en el config.
   * `null` significa que la fila existe **y es de otro workspace**.
   */
  upsert(
    exec: Executor,
    scope: TenantScope,
    values: InsertValues<TTable>,
  ): Promise<TTable["$inferSelect"] | null>;

  /** Marca la fila como borrada. `false` si no existía, ya estaba borrada o es ajena. */
  softDelete(exec: Executor, scope: TenantScope, id: string): Promise<boolean>;

  /** Borrado real. Sólo para las tablas que el PRD no declara con soft-delete. */
  hardDelete(exec: Executor, scope: TenantScope, id: string): Promise<boolean>;
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

  const companyIdKey = propertyKeyOf(config.table, config.companyId);

  // `updatedAt` es una convención uniforme del schema (`_shared.ts` la aplica a casi
  // todas las tablas; las append-only usan `createdAtOnly`). Detectarla por nombre es
  // menos frágil que pedirla en cada uno de los 28 configs, donde faltaría en el que
  // se agregue mañana — y ahí el síntoma sería una fecha que no se mueve nunca.
  const hasUpdatedAt = "updatedAt" in getTableColumns(config.table);

  const liveOnly = (includeDeleted: boolean): SQL | undefined =>
    !includeDeleted && config.deletedAt !== undefined
      ? isNull(config.deletedAt)
      : undefined;

  const scoped = (scope: TenantScope, ...extra: (SQL | undefined)[]): SQL | undefined =>
    and(eq(config.companyId, scope.companyId), ...extra);

  async function findOne(
    exec: Executor,
    scope: TenantScope,
    id: string,
    includeDeleted: boolean,
  ): Promise<Row | null> {
    const rows = await exec
      .select()
      .from(config.table as PgTable)
      .where(scoped(scope, eq(config.id, id), liveOnly(includeDeleted)))
      .limit(1);
    // `select()` sobre un `PgTable` genérico pierde el shape concreto de la fila; se
    // recupera acá. No es `any`: el shape lo garantiza la tabla del propio config.
    return (rows[0] as Row | undefined) ?? null;
  }

  /**
   * Rechaza las claves que el scope ya decide.
   *
   * El tipo ya las excluye, pero un patch armado desde un body JSON llega como
   * `Record<string, unknown>` y el tipo no lo mira. Acá se nota en el primer test.
   */
  const rejectReservedKeys = (values: Record<string, unknown>, operation: string): void => {
    if (companyIdKey in values) {
      throw new Error(
        `\`${operation}\` no acepta '${companyIdKey}': lo impone el scope. Mover una ` +
          "fila de workspace no es una operación de este sistema.",
      );
    }
  };

  return {
    table: config.table,

    async findById(exec, scope, id, options = {}) {
      return findOne(exec, scope, id, options.includeDeleted ?? false);
    },

    async list(exec, scope, options = {}) {
      const limit = normalizeLimit(options.limit);
      const rows = (await exec
        .select()
        .from(config.table as PgTable)
        .where(
          scoped(
            scope,
            liveOnly(options.includeDeleted ?? false),
            compileFilter(config.table, options.filter),
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

    async listByPage(exec, scope, options = {}) {
      const pageSize = normalizeLimit(options.limit);
      const page = normalizePage(options.page);
      const where = scoped(
        scope,
        liveOnly(options.includeDeleted ?? false),
        compileFilter(config.table, options.filter),
      );

      // Las dos consultas van en la misma transacción que el llamador abrió, así que
      // el total y la página que se devuelven son del mismo snapshot. Contarlos en
      // dos transacciones distintas puede dar "Page 3 of 2".
      const totals = await exec
        .select({ value: sql<number>`count(*)::int` })
        .from(config.table as PgTable)
        .where(where);

      const rows = (await exec
        .select()
        .from(config.table as PgTable)
        .where(where)
        .orderBy(...cursorOrderBy(config.createdAt, config.id))
        .limit(pageSize)
        .offset(offsetOf(page, pageSize))) as Row[];

      return buildOffsetPage(rows, page, pageSize, totals[0]?.value ?? 0);
    },

    async count(exec, scope, options = {}) {
      const rows = await exec
        .select({ value: sql<number>`count(*)::int` })
        .from(config.table as PgTable)
        .where(
          scoped(
            scope,
            liveOnly(options.includeDeleted ?? false),
            compileFilter(config.table, options.filter),
          ),
        );
      return rows[0]?.value ?? 0;
    },

    async create(exec, scope, values) {
      rejectReservedKeys(values as Record<string, unknown>, "create");
      const rows = await exec
        .insert(config.table)
        .values({
          ...values,
          [companyIdKey]: scope.companyId,
        } as TTable["$inferInsert"])
        .returning();

      const row = rows[0] as Row | undefined;
      if (row === undefined) {
        // Un INSERT sin `ON CONFLICT` que no devuelve fila no pasa salvo que alguien
        // agregue una regla o un trigger que lo suprima. Es mejor un error acá que un
        // `undefined` viajando hasta el serializador de la ruta.
        throw new Error("El INSERT no devolvió la fila creada.");
      }
      return row;
    },

    async createMany(exec, scope, values) {
      // Drizzle rompe con `values([])` en vez de ser un no-op, y "crear cero filas" es
      // un caso normal (un contenido sin cajas de texto, por ejemplo).
      if (values.length === 0) return [];

      for (const value of values) {
        rejectReservedKeys(value as Record<string, unknown>, "createMany");
      }

      const rows = await exec
        .insert(config.table)
        .values(
          values.map(
            (value) =>
              ({ ...value, [companyIdKey]: scope.companyId }) as TTable["$inferInsert"],
          ),
        )
        .returning();
      return rows as Row[];
    },

    async update(exec, scope, id, values) {
      const patch = values as Record<string, unknown>;
      rejectReservedKeys(patch, "update");
      if (idKey in patch) {
        throw new Error(
          `\`update\` no acepta '${idKey}': cambiar la identidad de una fila no es ` +
            "una actualización. Creá otra y borrá ésta.",
        );
      }

      // Un PATCH vacío es una petición válida y su respuesta correcta es la fila como
      // está. Escribir sólo `updatedAt` mentiría: diría que algo cambió.
      if (Object.keys(patch).length === 0) {
        return findOne(exec, scope, id, false);
      }

      const rows = await exec
        .update(config.table)
        .set({
          ...patch,
          // No hay `$onUpdate` en el schema, así que si no se pone acá no se pone en
          // ningún lado, y la columna quedaría clavada en la fecha de creación.
          ...(hasUpdatedAt ? { updatedAt: new Date() } : {}),
        } as PgUpdateSetSource<TTable>)
        .where(
          // `liveOnly` va también acá: una fila borrada no se edita. Sin esto, un
          // `PATCH` sobre contenido borrado lo resucitaría a medias — editado, con
          // `deletedAt` puesto, invisible en los listados y vivo en la base.
          scoped(scope, eq(config.id, id), liveOnly(false)),
        )
        .returning();

      return (rows[0] as Row | undefined) ?? null;
    },

    async upsert(exec, scope, values) {
      const target = config.upsertTarget;
      if (target === undefined || target.length === 0) {
        throw new Error(
          "Esta tabla no declara `upsertTarget`. Agregalo al config nombrando las " +
            "columnas del índice único sobre el que tiene que resolver el conflicto.",
        );
      }
      rejectReservedKeys(values as Record<string, unknown>, "upsert");

      const row = { ...values, [companyIdKey]: scope.companyId } as TTable["$inferInsert"];
      const { [companyIdKey]: _ignored, ...updatable } = row as Record<string, unknown>;

      const rows = await exec
        .insert(config.table)
        .values(row)
        .onConflictDoUpdate({
          target: [...target],
          set: {
            ...updatable,
            ...(hasUpdatedAt ? { updatedAt: new Date() } : {}),
          } as PgUpdateSetSource<TTable>,
          // Convierte el choque contra la fila de otro workspace en "no pasó nada".
          //
          // Hace falta porque hay targets que no incluyen `companyId`:
          // `content_text_boxes` resuelve por `(contentId, id)` y
          // `influencer_configs` por `influencerId`. Sin esto, el `ON CONFLICT`
          // resolvería en un UPDATE sobre la fila ajena.
          //
          // **Medido**, porque la intuición acá se equivoca: quitándolo, RLS igual
          // frena la escritura — Postgres tira *"new row violates row-level security
          // policy (USING expression) for table content_text_boxes"*. O sea que la
          // capa 1 sostiene. Lo que cambia es **la forma del fallo**: una excepción
          // de base sale como `500`, y un `500` sólo en los ids que existen en otro
          // workspace es justamente el canal lateral que PRD §9.2 quiere cerrar
          // cuando pide 404 y no 403. Con el `setWhere`, `returning()` vuelve vacío,
          // el método devuelve `null` y la ruta responde el mismo 404 que para un id
          // inventado.
          setWhere: eq(config.companyId, scope.companyId),
        })
        .returning();

      return (rows[0] as Row | undefined) ?? null;
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
        .where(scoped(scope, eq(config.id, id), isNull(deletedAt)))
        .returning({ ok: config.id });
      return updated.length > 0;
    },

    async hardDelete(exec, scope, id) {
      if (config.deletedAt !== undefined) {
        throw new Error(
          "Esta tabla tiene soft-delete: usá `softDelete`. PRD §9.4 exige que estas " +
            "filas se puedan excluir de los listados, no que desaparezcan.",
        );
      }
      const deleted = await exec
        .delete(config.table)
        .where(scoped(scope, eq(config.id, id)))
        .returning({ ok: config.id });
      return deleted.length > 0;
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
