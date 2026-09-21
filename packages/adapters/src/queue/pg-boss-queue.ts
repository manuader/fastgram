/**
 * Adaptador `Queue` sobre pg-boss — ADR-005, IMPL §2.3, PRD §9.5.
 *
 * ADR-005 elige pg-boss sobre BullMQ + Redis por una razón concreta y no por
 * simplicidad de despliegue: **permite encolar dentro de la transacción de
 * negocio**. IMPL §2.3 lo dice entero: «si el job se encolara en Redis fuera de
 * la transacción, un fallo entre commit y push deja cuota consumida sin
 * trabajo, o trabajo sin cuota».
 *
 * ## ¿pg-boss lo permite de verdad? Sí, y así
 *
 * `SendOptions` de pg-boss v10 extiende `ConnectionOptions`, que es
 * `{ db?: { executeSql(text, values) } }`. En `manager.createJob` el INSERT
 * corre contra `options.db || this.db`. O sea que si se le pasa un ejecutor
 * atado a una conexión con una transacción abierta, **el INSERT ocurre dentro
 * de esa transacción** y hace rollback con ella. Lo mismo vale para `insert`
 * (el lote), `getJobById` y `cancel`.
 *
 * Eso es lo que este adaptador expone por {@link EnqueueOptions.transaction}.
 * El handle llega sin tipar desde el puerto —`packages/ports` no importa npm—
 * y acá se estrecha con {@link PgBossQueueConfig.toExecutor}.
 *
 * ## Las tres trampas que encontró montar esto
 *
 * **1 · Una cola que no existe no da error: devuelve `null`.** El INSERT de
 * pg-boss hace `JOIN queue q ON j.name = q.name`. Sin fila en `queue`, el
 * SELECT no produce filas, el `RETURNING` viene vacío y `send()` devuelve
 * `null` — indistinguible de un conflicto de singleton. Por eso el adaptador
 * se asegura de que la cola exista antes de encolar.
 *
 * **2 · Y crear la cola desde adentro de una transacción ajena puede
 * trabarse.** `create_queue` hace `ALTER TABLE job ATTACH PARTITION`, que toma
 * un `ACCESS EXCLUSIVE` sobre `pgboss.job`. Si la transacción del llamador ya
 * insertó un job en otra partición, esa transacción tiene un lock sobre `job`
 * y el `ATTACH` —que corre en OTRA conexión, porque `createQueue` no acepta
 * `db`— espera a que termine, mientras el llamador espera al `ATTACH`.
 * Deadlock entre conexiones, del tipo que Postgres no detecta porque una de
 * las dos esperas es un lock de tabla.
 *
 * De ahí la regla: **encolar dentro de una transacción exige que la cola esté
 * registrada de antemano** ({@link PgBossQueueConfig.queues}, creadas en
 * `start()`). Si no lo está, el adaptador falla con `bad_request` en vez de
 * arriesgarse. Es preferible un error de arranque a un worker colgado.
 *
 * **3 · `singletonKey` NO deduplica en una cola `standard`.** Es el hallazgo
 * que más cambió el diseño. Los índices únicos de pg-boss sobre
 * `(name, singleton_key)` están filtrados por política:
 *
 * ```
 * job_i1  … WHERE state = 'created' AND policy = 'short'
 * job_i2  … WHERE state = 'active'  AND policy = 'singleton'
 * job_i3  … WHERE state <= 'active' AND policy = 'stately'
 * job_i4  … (name, singleton_on, singleton_key) — sólo con singletonSeconds
 * ```
 *
 * Con la política por defecto (`standard`) no hay ninguno: dos `send` con la
 * misma `singletonKey` crean **dos jobs**. Y cambiar la cola a `short` no
 * arregla nada, porque el índice es sobre `COALESCE(singleton_key, '')`: todos
 * los jobs *sin* clave colapsarían a `''` y sólo podría haber uno encolado en
 * toda la cola.
 *
 * La solución es no usar el mecanismo de pg-boss: el adaptador **deriva el id
 * del job** de `(cola, singletonKey)` con un UUID v5. La clave primaria es
 * `(name, id)` y el INSERT lleva `ON CONFLICT DO NOTHING`, así que el segundo
 * encolado no crea nada y el adaptador devuelve `{ jobId, created: false }`
 * con el mismo id — que es lo que `NFR-004` necesita. Funciona igual dentro de
 * una transacción, sin índices extra y sin tocar la política de la cola.
 *
 * ## Limitaciones conocidas, escritas para que no se descubran tarde
 *
 * - **Un `scheduleRecurring` por cola.** La tabla `schedule` de pg-boss tiene
 *   `PRIMARY KEY (name)` y `name` es la cola. `RecurringSpec.name` no tiene
 *   dónde vivir. Dos programaciones distintas sobre la misma cola se pisan;
 *   acá se detecta y se devuelve `conflict`. Los cuatro trabajos periódicos de
 *   §9.5 tienen una cola cada uno, así que no molesta hoy.
 * - **La idempotencia de `singletonKey` dura lo que dure la fila.** Cuando el
 *   job se archiva (`keepUntil`), la misma clave vuelve a poder encolarse. Es
 *   el comportamiento correcto para `NFR-004` —una `Idempotency-Key` tiene
 *   ventana— pero la ventana la fija la retención de pg-boss, no el producto.
 * - **`jobId` es compuesto: `cola#uuid`.** pg-boss necesita el nombre de la
 *   cola para `getJobById` y `cancel`, y el puerto sólo pasa el id. La
 *   alternativa era un `SELECT name FROM job WHERE id = $1`, que sobre una
 *   tabla particionada por `name` escanea todas las particiones.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  PortError,
  type EnqueuedJob,
  type JobHandler,
  type JobSpec,
  type JobState,
  type JobStatus,
  type Queue,
  type QueueTransaction,
  type RecurringSpec,
  type WorkOptions,
} from "@fastgram/ports";

const SOURCE = "Queue/pg-boss";

/** Lo mínimo de pg-boss: una conexión que sabe ejecutar SQL con parámetros. */
export interface QueueSqlExecutor {
  executeSql(text: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * La parte de pg-boss que este adaptador usa.
 *
 * Se declara acá en vez de importar los tipos del paquete porque los `.d.ts`
 * de pg-boss v10 mienten en dos métodos que importan: `insert` dice devolver
 * `void` y devuelve los ids, y `cancel` dice `void` y devuelve
 * `{ jobs, requested, affected }` — que es de donde sale el booleano que
 * `FR-060` necesita. Tipar lo que el código hace de verdad es más honesto que
 * castear en cada llamada.
 */
export interface PgBossLike {
  start(): Promise<unknown>;
  stop(options?: {
    close?: boolean;
    graceful?: boolean;
    timeout?: number;
    wait?: boolean;
  }): Promise<void>;
  send(
    name: string,
    data: object,
    options: Record<string, unknown>,
  ): Promise<string | null>;
  insert(
    jobs: readonly Record<string, unknown>[],
    options?: { db?: QueueSqlExecutor },
  ): Promise<readonly string[] | null>;
  work(
    name: string,
    options: Record<string, unknown>,
    handler: (jobs: readonly { id: string; data: unknown }[]) => Promise<unknown>,
  ): Promise<string>;
  getJobById(
    name: string,
    id: string,
    options?: { db?: QueueSqlExecutor; includeArchive?: boolean },
  ): Promise<PgBossJobRow | null>;
  cancel(
    name: string,
    id: string,
    options?: { db?: QueueSqlExecutor },
  ): Promise<{ affected: number } | void>;
  createQueue(name: string, options?: Record<string, unknown>): Promise<void>;
  schedule(
    name: string,
    cron: string,
    data?: object,
    options?: Record<string, unknown>,
  ): Promise<void>;
  on(event: "error", handler: (error: Error) => void): unknown;
}

export interface PgBossJobRow {
  readonly id: string;
  readonly name: string;
  readonly data: unknown;
  readonly state: string;
  readonly retryCount?: number;
  readonly retryLimit?: number;
  readonly createdOn: string | Date;
  readonly startedOn?: string | Date | null;
  readonly completedOn?: string | Date | null;
  readonly output?: unknown;
}

export interface PgBossQueueConfig {
  /** La instancia de pg-boss, ya construida. Quien la construye elige el pool. */
  readonly boss: PgBossLike;
  /**
   * Colas que se crean en `start()`.
   *
   * **Encolar dentro de una transacción exige que la cola esté acá.** Ver la
   * trampa 2 de la cabecera: crearla al vuelo desde adentro de una transacción
   * ajena puede trabar el proceso.
   */
  readonly queues?: readonly string[];
  /**
   * Convierte el handle opaco del puerto en algo que pg-boss sepa usar.
   *
   * El default reconoce las tres formas que existen en este repo: un objeto
   * que ya es `QueueSqlExecutor`, una transacción de `postgres` (postgres.js,
   * la que usa `packages/db`) y un cliente de `pg`. Cualquier otra cosa
   * necesita pasar por acá explícitamente.
   */
  readonly toExecutor?: (transaction: QueueTransaction) => QueueSqlExecutor;
}

export class PgBossQueue implements Queue {
  readonly #boss: PgBossLike;
  readonly #config: PgBossQueueConfig;
  readonly #knownQueues = new Set<string>();
  readonly #pendingWorkers: (() => Promise<void>)[] = [];
  /** Cola → nombre de la programación. Ver la limitación de `scheduleRecurring`. */
  readonly #schedules = new Map<string, string>();
  #started = false;

  constructor(config: PgBossQueueConfig) {
    this.#config = config;
    this.#boss = config.boss;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await wrap(() => this.#boss.start(), "starting the job queue");

    for (const queue of this.#config.queues ?? []) {
      await this.#ensureQueue(queue);
    }
    this.#started = true;

    // Los `work()` que llegaron antes del arranque: pg-boss rechaza registrar
    // un worker con el boss parado, y el puerto permite registrar primero.
    for (const register of this.#pendingWorkers.splice(0)) {
      await register();
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    // pg-boss ya es idempotente en `stop()` (chequea `#stopped`), pero el
    // contrato exige que el segundo `stop` no rompa **aunque el primero haya
    // cerrado el pool**, y eso depende de no volver a tocarlo.
    await wrap(
      () => this.#boss.stop({ graceful: true, wait: true }),
      "stopping the job queue",
    );
  }

  async enqueue<TPayload>(job: JobSpec<TPayload>): Promise<EnqueuedJob> {
    assertQueueName(job.queue);
    const options = job.options;
    const executor = this.#executorFor(options?.transaction, job.queue);

    await this.#prepareQueue(job.queue, executor !== undefined);

    const jobId =
      options?.singletonKey === undefined
        ? randomUUID()
        : deterministicId(job.queue, options.singletonKey);

    const sendOptions = this.#sendOptions(options, jobId, executor);
    const created = await wrap(
      () => this.#boss.send(job.queue, asData(job.payload), sendOptions),
      "enqueuing a job",
    );

    if (created !== null) {
      return { jobId: encodeJobId(job.queue, created), created: true };
    }

    // `send` devolvió `null`. Con la cola ya garantizada, la única causa es el
    // `ON CONFLICT DO NOTHING` de la clave primaria: ya hay un job con ese id.
    if (options?.singletonKey === undefined) {
      throw new PortError(
        "provider_contract_violation",
        "The job queue refused the job without giving a reason",
        { source: SOURCE },
      );
    }

    const existing = await wrap(
      () =>
        this.#boss.getJobById(
          job.queue,
          jobId,
          executor === undefined ? {} : { db: executor },
        ),
      "reading the existing job",
    );
    if (existing === null) {
      throw new PortError(
        "provider_contract_violation",
        "The job queue reported a duplicate that it cannot find",
        { source: SOURCE },
      );
    }
    if (JSON.stringify(existing.data) !== JSON.stringify(asData(job.payload))) {
      // El puerto lo especifica: misma clave, otro payload, es `conflict`.
      throw new PortError(
        "conflict",
        "That idempotency key was already used with a different payload",
        { source: SOURCE },
      );
    }
    return { jobId: encodeJobId(job.queue, jobId), created: false };
  }

  async enqueueMany(jobs: readonly JobSpec<unknown>[]): Promise<readonly EnqueuedJob[]> {
    if (jobs.length === 0) return [];

    /**
     * **Todo o nada cuando hay transacción**, dice el puerto — y la
     * atomicidad la da la transacción, no el puerto. `insert` de pg-boss es un
     * solo INSERT multi-fila, así que dentro de una transacción es atómico por
     * construcción; fuera de una, también, porque es una sola sentencia.
     *
     * Todos los jobs tienen que ir a la misma conexión, así que se exige una
     * sola transacción para el lote entero. Mezclar dos sería pedirle al
     * adaptador que rompa la atomicidad que el llamador cree tener.
     */
    const first = jobs[0];
    if (first === undefined) return [];
    const transaction = first.options?.transaction;
    for (const job of jobs) {
      assertQueueName(job.queue);
      if (job.options?.transaction !== transaction) {
        throw new PortError(
          "bad_request",
          "enqueueMany requires every job in the batch to share the same transaction",
          { source: SOURCE },
        );
      }
    }

    const executor = this.#executorFor(transaction, first.queue);
    for (const queue of new Set(jobs.map((j) => j.queue))) {
      await this.#prepareQueue(queue, executor !== undefined);
    }

    const rows = jobs.map((job) => {
      const id =
        job.options?.singletonKey === undefined
          ? randomUUID()
          : deterministicId(job.queue, job.options.singletonKey);
      return { id, spec: job, row: insertRow(job, id) };
    });

    const inserted = await wrap(
      () =>
        this.#boss.insert(
          rows.map((r) => r.row),
          executor === undefined ? {} : { db: executor },
        ),
      "enqueuing a batch of jobs",
    );
    const createdIds = new Set(inserted ?? []);

    return rows.map((r) => ({
      jobId: encodeJobId(r.spec.queue, r.id),
      created: createdIds.has(r.id),
    }));
  }

  async work<TPayload>(
    queue: string,
    handler: JobHandler<TPayload>,
    options?: WorkOptions,
  ): Promise<void> {
    assertQueueName(queue);
    const register = async (): Promise<void> => {
      await this.#ensureQueue(queue);
      await wrap(
        () =>
          this.#boss.work(
            queue,
            {
              // pg-boss v10 entrega un **array** de jobs; el puerto entrega
              // uno. Se pide metadata para conocer `retryCount`, que es el
              // `attempt` que el handler necesita para ser idempotente.
              batchSize: options?.concurrency ?? 1,
              includeMetadata: true,
              ...(options?.pollIntervalSeconds === undefined
                ? {}
                : { pollingIntervalSeconds: options.pollIntervalSeconds }),
            },
            async (batch) => {
              for (const job of batch) {
                const retryCount = (job as { retryCount?: number }).retryCount ?? 0;
                await handler({
                  jobId: encodeJobId(queue, job.id),
                  payload: job.data as TPayload,
                  // `attempt` empieza en 1; `retryCount` de pg-boss empieza en 0.
                  attempt: retryCount + 1,
                });
              }
            },
          ),
        "registering a worker",
      );
    };

    if (!this.#started) {
      this.#pendingWorkers.push(register);
      return;
    }
    await register();
  }

