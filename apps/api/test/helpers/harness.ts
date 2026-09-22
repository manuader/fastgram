/**
 * Arnés de tests de ruta — el que faltaba.
 *
 * ## Qué problema resuelve
 *
 * Los 16 endpoints de escritura se escribieron y **ninguno se ejecutó nunca**.
 * Los cuatro agentes que los escribieron lo reportaron por separado como su
 * limitación principal: lo verificado eran funciones puras y tipos, no un
 * request. Un `201` escrito no es un `201` devuelto.
 *
 * Montar la app entera ya se hacía —`tenant-isolation.int.test.ts` lo hace—
 * pero cada archivo repetía cuarenta líneas de construcción, y faltaban dos
 * cosas sin las que media API no se puede testear:
 *
 *  - **Una cola que se pueda inspeccionar.** Cuatro rutas encolan, y sin poder
 *    afirmar *"se encoló `content-build` con este `contentId`"* lo único que se
 *    puede comprobar de ellas es el status. Peor: sin `queue` en `deps` esas
 *    rutas responden `503` a propósito, así que un test escrito sin cola
 *    estaría midiendo el camino degradado creyendo que mide el normal.
 *  - **Poder montar la app SIN cola**, que es el otro caso real: que el `503`
 *    ocurra y que **no deje la fila creada**.
 *
 * ## Por qué `app.inject()` y no un puerto
 *
 * `inject` recorre el pipeline entero de Fastify —hooks, validación de schema,
 * serialización, el manejador de errores— sin abrir un socket. Lo único que no
 * ejercita es la capa de red, que no es nuestra. A cambio, los tests corren en
 * milisegundos y no compiten por un puerto cuando hay varios archivos a la vez.
 *
 * ## Contra Postgres de verdad
 *
 * Sin base no habría nada que probar: las rutas no arman queries, delegan en
 * repositorios que exigen `companyId`, y lo que hay que verificar es justamente
 * que esa cadena funcione. Y corre con `SET LOCAL ROLE fastgram_app`: sin el
 * rol, la conexión de desarrollo es superusuario, saltea RLS, y el archivo
 * estaría midiendo la mitad de lo que dice medir.
 */
import type { FastifyInstance, InjectOptions } from "fastify";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { ALL_JOB_QUEUES } from "@fastgram/core";
import { APP_ROLE, migrateWithUrl, type DbHandle } from "@fastgram/db";
import type {
  EnqueuedJob,
  JobSpec,
  JobStatus,
  Queue,
  RecurringSpec,
  Storage,
} from "@fastgram/ports";

import { buildServer } from "../../src/server/app.js";
import { IdempotencyGuard } from "../../src/http/idempotency.js";
import { TokenBucketLimiter } from "../../src/http/rate-limit.js";
import { createDbIdempotencyStore } from "../../src/support/idempotency-store.js";
import { DATABASE_URL, bearer, openDb, seed, type Seed } from "./fixtures.js";

/**
 * Una `Queue` que anota en vez de encolar.
 *
 * No hereda de nada ni habla con pg-boss: lo que estos tests verifican es que
 * **la ruta pida encolar lo correcto**, no que pg-boss funcione —eso ya lo
 * cubre `packages/adapters`, incluido el encolado dentro de la transacción de
 * Drizzle, que es la garantía difícil.
 *
 * `enqueue` acepta la `transaction` y la ignora a propósito: si la volcara a la
 * base, un rollback de la ruta dejaría el registro igual y el test diría que se
 * encoló algo que nunca existió.
 */
export class RecordingQueue implements Queue {
  readonly enqueued: JobSpec<unknown>[] = [];
  /** Se pone en `true` para probar el camino de fallo del proveedor. */
  failNext = false;

