/**
 * `IdempotencyStore` respaldado por Postgres.
 *
 * `src/http/idempotency.ts` define la **semántica** de §9.3 (las tres reglas) y deja
 * el almacenamiento detrás de una interfaz. Esto es esa interfaz sobre
 * `idempotencyRepository` de `@fastgram/db`, que ya trae lo único difícil: la reserva
 * es un `INSERT … ON CONFLICT DO NOTHING RETURNING`, atómica. Con un read-then-write,
 * dos reintentos simultáneos del mismo cliente crean dos veces el mismo contenido y lo
 * cobran dos veces.
 *
 * No se reimplementa ninguna de las tres reglas acá: las aplica `IdempotencyGuard`.
 */
import { idempotencyRepository, type Database, type Transaction } from "@fastgram/db";

import type { IdempotencyRecord, IdempotencyStore } from "../http/idempotency.js";
import { runScoped } from "../auth/scope.js";

export interface DbIdempotencyStoreOptions {
  readonly db: Database;
  /** Ver `env.ts` → `DATABASE_APP_ROLE`. */
  readonly appRole: string | undefined;
}

/**
 * Hash imposible de producir por `hashRequestBody` (devuelve 8 hex).
 *
 * Se usa para forzar el veredicto `conflict` del guard en el único caso en que no
 * podemos afirmar nada: la fila desapareció entre el INSERT y el SELECT. Ante la duda
 * nunca se re-ejecuta un efecto facturable.
 */
const UNKNOWABLE_HASH = "__conflict__";

export function createDbIdempotencyStore(
  options: DbIdempotencyStoreOptions,
): IdempotencyStore {
  const tx = <T>(companyId: string, fn: (t: Transaction) => Promise<T>): Promise<T> =>
    runScoped(options.db, companyId, options.appRole, fn);

  return {
    async claim(record: IdempotencyRecord): Promise<IdempotencyRecord | null> {
      return tx(record.companyId, async (t) => {
        const outcome = await idempotencyRepository.reserve(
          t,
          { companyId: record.companyId },
          {
            key: record.key,
            endpoint: record.route,
            requestHash: record.requestHash,
          },
        );

        // `reserved` cubre dos casos: key nueva, y key previamente `released`
        // (regla 3: una petición que falla libera la key). En los dos, seguir.
        if (outcome.kind === "reserved") return null;

        const row = await idempotencyRepository.find(
          t,
          { companyId: record.companyId },
          record.key,
        );
        if (row === null) {
          return { ...record, requestHash: UNKNOWABLE_HASH, status: "in_flight" };
        }

        return {
          key: row.key,
          companyId: row.companyId,
          route: row.endpoint,
          requestHash: row.requestHash,
          status: row.state === "completed" ? "completed" : "in_flight",
          ...(row.state === "completed" && row.responseSnapshot !== null
            ? {
                response: row.responseSnapshot as {
                  status: number;
                  body: unknown;
                },
              }
            : {}),
          createdAtMs: row.createdAt.getTime(),
        };
      });
    },

    async complete(key, companyId, response): Promise<void> {
      await tx(companyId, (t) =>
        idempotencyRepository.complete(t, { companyId }, key, response),
      );
    },

    async release(key, companyId): Promise<void> {
      await tx(companyId, (t) => idempotencyRepository.release(t, { companyId }, key));
    },
  };
}
