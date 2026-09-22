/**
 * `PgBossQueue` × la transacción **real** de `packages/db` — ADR-005, IMPL §2.3.
 *
 * ## Por qué existe este archivo, si ya hay tests de rollback
 *
 * `pg-boss-queue.test.ts` ya prueba que un `ROLLBACK` deshace el encolado,
 * pero lo hace contra el ejecutor interno de pg-boss (`boss.getDb()`, que
 * corre sobre `pg`) con un pool de `max: 1`. Eso demuestra que pg-boss respeta
 * `options.db`, y nada más: **la transacción que descuenta la cuota no es
 * ésa**. `packages/db` es Drizzle sobre postgres.js, y el handle que `core`
 * propaga (`AcceptBlitzSuggestionInput.transaction`) es el que
 * `db.transaction()` entrega. Si el encolado no participa de *esa*
 * transacción, ADR-005 no compra nada: la cola podría haber vivido en Redis.
 *
 * De ahí que este archivo monte la base como la monta la aplicación
 * —`drizzle(postgres(url))`, igual que `packages/db/src/client.ts`— y encole a
 * través del adaptador desde adentro de una transacción de Drizzle.
 *
 * No se importa `@fastgram/db`: no es dependencia de `packages/adapters` y
 * agregarla es tocar un `package.json`, que en trabajo paralelo es estado
 * compartido. Lo que importa es la *forma* del handle, y `drizzle-orm` +
 * `postgres` están disponibles acá como devDependencies.
 *
 * ## Los tres hallazgos que costó montarlo
 *
 * **1 · `undefined` en los parámetros abortaba todo encolado transaccional.**
 * pg-boss arma los valores de `insertJob` con huecos: los `retry*` y sus
 * `*Default` quedan literalmente `undefined` cuando nadie los pasa, y el SQL
 * los resuelve con `COALESCE`. `pg` manda `NULL` por un `undefined`;
 * **postgres.js tira `UNDEFINED_VALUE: Undefined values are not allowed`** y
 * ni siquiera llega a la base. O sea: toda la ruta de IMPL §2.3 fallaba con
 * `provider_unavailable`. Arreglado en `pg-boss-queue.ts` (`nullifyUndefined`).
 *
 * **2 · `drizzle()` le cambia los serializadores al cliente que recibe.**
 * `drizzle-orm/postgres-js` hace, sobre el cliente que le pasás:
 * `client.options.serializers["114"] = client.options.serializers["3802"] =
 * (val) => val`. Lo hace porque Drizzle serializa el JSON por su cuenta, pero
 * el cliente es **compartido**: `createDb` devuelve ese mismo `sql`. Con los
 * serializadores en identidad, el `data` del job —un objeto plano— llega
 * crudo al Bind del protocolo y postgres.js muere con
 * `ERR_INVALID_ARG_TYPE: The "string" argument must be of type string…
 * Received an instance of Object`. Medido, no deducido: sobre un cliente
 * virgen el mismo INSERT pasa.
 *
 * Consecuencia práctica: **sobre el cliente que produce `packages/db`, el
 * bridge por defecto del adaptador no puede encolar.** El payload tiene que
 * viajar ya convertido a texto JSON. Eso es lo que hace
 * {@link drizzleTxToExecutor} acá, y es lo que va a tener que hacer quien
 * cablee la aplicación.
 *
 * **3 · El bridge por defecto tampoco reconoce el handle de Drizzle.**
 * `defaultToExecutor` acepta tres formas: algo que ya es `QueueSqlExecutor`,
 * la función `sql` de postgres.js, y un cliente de `pg`. La transacción de
 * Drizzle no es ninguna: es un objeto cuyo `.query` es el query builder
 * relacional, no una función. Falla cerrado, con `bad_request`.
 *
 * Los tres casos del final (`bridge por defecto`) miden exactamente eso, para
 * que el día que el adaptador cambie de opinión el test lo obligue a decirlo.
 *
 * ## Cómo se monta la base
 *
 * `DATABASE_URL`, o el `docker compose` de desarrollo. Sin base, los casos se
 * saltean **con el motivo en el nombre**: saltearse en silencio sería peor que
 * no tener el archivo. Esquema de pg-boss propio (`pgboss_tx_drizzle`) para no
 * pisarse con `pgboss_contract`, que usa el test de contrato.
 */

