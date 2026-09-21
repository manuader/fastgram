/**
 * Entorno de `@fastgram/worker` — P1-QUEUE-008.
 *
 * Mismo criterio que `apps/api/src/env.ts`: si falta una variable el proceso
 * **no levanta** (P0-REPO-009). Lo que cambia es qué hace falta, y las
 * diferencias no son cosméticas:
 *
 * - **No hay puerto HTTP.** El worker no escucha nada.
 * - **`QUEUE_MIGRATE` no existe acá**, y es deliberado: quien crea el esquema
 *   de la cola es la API, con su propia bandera. Dos procesos corriendo el
 *   mismo DDL al arrancar compiten por los mismos objetos, y el worker es el
 *   que suele tener más réplicas.
 * - **`WORKER_CONCURRENCY`** sí, porque `NFR-025` dice que el render cuellea
 *   por CPU y el número de builds simultáneos es la perilla que lo controla.
 */
import { baseEnvSchema, defineEnv, postgresEnvSchema, z } from "@fastgram/config/env";
import { APP_ROLE } from "@fastgram/db";

export const workerEnvSchema = baseEnvSchema.merge(postgresEnvSchema).extend({
  /** Ver la nota larga en `apps/api/src/env.ts`: sin esto RLS no existe. */
  DATABASE_APP_ROLE: z.string().default(APP_ROLE),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  /** Debe coincidir con el de la API o el worker escucha una cola vacía. */
  QUEUE_SCHEMA: z.string().min(1).default("pgboss"),

  /**
   * Builds simultáneos en este proceso.
   *
   * Default 1 y no un número mayor: un build es CPU pura del lado del motor de
   * render (`ADR-007`), y el tope que importa es el de ese servicio, no el de
   * cuántos jobs saque el worker de la cola. Subirlo acá sin subirlo allá sólo
   * mueve la cola de un lado al otro.
   */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),

  /** Igual que en la API: opcional mientras el storage montado sea el de memoria. */
  S3_PUBLIC_URL: z.string().url().optional(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(
  source: Record<string, string | undefined> = process.env,
): WorkerEnv {
  return defineEnv("@fastgram/worker", workerEnvSchema, source);
}
