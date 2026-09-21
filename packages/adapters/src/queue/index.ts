/**
 * Construcción del adaptador `Queue`.
 *
 * El `import` de pg-boss vive acá y no en `pg-boss-queue.ts` a propósito:
 * {@link PgBossQueue} depende sólo de {@link PgBossLike}, que es la porción de
 * la API que usa. Eso permite montarlo contra un doble en test sin arrastrar
 * la base, y deja un solo archivo que auditar cuando haya que mirar qué se le
 * pide de verdad al proveedor (§9.15.3.1 lo exige para el puerto `Judgment`;
 * vale igual para el resto).
 */

import PgBoss from "pg-boss";
import { PgBossQueue, type PgBossLike, type PgBossQueueConfig } from "./pg-boss-queue.js";

export { PgBossQueue } from "./pg-boss-queue.js";
export type {
  PgBossJobRow,
  PgBossLike,
  PgBossQueueConfig,
  QueueSqlExecutor,
} from "./pg-boss-queue.js";

export interface CreatePgBossQueueOptions extends Omit<PgBossQueueConfig, "boss"> {
  /** `DATABASE_URL`. */
  readonly connectionString: string;
  /** Esquema de pg-boss. Default `pgboss`, el suyo. */
  readonly schema?: string;
  /** Tamaño del pool del proceso. */
  readonly max?: number;
  /**
   * Corre las migraciones de pg-boss al arrancar. Default `true`.
   *
   * En producción conviene `false` y correrlas en el deploy: IMPL §4 exige
   * migraciones «siempre hacia adelante y compatibles con la versión
   * anterior», y una migración que ocurre cuando arranca el primer worker no
   * se puede ordenar respecto del resto del deploy.
   */
  readonly migrate?: boolean;
  /** Apaga el supervisor y el cron. Para tests y para procesos que sólo encolan. */
  readonly supervise?: boolean;
  readonly schedule?: boolean;
}

export function createPgBossQueue(options: CreatePgBossQueueOptions): {
  queue: PgBossQueue;
  boss: PgBossLike;
} {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    ...(options.schema === undefined ? {} : { schema: options.schema }),
    ...(options.max === undefined ? {} : { max: options.max }),
    migrate: options.migrate ?? true,
    supervise: options.supervise ?? true,
    schedule: options.schedule ?? true,
  });

  // pg-boss emite `error` de forma asíncrona (fallos del pool, del supervisor).
  // Sin listener, Node tumba el proceso. Se registra un no-op para que quien
  // monta el adaptador pueda reemplazarlo por su logger sin que haya una
  // ventana en la que un error de red mate al worker.
  boss.on("error", () => {
    /* lo reemplaza quien monta el adaptador */
  });

  const bossLike = boss as unknown as PgBossLike;
  return {
    queue: new PgBossQueue({
      boss: bossLike,
      ...(options.queues === undefined ? {} : { queues: options.queues }),
      ...(options.toExecutor === undefined ? {} : { toExecutor: options.toExecutor }),
    }),
    boss: bossLike,
  };
}