  async enqueue<TPayload>(job: JobSpec<TPayload>): Promise<EnqueuedJob> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("la cola no responde");
    }
    // **Esto faltaba, y es lo que escondía un 500 en producción.**
    //
    // Esta clase aceptaba cualquier nombre de cola. `POST /content/:id/schedule`
    // encolaba en `"publish-post"`, un literal escrito a mano en la ruta cuando
    // no existía `JOB_QUEUES`; el registro nombró a esa cola `"publishing"`, y
    // los dos nombres convivieron. `main.ts` registra `[...ALL_JOB_QUEUES]`, que
    // no contiene `"publish-post"`, y pg-boss **se niega** a encolar en una cola
    // no registrada dentro de una transacción:
    //
    //   Queue "publish-post" must be registered before enqueuing inside a
    //   transaction
    //
    // O sea que programar un post devolvía 500 **siempre**, y los 82 tests de
    // integración estaban verdes. Validar acá es lo que convierte a cada test de
    // ruta que encola en una guarda contra la trampa 19, en vez de necesitar un
    // test nuevo por cola.
    if (!(ALL_JOB_QUEUES as readonly string[]).includes(job.queue)) {
      throw new Error(
        `la ruta encoló en "${job.queue}", que no está en JOB_QUEUES. ` +
          "En producción pg-boss rechaza una cola no registrada dentro de una " +
          "transacción, así que esto es un 500. El nombre tiene que salir de " +
          "`JOB_QUEUES` (@fastgram/core), nunca de un literal.",
      );
    }
    this.enqueued.push(job as JobSpec<unknown>);
    return { jobId: `job_${String(this.enqueued.length)}`, queue: job.queue };
  }

  async enqueueMany(jobs: readonly JobSpec<unknown>[]): Promise<readonly EnqueuedJob[]> {
    const out: EnqueuedJob[] = [];
    for (const job of jobs) out.push(await this.enqueue(job));
    return out;
  }

  /** Lo que la ruta pidió encolar en una cola. Vacío si no pidió nada. */
  forQueue(queue: string): JobSpec<unknown>[] {
    return this.enqueued.filter((job) => job.queue === queue);
  }

  reset(): void {
    this.enqueued.length = 0;
    this.failNext = false;
  }

  // El resto del puerto no lo usa ninguna ruta: sólo el worker. Lanzar en vez de
  // devolver algo vacío es lo que hace que, el día que una ruta empiece a
  // usarlos, el test lo diga en vez de pasar sobre un silencio.
  async work(): Promise<void> {
    throw new Error("RecordingQueue no consume: eso es del worker");
  }
  async getJob<TPayload = unknown>(): Promise<JobStatus<TPayload> | null> {
    throw new Error("RecordingQueue no consulta jobs");
  }
  async cancel(): Promise<boolean> {
    throw new Error("RecordingQueue no cancela jobs");
  }
  async scheduleRecurring<TPayload>(_spec: RecurringSpec<TPayload>): Promise<void> {
    throw new Error("RecordingQueue no programa recurrentes");
  }
  async start(): Promise<void> {
    /* nada que arrancar */
  }
  async stop(): Promise<void> {
    /* nada que parar */
  }
}

export interface ApiHarness {
  readonly app: FastifyInstance;
  readonly handle: DbHandle;
  readonly data: Seed;
  readonly queue: RecordingQueue;
  readonly clock: FixedClock;
  /** Petición con la credencial del workspace `a`, ya parseada. */
  request(options: RequestOptions): Promise<Response>;
  close(): Promise<void>;
}

export interface RequestOptions {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  /** Default: la key del workspace `a`. `null` para no mandar credencial. */
  readonly token?: string | null;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly headers?: Record<string, string>;
}

export interface Response {
  readonly status: number;
  /** El cuerpo parseado. `undefined` en un 204. */
  readonly body: Record<string, unknown> | undefined;
  /** El cuerpo crudo, para comparar dos respuestas **byte a byte**. */
  readonly raw: string;
  readonly headers: Record<string, unknown>;
}

export interface StartApiOptions {
  /**
   * Montar la cola. Default `true`.
   *
   * En `false`, `deps.queue` queda `undefined` y las rutas que crean trabajo
   * responden `503` sin escribir — que es un camino a probar, no un accidente.
   */
  readonly withQueue?: boolean;
  /**
   * El limitador. Default: **uno que nunca limita** (ver {@link openLimiter}).
   *
   * Decía *"default alto: la mayoría de las suites no miden rate limiting"* y
   * era falso — el default eran los límites **reales** con un `FixedClock`
   * detrás, y un bucket que no avanza **no rellena nunca**. `contentBuilds` es
   * 10/min (§9.6), así que el onceavo request de un archivo que crea, edita o
   * regenera contenido recibía un `429` que no tenía nada que ver con lo que el
   * test medía. Se manifiesta como un fallo desconcertante en el test que
   * alguien acaba de agregar, y encima depende del **orden** de los casos.
   *
   * Una suite que sí quiera medir los límites construye el suyo:
   * `new TokenBucketLimiter(createMemoryBucketStore(), clock)`, como hace
   * `blitz-angles.int.test.ts`.
   */
  readonly limiter?: TokenBucketLimiter;
  readonly now?: string;
  /**
   * El puerto `Storage`. Default `MemoryStorage`, **y se queda así a propósito.**
   *
   * Desde `P1-STORAGE-007` `main.ts` monta `S3Storage`, así que la pregunta
   * *"¿el arnés debería montar lo mismo?"* es legítima. La respuesta es no para
   * el default, por dos razones que no son comodidad:
   *
   *  1. **Casi ninguna ruta mira el storage.** De las 30 de la v1 lo tocan
   *     cinco, y sólo en tres de ellas es el objeto de la prueba. Atar las
   *     otras 25 a que MinIO esté arriba convierte cada fallo de red en un
   *     test rojo que no dice nada del código.
   *  2. **`MemoryStorage` no es un mock.** Es la tercera implementación del
   *     puerto y pasa la misma suite de contrato que la de S3, así que para una
   *     ruta que sólo necesita *un* storage que funcione mide lo mismo y más
   *     rápido.
   *
   * Lo que sí hacía falta y no existía es **poder pasarle otro**, porque §9.8
   * es reserva → PUT directo → finalización y `MemoryStorage` no puede probar
   * el paso 2: sus URLs son sintéticas y el PUT no ocurre. Eso lo ejercita
   * `media-upload.int.test.ts` contra MinIO, que es el único lugar donde la
   * prueba vale.
   */
  readonly storage?: Storage;
  /**
   * TTL del cache de `/health`. Default **`0`**, o sea sin cache.
   *
   * El default de producción son 3 s y acá se desactiva a propósito: el `Clock`
   * del arnés es un `FixedClock` y **no avanza**, así que una entrada cacheada no
   * vencería nunca y dos llamadas seguidas devolverían lo mismo aunque la
   * dependencia se hubiera caído en el medio. Es la misma trampa que ya está
   * anotada para `TokenBucketLimiter` unas líneas más arriba. Una suite que
   * quiera medir el cache pasa el número que quiera medir.
   */
  readonly healthCacheTtlMs?: number;
  /**
   * Esquema de pg-boss para la sonda de la cola. Default: **sin esquema**.
   *
   * Sin él la sonda sólo comprueba que la cola esté montada, que es lo correcto
   * para una suite cuya cola es `RecordingQueue` y no pg-boss. `health.int.test.ts`
   * lo pasa explícitamente para ejercitar el nivel que consulta la base.
   */
  readonly queueSchema?: string;
}