import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import PgBoss from "pg-boss";
import postgres, { type Sql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { isPortError, type QueueTransaction } from "@fastgram/ports";

import {
  drizzleTransactionToExecutor,
  PgBossQueue,
  type PgBossLike,
  type QueueSqlExecutor,
} from "./pg-boss-queue.js";

const CONNECTION_STRING =
  process.env["DATABASE_URL"] ?? "postgres://fastgram:fastgram@localhost:5432/fastgram";

/** Esquema propio del archivo. Ver la cabecera: no compartir con el contrato. */
const SCHEMA = "pgboss_tx_drizzle";

/** Registrada en `start()`: encolar en transacción exige la cola preexistente. */
const QUEUE = "tx-build-content";

/**
 * Tabla que hace de escritura de negocio.
 *
 * Sin ella el test probaría que el job desaparece, no que desaparece **junto
 * con** lo que la transacción escribió. Lo que ADR-005 promete es que las dos
 * cosas viven o mueren juntas, así que se miden las dos.
 */
const MARKER_TABLE = `${SCHEMA}.tx_marker`;

async function probe(): Promise<string | null> {
  const boss = new PgBoss({
    connectionString: CONNECTION_STRING,
    schema: SCHEMA,
    max: 1,
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {
    /* el probe no debe tumbar el proceso si la base no está */
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
const suffix = reason === null ? "" : ` · ${reason}`;
const itDb = reason === null ? it : it.skip;

/* ------------------------------------------------------------------------ *
 * El puente Drizzle → pg-boss
 * ------------------------------------------------------------------------ */

interface ExecutorOptions {
  /**
   * `true` para un cliente que pasó por `drizzle()`.
   *
   * Ver el hallazgo 2 de la cabecera: Drizzle deja los serializadores de
   * `json`/`jsonb` en identidad, así que el objeto tiene que llegar ya
   * convertido a texto. Sobre un cliente virgen sería exactamente al revés —el
   * serializador de postgres.js lo haría él, y un texto quedaría guardado como
   * *string* JSON en vez de objeto—, y por eso esto es un parámetro y no una
   * constante: la forma correcta depende de quién tocó el cliente.
   */
  readonly jsonAsText: boolean;
}

/** Envuelve una conexión de postgres.js con la forma que espera pg-boss. */
function executorOf(client: Sql, options: ExecutorOptions): QueueSqlExecutor {
  const unsafe = (
    client as unknown as {
      unsafe: (text: string, values: unknown[]) => Promise<unknown>;
    }
  ).unsafe.bind(client);
  return {
    executeSql: async (text, values) => {
      const rows = await unsafe(
        text,
        values.map((value) => adaptParameter(value, options)),
      );
      return { rows: Array.isArray(rows) ? [...(rows as unknown[])] : [] };
    },
  };
}

function adaptParameter(value: unknown, options: ExecutorOptions): unknown {
  // Hallazgo 1. Está duplicado con `nullifyUndefined` del adaptador a
  // propósito: si se importara, los casos que miden el bridge por defecto
  // dejarían de medirlo.
  if (value === undefined) return null;
  if (!options.jsonAsText || value === null || typeof value !== "object") return value;
  // Arrays, fechas y buffers tienen serializador propio en postgres.js y
  // Drizzle no los toca. El único que necesita texto es el objeto plano, que
  // en los parámetros de pg-boss es el `data` del job.
  if (Array.isArray(value) || value instanceof Date || ArrayBuffer.isView(value)) {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Convierte la transacción de Drizzle en lo que pg-boss sabe usar.
 *
 * La conexión reservada vive en `session.client` del objeto que
 * `db.transaction()` pasa al callback, y es la función `sql` de postgres.js
 * acotada a esa conexión. **Es interno de `drizzle-orm/postgres-js`**, no API
 * pública: está acá, a la vista, en vez de escondido adentro del adaptador,
 * porque es una decisión que alguien tiene que tomar al cablear la aplicación
 * y conviene que duela al leerla. El handle de la transacción tampoco expone
 * `options`, así que no hay forma de preguntarle al cliente si Drizzle le
 * cambió los serializadores: se sabe por construcción.
 */
function drizzleTxToExecutor(transaction: QueueTransaction): QueueSqlExecutor {
  const client = (transaction as { session?: { client?: unknown } }).session?.client;
  if (typeof client !== "function") {
    throw new Error(
      "La transacción de Drizzle no expone session.client: cambió el interno del driver",
    );
  }
  return executorOf(client as Sql, { jsonAsText: true });
}

/** Lecturas de verificación: sus parámetros son texto, no hay JSON en juego. */
function readerOf(client: Sql): QueueSqlExecutor {
  return executorOf(client, { jsonAsText: false });
}

/* ------------------------------------------------------------------------ *
 * Montaje
 * ------------------------------------------------------------------------ */

interface Fixture {
  /** El cliente de la aplicación: pasó por `drizzle()` y quedó parcheado. */
  readonly client: Sql;
  /** Cliente virgen: lecturas desde afuera, y el bridge por defecto. */
  readonly vanilla: Sql;
  readonly db: PostgresJsDatabase<Record<string, never>>;
  /** Montado con el puente a Drizzle. */
  readonly queue: PgBossQueue;
  /** Sin `toExecutor`: ejercita el bridge por defecto del adaptador. */
  readonly plainQueue: PgBossQueue;
  readonly shippedQueue: PgBossQueue;
  readonly bosses: readonly PgBossLike[];
}

function newBoss(): PgBossLike {
  const boss = new PgBoss({
    connectionString: CONNECTION_STRING,
    schema: SCHEMA,
    // `supervise` mueve jobs vencidos y `schedule` corre el cron: los dos
    // meterían escrituras asíncronas en medio de aserciones sobre estado.
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {
    /* sin listener, un error del pool tumba el runner de vitest */
  });
  return boss as unknown as PgBossLike;
}

async function setUp(): Promise<Fixture> {
  const client = postgres(CONNECTION_STRING, { max: 5, onnotice: () => undefined });
  const vanilla = postgres(CONNECTION_STRING, { max: 3, onnotice: () => undefined });
  // Esta línea es la que parchea `client`. Está separada para que se vea que
  // el efecto es sobre el cliente y no sobre el objeto que devuelve.
  const db = drizzle(client);

  const bossForBridge = newBoss();
  const bossForDefault = newBoss();
  const bossForShipped = newBoss();
  const queue = new PgBossQueue({
    boss: bossForBridge,
    queues: [QUEUE],
    toExecutor: drizzleTxToExecutor,
  });
  const plainQueue = new PgBossQueue({ boss: bossForDefault, queues: [QUEUE] });
  // La misma cola, pero con el puente **exportado por el adaptador** en vez de
  // la copia local. La copia local mide el mecanismo; ésta mide lo que el
  // cableado de producción va a usar de verdad, que es lo que tiene que andar.
  const shippedQueue = new PgBossQueue({
    boss: bossForShipped,
    queues: [QUEUE],
    toExecutor: drizzleTransactionToExecutor,
  });
  await queue.start();
  await plainQueue.start();
  await shippedQueue.start();

  await vanilla.unsafe(
    `create table if not exists ${MARKER_TABLE} (id uuid primary key, note text not null)`,
    [],
  );
  // Truncar y no borrar: el esquema lo administra pg-boss y un DROP deja la
  // corrida siguiente recreando lo mismo por nada.
  await vanilla.unsafe(`truncate table ${MARKER_TABLE}`, []);

  return {
    client,
    vanilla,
    db,
    queue,
    plainQueue,
    shippedQueue,
    bosses: [bossForBridge, bossForDefault, bossForShipped],
  };
}

const fixture = reason === null ? await setUp() : undefined;

function must(): Fixture {
  if (fixture === undefined) throw new Error("El montaje no corrió: no hay base");
  return fixture;
}

afterAll(async () => {
  if (fixture === undefined) return;
  await Promise.all(
    fixture.bosses.map((boss) => boss.stop({ graceful: false }).catch(() => undefined)),
  );
  await fixture.client.end({ timeout: 5 });
  await fixture.vanilla.end({ timeout: 5 });
});

/* ------------------------------------------------------------------------ *
 * Utilidades de medición
 * ------------------------------------------------------------------------ */

/** `jobId` del puerto es `cola#uuid`; la tabla de pg-boss guarda el uuid solo. */
function rawJobId(jobId: string): string {
  return jobId.slice(jobId.lastIndexOf("#") + 1);
}

async function countJob(executor: QueueSqlExecutor, jobId: string): Promise<number> {
  const result = await executor.executeSql(
    `select count(*)::int as n from ${SCHEMA}.job where name = $1 and id = $2`,
    [QUEUE, rawJobId(jobId)],
  );
  return (result.rows[0] as { n: number } | undefined)?.n ?? 0;
}

async function countMarker(executor: QueueSqlExecutor, id: string): Promise<number> {
  const result = await executor.executeSql(
    `select count(*)::int as n from ${MARKER_TABLE} where id = $1`,
    [id],
  );
  return (result.rows[0] as { n: number } | undefined)?.n ?? 0;
}

/** Aborta la transacción sin confundirse con un fallo de verdad. */
class Rollback extends Error {
  constructor() {
    super("rollback pedido por el test");
  }
}

async function rollingBack(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

/* ------------------------------------------------------------------------ *
 * La garantía de ADR-005 contra la transacción que existe de verdad
 * ------------------------------------------------------------------------ */

describe(`PgBossQueue dentro de una transacción de Drizzle (ADR-005)${suffix}`, () => {
  itDb("un ROLLBACK del negocio se lleva el job encolado", async () => {
    const { db, vanilla, queue } = must();
    const markerId = crypto.randomUUID();
    let jobId = "";

    await rollingBack(async () => {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`insert into ${sql.raw(MARKER_TABLE)} (id, note) values (${markerId}, ${"cuota descontada"})`,
        );
        const enqueued = await queue.enqueue({
          queue: QUEUE,
          payload: { contentId: markerId },
          options: { transaction: tx },
        });
        jobId = enqueued.jobId;
        throw new Rollback();
      });
    });

    expect(jobId).not.toBe("");
    const outside = readerOf(vanilla);
    // Las dos mitades: no quedó trabajo, y tampoco quedó la escritura que lo
    // pagaba. Si sólo desapareciera una, ADR-005 estaría roto igual.
    expect(await countJob(outside, jobId)).toBe(0);
    expect(await countMarker(outside, markerId)).toBe(0);
    expect(await queue.getJob(jobId)).toBeNull();
  });

  itDb(
    "el puente EXPORTADO por el adaptador hace lo mismo: rollback y commit",
    async () => {
      // Sin este caso, lo único probado sería la copia del test, y el puente
      // que el cableado va a importar entraría sin red — que es exactamente la
      // situación en la que estaba `toExecutor` antes de este archivo.
      const { db, vanilla, shippedQueue } = must();
      const outside = readerOf(vanilla);

      const abortado = crypto.randomUUID();
      let jobAbortado = "";
      await rollingBack(async () => {
        await db.transaction(async (tx) => {
          const enqueued = await shippedQueue.enqueue({
            queue: QUEUE,
            payload: { contentId: abortado, nested: { revision: 7 } },
            options: { transaction: tx },
          });
          jobAbortado = enqueued.jobId;
          throw new Rollback();
        });
      });
      expect(jobAbortado).not.toBe("");
      expect(await countJob(outside, jobAbortado)).toBe(0);

      const confirmado = crypto.randomUUID();
      const jobConfirmado = await db.transaction(async (tx) => {
        const enqueued = await shippedQueue.enqueue({
          queue: QUEUE,
          payload: { contentId: confirmado, nested: { revision: 7 } },
          options: { transaction: tx },
        });
        return enqueued.jobId;
      });
      expect(await countJob(outside, jobConfirmado)).toBe(1);

      // Y que el `data` haya llegado como objeto y no como string JSON: es el
      // hallazgo 2 entero. Un `JSON.stringify` de más lo guardaría como texto
      // y el worker recibiría una cadena donde espera el payload.
      const job = await shippedQueue.getJob(jobConfirmado);
      expect(job?.payload).toEqual({ contentId: confirmado, nested: { revision: 7 } });
    },
  );

  itDb("un COMMIT lo deja: sin esta mitad el rollback no mediría nada", async () => {
    const { db, vanilla, queue } = must();
    const markerId = crypto.randomUUID();

    const jobId = await db.transaction(async (tx) => {
      await tx.execute(
        sql`insert into ${sql.raw(MARKER_TABLE)} (id, note) values (${markerId}, ${"cuota descontada"})`,
      );
      const enqueued = await queue.enqueue({
        queue: QUEUE,
        payload: { contentId: markerId, nested: { revision: 3 } },
        options: { transaction: tx },
      });
      return enqueued.jobId;
    });

    const outside = readerOf(vanilla);
    expect(await countJob(outside, jobId)).toBe(1);
    expect(await countMarker(outside, markerId)).toBe(1);
    // El payload leído desde el worker tiene que ser el objeto, no un string
    // JSON: es lo que delataría un doble encodeo del `data` jsonb.
    const status = await queue.getJob<{
      contentId: string;
      nested: { revision: number };
    }>(jobId);
    expect(status?.payload).toEqual({ contentId: markerId, nested: { revision: 3 } });
    expect(status?.state).toBe("queued");
  });

  itDb("antes del COMMIT el job existe adentro y no se ve desde afuera", async () => {
    const { db, vanilla, queue } = must();
    const seen = { inside: -1, outside: -1 };
    let jobId = "";

    // Se mide adentro y se afirma afuera: un `expect` que falla dentro del
    // callback abortaría la transacción y el error llegaría disfrazado de
    // rollback, que es justo lo que este archivo no puede permitirse.
    await rollingBack(async () => {
      await db.transaction(async (tx) => {
        const enqueued = await queue.enqueue({
          queue: QUEUE,
          payload: { contentId: "aislamiento" },
          options: { transaction: tx },
        });
        jobId = enqueued.jobId;
        seen.inside = await countJob(drizzleTxToExecutor(tx), jobId);
        seen.outside = await countJob(readerOf(vanilla), jobId);
        throw new Rollback();
      });
    });

    expect(seen.inside).toBe(1);
    expect(seen.outside).toBe(0);
    expect(await countJob(readerOf(vanilla), jobId)).toBe(0);
  });

  itDb("el lote de enqueueMany viaja entero en la transacción", async () => {
    // El fan-out de `FR-060` crea un Post por (contenido × plataforma ×
    // cuenta). `insert` de pg-boss es otro camino distinto de `send`, con sus
    // propios parámetros, así que el rollback hay que medirlo aparte.
    const { db, vanilla, queue } = must();
    let ids: readonly string[] = [];

    await rollingBack(async () => {
      await db.transaction(async (tx) => {
        const results = await queue.enqueueMany([
          { queue: QUEUE, payload: { contentId: "fan-a" }, options: { transaction: tx } },
          { queue: QUEUE, payload: { contentId: "fan-b" }, options: { transaction: tx } },
        ]);
        ids = results.map((r) => r.jobId);
        throw new Rollback();
      });
    });

    expect(ids).toHaveLength(2);
    const outside = readerOf(vanilla);
    for (const id of ids) expect(await countJob(outside, id)).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * El bridge por defecto: dónde sirve y dónde no
 * ------------------------------------------------------------------------ */

describe(`PgBossQueue — bridge por defecto sobre postgres.js${suffix}`, () => {
  // `sql.begin` es la transacción que Drizzle usa por debajo, y su handle es
  // la función `sql` acotada: la forma que `defaultToExecutor` dice soportar.
  // Hasta acá esa rama no la ejercitaba ningún test.

  itDb("con un cliente virgen, un ROLLBACK borra el job", async () => {
    const { vanilla, plainQueue } = must();
    let jobId = "";

    await rollingBack(async () => {
      await vanilla.begin(async (tx) => {
        const enqueued = await plainQueue.enqueue({
          queue: QUEUE,
          payload: { contentId: "postgres-js-rollback" },
          options: { transaction: tx },
        });
        jobId = enqueued.jobId;
        throw new Rollback();
      });
    });

    expect(jobId).not.toBe("");
    expect(await countJob(readerOf(vanilla), jobId)).toBe(0);
  });

  itDb("con un cliente virgen, un COMMIT lo deja con el payload intacto", async () => {
    const { vanilla, plainQueue } = must();

    const jobId = await vanilla.begin(async (tx) => {
      const enqueued = await plainQueue.enqueue({
        queue: QUEUE,
        payload: { contentId: "postgres-js-commit", nested: { ok: true } },
        options: { transaction: tx },
      });
      return enqueued.jobId;
    });

    expect(typeof jobId).toBe("string");
    expect(await countJob(readerOf(vanilla), jobId as string)).toBe(1);
    const status = await plainQueue.getJob<{
      contentId: string;
      nested: { ok: boolean };
    }>(jobId as string);
    expect(status?.payload).toEqual({
      contentId: "postgres-js-commit",
      nested: { ok: true },
    });
  });

  itDb("el handle crudo de Drizzle NO lo entiende el bridge por defecto", async () => {
    const { db, plainQueue } = must();
    let error: unknown = null;

    await rollingBack(async () => {
      await db.transaction(async (tx) => {
        error = await plainQueue
          .enqueue({
            queue: QUEUE,
            payload: { contentId: "sin-puente" },
            options: { transaction: tx },
          })
          .then(
            () => null,
            (e: unknown) => e,
          );
        throw new Rollback();
      });
    });

    // Documenta el hallazgo 3, no una virtud del adaptador: el handle que
    // `core` propaga es exactamente éste, así que sin `toExecutor` la ruta de
    // IMPL §2.3 no arranca. Falla cerrado —`bad_request`, la transacción
    // aborta—, que es lo correcto. El día que el adaptador aprenda a
    // reconocer a Drizzle, este caso se borra, no se adapta.
    expect(isPortError(error)).toBe(true);
    if (isPortError(error)) expect(error.code).toBe("bad_request");
  });

  itDb(
    "sobre un cliente que pasó por drizzle(), el bridge por defecto no puede encolar",
    async () => {
      // Hallazgo 2, el que más caro sale si se descubre en producción: el
      // handle ES la función `sql` que el bridge dice soportar, así que el
      // adaptador acepta el encolado y la falla aparece recién en el protocolo.
      // Cliente propio y de un solo uso: la conexión queda a mitad de un Bind
      // que nunca se mandó y no conviene devolverla a un pool compartido.
      const parchado = postgres(CONNECTION_STRING, { max: 1, onnotice: () => undefined });
      drizzle(parchado);
      const { plainQueue } = must();
      let error: unknown = null;

      try {
        await rollingBack(async () => {
          await parchado.begin(async (tx) => {
            error = await plainQueue
              .enqueue({
                queue: QUEUE,
                payload: { contentId: "cliente-parcheado" },
                options: { transaction: tx },
              })
              .then(
                () => null,
                (e: unknown) => e,
              );
            throw new Rollback();
          });
        });
      } finally {
        await parchado.end({ timeout: 5 }).catch(() => undefined);
      }

      expect(isPortError(error)).toBe(true);
      if (isPortError(error)) {
        expect(error.code).toBe("provider_unavailable");
        expect(String((error.cause as Error | undefined)?.message)).toContain(
          "must be of type string",
        );
      }
    },
  );
});
