/**
 * Privilegios del rol de la aplicación sobre el esquema de la cola.
 *
 * ## Por qué hace falta además de la migración `0004`
 *
 * `0004` deja los grants sobre `pgboss`, que es el default. Pero el nombre del
 * esquema es **configurable** (`QUEUE_SCHEMA`), y una migración SQL no se
 * parametriza: con cualquier otro nombre, `fastgram_app` no recibe nada y todo
 * encolado muere con *"permission denied for schema …"*.
 *
 * Eso no es teórico — lo encontró `scripts/smoke-binary.mjs` la primera vez que
 * corrió, usando un esquema efímero para no pisar el de desarrollo. Y es un
 * fallo con la peor forma posible: el proceso arranca sano, `/health` responde
 * 200, y sólo la primera petición que encola se cae.
 *
 * ## Por qué acá y no dentro del adaptador
 *
 * Porque el nombre del rol es de este sistema, no de pg-boss. El adaptador no
 * tiene por qué saber que existe un `fastgram_app`; lo que sí sabe este paquete
 * es qué rol usa la aplicación y qué significa `FORCE ROW LEVEL SECURITY` acá.
 *
 * ## Cuándo se llama
 *
 * Sólo cuando el proceso ya está autorizado a tocar el esquema de la cola, o
 * sea junto a la migración de pg-boss. Un proceso que no migra tampoco debería
 * estar repartiendo privilegios, y en producción eso va en el deploy: IMPL §4
 * pide migraciones ordenables respecto del resto, no DDL al arrancar la primera
 * réplica.
 */

import { sql } from "drizzle-orm";

import type { Database } from "./client.js";
import { APP_ROLE } from "./tenancy.js";

/** `[a-z_][a-z0-9_]*`: `GRANT` no admite parámetros, así que sólo identificadores. */
const SQL_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export interface QueueGrantOptions {
  /** Esquema de pg-boss. El mismo que se le pasó al adaptador. */
  readonly schema: string;
  /** Rol de la aplicación. Default: el de `tenancy.ts`. */
  readonly role?: string;
}

/**
 * Da al rol de la aplicación lo necesario para encolar en `schema`.
 *
 * Es idempotente: repetir los `GRANT` no falla ni cambia nada, así que puede
 * correr en cada arranque que migre sin necesidad de recordar si ya se hizo.
 *
 * Las tablas de pg-boss tienen que existir ya — por eso se llama **después** de
 * `queue.start()`, no antes. El `ALTER DEFAULT PRIVILEGES` cubre además lo que
 * pg-boss cree más adelante al subir de versión.
 */
export async function grantQueueSchemaAccess(
  db: Database,
  options: QueueGrantOptions,
): Promise<void> {
  const schema = options.schema;
  const role = options.role ?? APP_ROLE;

  for (const [nombre, valor] of [
    ["esquema", schema],
    ["rol", role],
  ] as const) {
    if (!SQL_IDENT_RE.test(valor)) {
      throw new Error(
        `${nombre} inválido: ${JSON.stringify(valor)}. ` +
          "`GRANT` no admite parámetros, así que sólo se aceptan identificadores " +
          "[a-z_][a-z0-9_]*.",
      );
    }
  }

  // Seguro por la validación de arriba: el regex no deja pasar comillas ni espacios.
  await db.execute(sql.raw(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`));
  await db.execute(
    sql.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
    ),
  );
  await db.execute(
    sql.raw(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`),
  );
  await db.execute(
    sql.raw(
      `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA "${schema}" ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${role}"`,
    ),
  );
  await db.execute(
    sql.raw(
      `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA "${schema}" ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO "${role}"`,
    ),
  );
}