  async getJob<TPayload = unknown>(jobId: string): Promise<JobStatus<TPayload> | null> {
    const decoded = decodeJobId(jobId);
    if (decoded === null) return null;

    const row = await wrap(
      () => this.#boss.getJobById(decoded.queue, decoded.id, { includeArchive: true }),
      "reading a job",
    );
    if (row === null) return null;

    const state = mapState(row);
    const base = {
      jobId,
      queue: decoded.queue,
      state,
      payload: row.data as TPayload,
      attempt: (row.retryCount ?? 0) + 1,
      retryLimit: row.retryLimit ?? 0,
      createdAt: toDate(row.createdOn) ?? new Date(0),
    };
    const startedAt = toDate(row.startedOn);
    const completedAt = toDate(row.completedOn);
    const failureReason = failureReasonOf(row, state);

    return {
      ...base,
      ...(startedAt === null ? {} : { startedAt }),
      ...(completedAt === null ? {} : { completedAt }),
      ...(failureReason === null ? {} : { failureReason }),
    };
  }

  async cancel(jobId: string): Promise<boolean> {
    const decoded = decodeJobId(jobId);
    if (decoded === null) return false;
    const result = await wrap(
      () => this.#boss.cancel(decoded.queue, decoded.id),
      "cancelling a job",
    );
    // `cancelJobs` sólo toca jobs con `state < 'completed'`, así que `affected`
    // distingue «lo cancelé» de «ya no se podía» — que es justo lo que `FR-060`
    // necesita para decir «ya se está publicando, no se puede cancelar».
    return typeof result === "object" && result !== null ? result.affected > 0 : false;
  }

