/**
 * `globalSetup` de `test:int`: prepara `fastgram_api`, la base propia de esta
 * suite (ver `DATABASE_URL` en `fixtures.ts` por qué no puede ser la de la app).
 *
 * Además de crearla y migrarla, **crea el esquema de pg-boss** una vez, igual
 * que la API con `QUEUE_MIGRATE=true`. `health.int.test.ts` espera `queue: up`
 * contra el esquema `pgboss`: mientras la suite corría contra la base de la
 * app, ese esquema existía porque lo había creado el `pnpm start` del dueño —
 * una dependencia oculta del estado de desarrollo, que apareció al separar las
 * bases (2026-09-24).
 */
import { drizzleTransactionToExecutor, createPgBossQueue } from "@fastgram/adapters";
import { ALL_JOB_QUEUES } from "@fastgram/core";
import { createDb, grantQueueSchemaAccess, migrateWithUrl } from "@fastgram/db";

import { DATABASE_URL, ensureApiDatabase } from "./fixtures.js";

export default async function setup(): Promise<void> {
  await ensureApiDatabase();
  await migrateWithUrl(DATABASE_URL);

  const { queue } = createPgBossQueue({
    connectionString: DATABASE_URL,
    queues: [...ALL_JOB_QUEUES],
    toExecutor: drizzleTransactionToExecutor,
    migrate: true,
    supervise: false,
    schedule: false,
  });
  await queue.start();
  await queue.stop();

  const handle = createDb({ url: DATABASE_URL, max: 1, onnotice: () => {} });
  try {
    await grantQueueSchemaAccess(handle.db, { schema: "pgboss" });
  } finally {
    await handle.close();
  }

  console.log(`[api test:int] base: ${new URL(DATABASE_URL).pathname.slice(1)}`);
}