/**
 * Un limitador que siempre deja pasar.
 *
 * El truco está en el store, no en el limitador: `read` devolviendo `null`
 * significa *"no hay bucket"*, y `TokenBucketLimiter` trata eso como el bucket
 * lleno. Así que cada request arranca con el presupuesto entero y el `429` no
 * puede ocurrir, sin tener que tocar `RATE_LIMITS` —que son números normativos
 * del PRD y no se tocan por comodidad de un test.
 */
export function openLimiter(clock: FixedClock): TokenBucketLimiter {
  return new TokenBucketLimiter(
    {
      async read() {
        return null;
      },
      async compareAndSwap() {
        return true;
      },
    },
    clock,
  );
}

export async function startApi(options: StartApiOptions = {}): Promise<ApiHarness> {
  await migrateWithUrl(DATABASE_URL);
  const handle = openDb();
  const data = await seed(handle);

  const clock = new FixedClock(options.now ?? "2026-09-21T12:00:00.000Z");
  const queue = new RecordingQueue();

  const app = await buildServer({
    deps: {
      db: handle.db,
      clock,
      storage: options.storage ?? new MemoryStorage(clock),
      limiter: options.limiter ?? openLimiter(clock),
      idempotency: new IdempotencyGuard(
        createDbIdempotencyStore({ db: handle.db, appRole: APP_ROLE }),
        clock,
      ),
      // Sin esto RLS no se aplica y la suite mide la mitad de lo que dice medir.
      appRole: APP_ROLE,
      ...((options.withQueue ?? true) ? { queue } : {}),
      ...(options.queueSchema === undefined ? {} : { queueSchema: options.queueSchema }),
    },
    logLevel: "silent",
    enableAccessLog: false,
    healthCacheTtlMs: options.healthCacheTtlMs ?? 0,
  });
  await app.ready();

  return {
    app,
    handle,
    data,
    queue,
    clock,
    async request(opts) {
      const token = opts.token === undefined ? data.a.token : opts.token;
      const inject: InjectOptions = {
        method: opts.method,
        url: opts.path,
        headers: {
          ...(token === null ? {} : bearer(token)),
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
          ...(opts.idempotencyKey === undefined
            ? {}
            : { "idempotency-key": opts.idempotencyKey }),
          ...opts.headers,
        },
        ...(opts.body === undefined ? {} : { payload: JSON.stringify(opts.body) }),
      };
      const res = await app.inject(inject);
      return {
        status: res.statusCode,
        body: parse(res.body),
        raw: res.body,
        headers: res.headers as Record<string, unknown>,
      };
    },
    async close() {
      await app.close();
      await handle.close();
    },
  };
}

function parse(raw: string): Record<string, unknown> | undefined {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Un cuerpo que no es JSON es un fallo del contrato (§9.3 fija el envelope),
    // así que se deja pasar sin parsear para que el test lo vea tal cual en vez
    // de morir con un error de sintaxis que no dice nada.
    return undefined;
  }
}

/** Azúcar para el caso más común: `data` del envelope de éxito. */
export function dataOf(res: Response): Record<string, unknown> {
  const value = res.body?.["data"];
  if (value === undefined) {
    throw new Error(
      `La respuesta no trae \`data\`: ${res.status} ${res.raw.slice(0, 200)}`,
    );
  }
  return value as Record<string, unknown>;
}

/** Azúcar para el envelope de error. */
export function errorOf(res: Response): {
  code: string;
  message: string;
  details?: unknown;
} {
  const value = res.body?.["error"];
  if (value === undefined) {
    throw new Error(
      `La respuesta no trae \`error\`: ${res.status} ${res.raw.slice(0, 200)}`,
    );
  }
  return value as { code: string; message: string; details?: unknown };
}