  async scheduleRecurring<TPayload>(spec: RecurringSpec<TPayload>): Promise<void> {
    assertQueueName(spec.queue);
    assertCron(spec.cron);

    const previous = this.#schedules.get(spec.queue);
    if (previous !== undefined && previous !== spec.name) {
      // Ver la limitación en la cabecera: `schedule` de pg-boss tiene
      // `PRIMARY KEY (name)` y `name` **es** la cola.
      throw new PortError(
        "conflict",
        `That queue already has a different recurring schedule ("${previous}")`,
        { source: SOURCE },
      );
    }

    await this.#ensureQueue(spec.queue);
    await wrap(
      () =>
        this.#boss.schedule(spec.queue, spec.cron, asData(spec.payload), {
          // §16.2 fija los resets a 00:00 **UTC**. Sin esto pg-boss usa la zona
          // del servidor y el reset se movería con el horario de verano.
          tz: "UTC",
        }),
      "scheduling a recurring job",
    );
    this.#schedules.set(spec.queue, spec.name);
  }

  /* -------------------------------------------------------------------- */

  #sendOptions(
    options: JobSpec<unknown>["options"],
    jobId: string,
    executor: QueueSqlExecutor | undefined,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { id: jobId };
    if (executor !== undefined) out["db"] = executor;
    if (options === undefined) return out;

    if (options.startAfter !== undefined) out["startAfter"] = options.startAfter;
    if (options.priority !== undefined) out["priority"] = options.priority;
    if (options.retryLimit !== undefined) {
      if (!Number.isInteger(options.retryLimit) || options.retryLimit < 0) {
        throw new PortError("bad_request", "retryLimit must be a non-negative integer", {
          source: SOURCE,
        });
      }
      out["retryLimit"] = options.retryLimit;
    }
    if (options.retryBackoff !== undefined) out["retryBackoff"] = options.retryBackoff;
    if (options.expireInSeconds !== undefined) {
      out["expireInSeconds"] = options.expireInSeconds;
    }
    // `singletonKey` **no** se pasa a pg-boss: no deduplica en una cola
    // `standard`. Ver la trampa 3 de la cabecera. La idempotencia la da `id`.
    return out;
  }

  #executorFor(
    transaction: QueueTransaction | undefined,
    queue: string,
  ): QueueSqlExecutor | undefined {
    if (transaction === undefined || transaction === null) return undefined;
    const convert = this.#config.toExecutor ?? defaultToExecutor;
    try {
      return convert(transaction);
    } catch (cause) {
      throw new PortError(
        "bad_request",
        `The transaction handle passed to queue "${queue}" is not one this adapter knows how to use`,
        { source: SOURCE, cause },
      );
    }
  }

  async #prepareQueue(queue: string, insideTransaction: boolean): Promise<void> {
    if (this.#knownQueues.has(queue)) return;
    if (insideTransaction) {
      // Ver la trampa 2: `ATTACH PARTITION` contra una transacción abierta
      // que ya tocó `job` es un abrazo mortal entre conexiones.
      throw new PortError(
        "bad_request",
        `Queue "${queue}" must be registered before enqueuing inside a transaction`,
        { source: SOURCE },
      );
    }
    await this.#ensureQueue(queue);
  }

  async #ensureQueue(queue: string): Promise<void> {
    if (this.#knownQueues.has(queue)) return;
    // `create_queue` es idempotente (`ON CONFLICT DO NOTHING` + salida
    // temprana), así que llamarlo de más no cuesta nada.
    await wrap(() => this.#boss.createQueue(queue), "creating a queue");
    this.#knownQueues.add(queue);
  }
}

