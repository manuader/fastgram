import { afterAll, describe, expect, it } from "vitest";
import PgBoss from "pg-boss";
import { describeQueueContract, isPortError } from "@fastgram/ports";
import { PgBossQueue, type PgBossLike, type QueueSqlExecutor } from "./pg-boss-queue.js";

/**
 * Suite de contrato de `Queue` contra **Postgres de verdad**.
 *
 * No hay versión en memoria: la mitad de lo que el puerto promete —que el
 * encolado ocurra dentro de la transacción de negocio (IMPL §2.3), que
 * `singletonKey` no duplique (`NFR-004`), que cancelar dos veces distinga
 * «cancelé» de «ya no se podía» (`FR-060`)— es comportamiento de la base. Un
 * doble que respondiera lo que el contrato espera no probaría nada.
 *
 * **Cuándo corre.** Contra `DATABASE_URL`, o contra el `docker compose` de
 * desarrollo si no está seteada. `packages/adapters` no tiene script
 * `test:int` —el `package.json` no es de esta tarea— así que la suite vive en
 * `pnpm test` y se **saltea explícitamente** cuando no hay base, con el motivo
 * en el nombre. Saltearse en silencio sería peor que no tenerla.
 */
const CONNECTION_STRING =
  process.env["DATABASE_URL"] ?? "postgres://fastgram:fastgram@localhost:5432/fastgram";

/** Esquema propio para no mezclarse con el del worker en la misma base. */
const SCHEMA = "pgboss_contract";

