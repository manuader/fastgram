/**
 * Conexión a Postgres.
 *
 * `casing: "snake_case"` se configura acá **y** en `drizzle.config.ts`. Las dos tienen
 * que coincidir: si una sola cambia, el schema generado y el que consulta el runtime
 * dejan de hablar el mismo idioma y el error aparece recién en la primera query.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Notice, type Sql } from "postgres";

import * as schema from "./schema/index";

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

/** Una transacción de drizzle: lo que recibe el callback de `db.transaction`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Lo que aceptan los repositorios: la conexión o una transacción abierta.
 * Todo repositorio recibe un `Executor` en vez de capturar la conexión, que es lo que
 * permite componer varias escrituras en la misma transacción (IMPL §2.3: el encolado
 * ocurre dentro de la transacción que descuenta la cuota).
 */
export type Executor = Database | Transaction;

export interface CreateDbOptions {
  readonly url: string;
  /** Tamaño del pool. `postgres` usa 10 por defecto. */
  readonly max?: number;
  readonly logger?: boolean;
  /** Silenciar los `NOTICE` de Postgres (los tests de integración los generan). */
  readonly onnotice?: (notice: Notice) => void;
}

export interface DbHandle {
  readonly db: Database;
  readonly sql: Sql;
  close(): Promise<void>;
}

export function createDb(options: CreateDbOptions): DbHandle {
  const client = postgres(options.url, {
    max: options.max ?? 10,
    ...(options.onnotice === undefined ? {} : { onnotice: options.onnotice }),
  });

  const db = drizzle(client, {
    schema,
    casing: "snake_case",
    logger: options.logger ?? false,
  });

  return {
    db,
    sql: client,
    close: () => client.end({ timeout: 5 }),
  };
}