/* ------------------------------------------------------------------------ *
 * Ids
 * ------------------------------------------------------------------------ */

const ID_SEPARATOR = "#";

/**
 * `cola#uuid`. Ver la limitación en la cabecera.
 *
 * El uuid queda al final y no contiene `#`, así que el parseo es por el último
 * separador y una cola con `#` en el nombre —que `assertQueueName` no
 * permite— igual no rompería.
 */
function encodeJobId(queue: string, id: string): string {
  return `${queue}${ID_SEPARATOR}${id}`;
}

function decodeJobId(jobId: string): { queue: string; id: string } | null {
  const at = jobId.lastIndexOf(ID_SEPARATOR);
  if (at <= 0 || at === jobId.length - 1) return null;
  const queue = jobId.slice(0, at);
  const id = jobId.slice(at + 1);
  if (!UUID.test(id)) return null;
  return { queue, id };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UUID v5 de `(cola, singletonKey)`.
 *
 * Es lo que convierte la clave de idempotencia de `NFR-004` en la clave
 * primaria del job. Se implementa acá —son doce líneas— en vez de traer
 * `uuid`: sumar una dependencia para esto sería peor negocio.
 *
 * El namespace es fijo y arbitrario; lo único que importa es que no cambie,
 * porque cambiarlo haría que las claves de idempotencia en vuelo dejen de
 * reconocerse.
 */
const NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"; // RFC 4122, namespace OID

function deterministicId(queue: string, singletonKey: string): string {
  const namespace = Buffer.from(NAMESPACE.replaceAll("-", ""), "hex");
  const name = Buffer.from(`${queue} ${singletonKey}`, "utf8");
  const digest = createHash("sha1")
    .update(Buffer.concat([namespace, name]))
    .digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  // Versión 5 y variante RFC 4122.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/* ------------------------------------------------------------------------ *
 * Conversión
 * ------------------------------------------------------------------------ */

function insertRow(job: JobSpec<unknown>, id: string): Record<string, unknown> {
  const row: Record<string, unknown> = { id, name: job.queue, data: asData(job.payload) };
  const options = job.options;
  if (options === undefined) return row;
  if (options.startAfter !== undefined)
    row["startAfter"] = options.startAfter.toISOString();
  if (options.priority !== undefined) row["priority"] = options.priority;
  if (options.retryLimit !== undefined) row["retryLimit"] = options.retryLimit;
  if (options.retryBackoff !== undefined) row["retryBackoff"] = options.retryBackoff;
  if (options.expireInSeconds !== undefined) {
    row["expireInSeconds"] = options.expireInSeconds;
  }
  return row;
}

function asData(payload: unknown): object {
  // pg-boss guarda `data` como jsonb. Un payload primitivo es legal en el
  // puerto (`JobSpec<TPayload>` no lo restringe) pero rompería el `::jsonb`,
  // así que se envuelve. El worker lo recibe envuelto igual, y eso sería una
  // sorpresa — por eso el adaptador prefiere fallar claro.
  if (typeof payload !== "object" || payload === null) {
    if (payload === undefined) return {};
    throw new PortError("bad_request", "Job payloads must be objects", {
      source: SOURCE,
    });
  }
  return payload;
}

/** Mensaje que pg-boss escribe cuando un job vence en `active`. */
const EXPIRED_MESSAGE = "job failed by timeout in active state";

function mapState(row: PgBossJobRow): JobState {
  switch (row.state) {
    case "created":
    case "retry":
      // `retry` es «va a volver a correr»: desde afuera eso es estar encolado.
      return "queued";
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      // pg-boss no tiene estado `expired`: un job que venció en `active` sale
      // como `failed` y la causa queda en `output`. El puerto sí lo distingue
      // (`NFR-005` trata distinto un vencimiento de un fallo del handler), así
      // que se reconstruye desde ahí.
      return outputMessage(row.output) === EXPIRED_MESSAGE ? "expired" : "failed";
    default:
      return "failed";
  }
}

function outputMessage(output: unknown): string | null {
  if (typeof output !== "object" || output === null) return null;
  const value = (output as { value?: unknown }).value;
  if (typeof value !== "object" || value === null) return null;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

/**
 * Nunca el error crudo del proveedor ni el stack del handler (§10, regla 6).
 *
 * `output` de pg-boss trae el error serializado del handler, que puede llevar
 * connection strings, nombres de host y payloads. Eso va al log, no a un campo
 * que la API puede terminar devolviendo.
 */
function failureReasonOf(_row: PgBossJobRow, state: JobState): string | null {
  if (state === "expired") return "The job exceeded its execution window";
  if (state !== "failed") return null;
  return "The job failed and exhausted its retries";
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/* ------------------------------------------------------------------------ *
 * Validación y traducción
 * ------------------------------------------------------------------------ */

function assertQueueName(queue: string): void {
  if (queue.length === 0 || queue.includes(ID_SEPARATOR)) {
    throw new PortError(
      "bad_request",
      `Invalid queue name: it must be non-empty and must not contain "${ID_SEPARATOR}"`,
      { source: SOURCE },
    );
  }
}

/**
 * Cron de 5 campos, validado antes de ir a la base.
 *
 * pg-boss valida con `cron-parser` recién cuando el timekeeper intenta
 * ejecutarlo, o sea que un cron inválido se aceptaría en silencio y fallaría
 * horas después en un proceso distinto. El contrato del puerto pide
 * `bad_request` **en la llamada**.
 */
function assertCron(cron: string): void {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new PortError(
      "bad_request",
      "Cron expressions must have exactly 5 fields (minute hour day month weekday)",
      { source: SOURCE },
    );
  }
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? "";
    const range = ranges[i];
    if (range === undefined || !isCronField(field, range[0], range[1])) {
      throw new PortError("bad_request", `Invalid cron field: "${field}"`, {
        source: SOURCE,
      });
    }
  }
}

function isCronField(field: string, min: number, max: number): boolean {
  for (const part of field.split(",")) {
    const [spec, step] = part.split("/");
    if (step !== undefined && !/^\d+$/.test(step)) return false;
    if (spec === undefined) return false;
    if (spec === "*") continue;
    const bounds = spec.split("-");
    if (bounds.length > 2) return false;
    for (const bound of bounds) {
      if (!/^\d+$/.test(bound)) return false;
      const value = Number(bound);
      if (value < min || value > max) return false;
    }
  }
  return true;
}

/**
 * Traduce cualquier cosa que salga de pg-boss o de Postgres.
 *
 * Los mensajes son neutrales porque cruzan hacia el cliente por
 * `PortError.toPublic()`. El original va en `cause`, que sólo ve el log —
 * `apps/api/src/http/errors.test.ts` verifica que no se filtre.
 */
async function wrap<T>(body: () => Promise<T>, what: string): Promise<T> {
  try {
    return await body();
  } catch (cause) {
    if (cause instanceof PortError) throw cause;
    throw translate(cause, what);
  }
}

function translate(cause: unknown, what: string): PortError {
  const code = (cause as { code?: unknown } | null)?.code;
  const message = cause instanceof Error ? cause.message : String(cause);

  // Códigos de Postgres. Sólo los que cambian la decisión del llamador.
  if (code === "57014") {
    return new PortError("timeout", `The job queue timed out while ${what}`, {
      source: SOURCE,
      cause,
    });
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "57P01" ||
    code === "57P03" ||
    code === "08006" ||
    code === "08003"
  ) {
    return new PortError(
      "provider_unavailable",
      `The job queue is unavailable while ${what}`,
      {
        source: SOURCE,
        cause,
      },
    );
  }
  if (code === "23505") {
    return new PortError("conflict", "That job already exists", {
      source: SOURCE,
      cause,
    });
  }
  if (/is not a valid queue|queue name|assert/i.test(message)) {
    // Los `assert` de `attorney.js` son validación de argumentos.
    return new PortError(
      "bad_request",
      `The job queue rejected the request while ${what}`,
      {
        source: SOURCE,
        cause,
      },
    );
  }
  return new PortError("provider_unavailable", `The job queue failed while ${what}`, {
    source: SOURCE,
    cause,
  });
}

/* ------------------------------------------------------------------------ *
 * Handles de transacción
 * ------------------------------------------------------------------------ */

/**
 * Reconoce las formas de transacción que existen en este repo.
 *
 * `packages/db` usa **postgres.js** (`postgres@3`), no `pg`. Su transacción es
 * la misma función `sql` acotada a una conexión, y `sql.unsafe(text, params)`
 * es la forma de correr SQL con parámetros posicionales — que es exactamente
 * lo que pg-boss necesita.
 */
function defaultToExecutor(transaction: QueueTransaction): QueueSqlExecutor {
  if (typeof transaction === "object" && transaction !== null) {
    const candidate = transaction as {
      executeSql?: unknown;
      unsafe?: unknown;
      query?: unknown;
    };
    if (typeof candidate.executeSql === "function") {
      return transaction as QueueSqlExecutor;
    }
    if (typeof candidate.query === "function") {
      // `pg`: `client.query(text, values)` ya devuelve `{ rows }`.
      const query = candidate.query.bind(transaction) as (
        text: string,
        values: unknown[],
      ) => Promise<{ rows: unknown[] }>;
      return { executeSql: (text, values) => query(text, values) };
    }
  }
  if (typeof transaction === "function") {
    const sql = transaction as unknown as {
      unsafe?: (text: string, values: unknown[]) => Promise<unknown>;
    };
    if (typeof sql.unsafe === "function") {
      const unsafe = sql.unsafe.bind(sql);
      return {
        executeSql: async (text, values) => {
          const rows = await unsafe(text, values);
          return { rows: Array.isArray(rows) ? [...(rows as unknown[])] : [] };
        },
      };
    }
  }
  throw new Error("unsupported transaction handle");
}