async function probe(): Promise<string | null> {
  const boss = new PgBoss({
    connectionString: CONNECTION_STRING,
    schema: SCHEMA,
    max: 1,
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {
    /* el probe no debe tumbar el proceso */
  });
  try {
    await boss.start();
    await boss.stop({ graceful: false });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const unavailable = await probe();
const reason =
  unavailable === null
    ? null
    : `SALTEADA — no hay Postgres en ${CONNECTION_STRING}: ${unavailable}`;

/**
 * Harness que saltea manteniendo los nombres visibles en el reporte.
 * Un `describe.skip` entero deja una línea; esto deja los siete casos.
 */
const harness = {
  describe,
  it:
    reason === null
      ? it
      : (name: string, body: () => void | Promise<void>) => it.skip(name, body),
};

const instances: PgBossLike[] = [];

async function makeAdapter(): Promise<PgBossQueue> {
  const boss = new PgBoss({
    connectionString: CONNECTION_STRING,
    schema: SCHEMA,
    // `supervise` mueve jobs vencidos y archiva; `schedule` corre el cron.
    // Los dos meterían ruido asíncrono en aserciones sobre estado.
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {
    /* sin listener, un error del pool tumba el runner */
  });
  const bossLike = boss as unknown as PgBossLike;
  instances.push(bossLike);
  const queue = new PgBossQueue({ boss: bossLike, queues: [CONTRACT_QUEUE] });
  await queue.start();
  return queue;
}

const CONTRACT_QUEUE = "contract-queue";

afterAll(async () => {
  await Promise.all(
    instances.map((boss) => boss.stop({ graceful: false }).catch(() => undefined)),
  );
});

describeQueueContract(harness, reason === null ? "pg-boss" : `pg-boss · ${reason}`, {
  makeAdapter,
  queueName: CONTRACT_QUEUE,
});

/* ------------------------------------------------------------------------ *
 * La garantía de IMPL §2.3
 * ------------------------------------------------------------------------ */

const itDb = reason === null ? it : it.skip;

describe(`PgBossQueue — encolado transaccional (IMPL §2.3)${reason === null ? "" : ` · ${reason}`}`, () => {
  /**
   * Una conexión sola, para poder abrir una transacción de verdad.
   *
   * `Db.executeSql` de pg-boss corre sobre `pool.query`. Con `max: 1` hay
   * exactamente **una** conexión, así que `BEGIN`, el INSERT del job y
   * `ROLLBACK` caen sobre la misma — que es la definición de transacción.
   *
   * Lo que esto demuestra: que `send` con `{ db }` participa de la
   * transacción del llamador. Lo que **no** demuestra: interoperar con la
   * transacción de Drizzle / postgres.js que usa `packages/db`. Eso es un test
   * de integración de ese paquete y queda fuera de esta tarea.
   */
  async function withSingleConnection<T>(
    body: (db: QueueSqlExecutor, queue: PgBossQueue) => Promise<T>,
  ): Promise<T> {
    const boss = new PgBoss({
      connectionString: CONNECTION_STRING,
      schema: SCHEMA,
      max: 1,
      supervise: false,
      schedule: false,
    });
    boss.on("error", () => {
      /* idem */
    });
    await boss.start();
    const bossLike = boss as unknown as PgBossLike;
    const queue = new PgBossQueue({ boss: bossLike, queues: [TX_QUEUE] });
    await queue.start();
    const db = (boss as unknown as { getDb(): QueueSqlExecutor }).getDb();
    try {
      return await body(db, queue);
    } finally {
      await boss.stop({ graceful: false }).catch(() => undefined);
    }
  }

  const TX_QUEUE = "contract-tx";

  itDb("un ROLLBACK se lleva el job: no queda trabajo sin cuota", async () => {
    const { jobId } = await withSingleConnection(async (db, queue) => {
      await db.executeSql("BEGIN", []);
      const enqueued = await queue.enqueue({
        queue: TX_QUEUE,
        payload: { contentId: "rollback-me" },
        options: { transaction: db },
      });
      // Dentro de la transacción el job ya se ve: es el mismo snapshot.
      const inside = await db.executeSql(
        `SELECT count(*)::int as n FROM ${SCHEMA}.job WHERE id = $1`,
        [enqueued.jobId.split("#")[1]],
      );
      expect((inside.rows[0] as { n: number }).n).toBe(1);

      await db.executeSql("ROLLBACK", []);
      return enqueued;
    });

    // Y desde otra conexión, después del rollback, no existe.
    const outside = await makeAdapter();
    expect(await outside.getJob(jobId)).toBeNull();
  });

  itDb("un COMMIT lo deja: no queda cuota sin trabajo", async () => {
    const { jobId } = await withSingleConnection(async (db, queue) => {
      await db.executeSql("BEGIN", []);
      const enqueued = await queue.enqueue({
        queue: TX_QUEUE,
        payload: { contentId: "commit-me" },
        options: { transaction: db },
      });
      await db.executeSql("COMMIT", []);
      return enqueued;
    });

    const outside = await makeAdapter();
    const status = await outside.getJob<{ contentId: string }>(jobId);
    expect(status?.payload.contentId).toBe("commit-me");
  });

  itDb("enqueueMany también viaja en la transacción", async () => {
    // El fan-out de `FR-060` crea un Post por (contenido × plataforma ×
    // cuenta). Si el lote no fuera transaccional, un fallo a mitad dejaría
    // media publicación encolada.
    const ids = await withSingleConnection(async (db, queue) => {
      await db.executeSql("BEGIN", []);
      const results = await queue.enqueueMany([
        {
          queue: TX_QUEUE,
          payload: { contentId: "fan-a" },
          options: { transaction: db },
        },
        {
          queue: TX_QUEUE,
          payload: { contentId: "fan-b" },
          options: { transaction: db },
        },
      ]);
      await db.executeSql("ROLLBACK", []);
      return results.map((r) => r.jobId);
    });

    const outside = await makeAdapter();
    for (const id of ids) {
      expect(await outside.getJob(id)).toBeNull();
    }
  });

  itDb(
    "encolar en una cola no registrada dentro de una transacción es bad_request",
    async () => {
      // Es la trampa del `ATTACH PARTITION`: crear la cola al vuelo tomaría un
      // ACCESS EXCLUSIVE sobre `job` desde otra conexión, con la transacción del
      // llamador abierta. Preferimos fallar claro a colgar el worker.
      const error = await withSingleConnection(async (db, queue) => {
        await db.executeSql("BEGIN", []);
        const result = await queue
          .enqueue({
            queue: "cola-que-nadie-registro",
            payload: { contentId: "x" },
            options: { transaction: db },
          })
          .then(
            () => null,
            (e: unknown) => e,
          );
        await db.executeSql("ROLLBACK", []);
        return result;
      });

      expect(isPortError(error)).toBe(true);
      if (isPortError(error)) expect(error.code).toBe("bad_request");
    },
  );

  itDb(
    "un handle de transacción que el adaptador no entiende es bad_request",
    async () => {
      const queue = await makeAdapter();
      const error = await queue
        .enqueue({
          queue: CONTRACT_QUEUE,
          payload: { contentId: "x" },
          options: { transaction: { soy: "cualquier cosa" } },
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(isPortError(error) && error.code).toBe("bad_request");
    },
  );
});

/* ------------------------------------------------------------------------ *
 * Lo que el contrato no cubre
 * ------------------------------------------------------------------------ */

describe(`PgBossQueue — comportamiento propio${reason === null ? "" : ` · ${reason}`}`, () => {
  itDb("singletonKey con otro payload es conflict, no un segundo job", async () => {
    const queue = await makeAdapter();
    const singletonKey = `dup-${String(Date.now())}`;
    await queue.enqueue({
      queue: CONTRACT_QUEUE,
      payload: { contentId: "a" },
      options: { singletonKey },
    });
    const error = await queue
      .enqueue({
        queue: CONTRACT_QUEUE,
        payload: { contentId: "b" },
        options: { singletonKey },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isPortError(error) && error.code).toBe("conflict");
  });

  itDb("dos programaciones distintas sobre la misma cola son conflict", async () => {
    // La tabla `schedule` de pg-boss tiene PRIMARY KEY (name) y `name` es la
    // cola: no hay dónde guardar dos. Sin esto, la segunda pisaría a la
    // primera en silencio.
    const queue = await makeAdapter();
    await queue.scheduleRecurring({
      name: "reset-cuota",
      queue: CONTRACT_QUEUE,
      cron: "0 0 * * *",
      payload: {},
    });
    const error = await queue
      .scheduleRecurring({
        name: "otro-trabajo",
        queue: CONTRACT_QUEUE,
        cron: "*/5 * * * *",
        payload: {},
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isPortError(error) && error.code).toBe("conflict");
  });

  itDb("getJob de un id con formato ajeno devuelve null, no rompe", async () => {
    const queue = await makeAdapter();
    expect(await queue.getJob("esto-no-es-un-id")).toBeNull();
    expect(await queue.getJob("")).toBeNull();
    expect(await queue.getJob(`${CONTRACT_QUEUE}#no-es-uuid`)).toBeNull();
  });

  itDb(
    "el payload llega al handler y attempt empieza en 1",
    async () => {
      const queue = await makeAdapter();
      const seen: { payload: unknown; attempt: number }[] = [];
      const workQueue = `contract-work-${String(Date.now())}`;

      const worker = new PgBossQueue({
        boss: await (async () => {
          const boss = new PgBoss({
            connectionString: CONNECTION_STRING,
            schema: SCHEMA,
            supervise: false,
            schedule: false,
          });
          boss.on("error", () => {
            /* idem */
          });
          const bossLike = boss as unknown as PgBossLike;
          instances.push(bossLike);
          return bossLike;
        })(),
        queues: [workQueue],
      });
      await worker.start();
      await worker.work<{ contentId: string }>(
        workQueue,
        async (job) => {
          seen.push({ payload: job.payload, attempt: job.attempt });
        },
        { pollIntervalSeconds: 1 },
      );

      await queue.enqueue({ queue: workQueue, payload: { contentId: "trabajado" } });

      const deadline = Date.now() + 15_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(seen).toHaveLength(1);
      expect(seen[0]?.payload).toEqual({ contentId: "trabajado" });
      expect(seen[0]?.attempt).toBe(1);
    },
    30_000,
  );
});
