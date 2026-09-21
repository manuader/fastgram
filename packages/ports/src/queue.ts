/**
 * Puerto Queue — IMPL ADR-005 e IMPL §2.3, PRD §9.5, `NFR-004`, `NFR-025`.
 *
 * Qué lo obliga: ADR-005 elige pg-boss sobre BullMQ y cierra con «se migra a
 * BullMQ **sólo el job que demuestre saturar, detrás del puerto `Queue`**. No
 * al revés». Es una decisión pendiente documentada, que es la barra de IMPL §7
 * para crear un puerto.
 *
 * Lo que define la forma de la interfaz está en IMPL §2.3 y es la razón
 * principal por la que la cola vive en Postgres: **el encolado ocurre dentro
 * de la misma transacción que descuenta la cuota**. «Si el job se encolara en
 * Redis fuera de la transacción, un fallo entre commit y push deja cuota
 * consumida sin trabajo, o trabajo sin cuota». Y el PRD es explícito en que un
 * build fallido reembolsa el content save, lo que exige saber con certeza que
 * el job existe. De ahí {@link EnqueueOptions.transaction}.
 *
 * `singletonKey` no es una comodidad: `NFR-004` hace obligatoria la
 * idempotencia en toda operación facturable, y `NFR-015` prohíbe duplicar un
 * post en el carril lento de TikTok.
 *
 * Errores (`PortError`):
 *  - `provider_unavailable`, `timeout` — la cola no está alcanzable. En el
 *    camino transaccional esto **debe** abortar la transacción: es el único
 *    modo de que cuota y trabajo no se separen.
 *  - `conflict` — `singletonKey` ya en uso con otro payload.
 *  - `not_found` — `getJob` / `cancel` sobre un id que no existe.
 *  - `bad_request` — `cron` inválido, `retryLimit` negativo, nombre de cola vacío.
 *
 * Lo que este puerto NO hace: no reintenta a nivel de negocio (el reembolso
 * del save es de `core`), no conoce cuotas, y no decide concurrencia por
 * workspace — `NFR-025` (10 builds/min, 10 generaciones en vuelo) se aplica
 * antes de encolar.
 */

/**
 * Handle de transacción, deliberadamente sin tipar.
 *
 * Tiparlo obligaría a importar el cliente de la base, y `packages/ports` no
 * importa npm (regla `ports-are-pure`). El adaptador —que sí conoce a Drizzle—
 * lo estrecha. Es el único lugar del paquete donde el puerto renuncia a un
 * tipo, y renuncia a propósito: la alternativa era perder la garantía de
 * IMPL §2.3, que vale más.
 */
export type QueueTransaction = unknown;

/** Estados neutrales. No son los de ningún proveedor (§10, regla 6). */
export type JobState =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  /** Venció `expireInSeconds` sin completar. */
  | "expired";

export interface EnqueueOptions {
  /**
   * Encola **dentro** de esta transacción. Ver IMPL §2.3. Omitirlo en un
   * camino que descuenta cuota es un bug, no una optimización.
   */
  readonly transaction?: QueueTransaction;
  /**
   * Idempotencia: dos encolados con la misma clave producen un solo job.
   * Es la `Idempotency-Key` de `NFR-004` bajada a la cola.
   */
  readonly singletonKey?: string;
  /** No antes de este instante. `FR-060` programa posts así. */
  readonly startAfter?: Date;
  /** Reintentos automáticos. 0 = ninguno. Ver `NFR-005`. */
  readonly retryLimit?: number;
  /** Backoff exponencial entre reintentos. */
  readonly retryBackoff?: boolean;
  /** Segundos desde que arranca hasta que se declara `expired`. */
  readonly expireInSeconds?: number;
  /** Mayor corre antes. Default 0. */
  readonly priority?: number;
}

export interface JobSpec<TPayload> {
  /** Cola destino. Uno de los 21 trabajos de §9.5. */
  readonly queue: string;
  readonly payload: TPayload;
  readonly options?: EnqueueOptions;
}

export interface EnqueuedJob {
  readonly jobId: string;
  /**
   * `false` cuando `singletonKey` ya existía y se devolvió el job previo. Es
   * lo que permite al caso de uso distinguir «encolé» de «ya estaba» sin
   * consultar.
   */
  readonly created: boolean;
}

export interface JobStatus<TPayload = unknown> {
  readonly jobId: string;
  readonly queue: string;
  readonly state: JobState;
  readonly payload: TPayload;
  readonly attempt: number;
  readonly retryLimit: number;
  readonly createdAt: Date;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  /**
   * Motivo del último fallo, ya traducido. **Nunca** el error crudo del
   * proveedor ni de un SDK de tercero (§10, regla 6).
   */
  readonly failureReason?: string;
}

export interface JobContext<TPayload> {
  readonly jobId: string;
  readonly payload: TPayload;
  /** Intento actual, empezando en 1. Un handler idempotente lo ignora. */
  readonly attempt: number;
}

export type JobHandler<TPayload> = (job: JobContext<TPayload>) => Promise<void>;

export interface WorkOptions {
  /**
   * Jobs simultáneos de esta cola en este proceso. `NFR-025`: el render
   * cuellea y hay que limitarlo.
   */
  readonly concurrency?: number;
  /** Cada cuánto busca trabajo, cuando el adaptador hace polling. */
  readonly pollIntervalSeconds?: number;
}

export interface RecurringSpec<TPayload> {
  /** Único. Reprogramar con el mismo nombre reemplaza la programación. */
  readonly name: string;
  readonly queue: string;
  /**
   * Cron de 5 campos. **Siempre en UTC**: §16.2 fija los resets a 00:00 UTC y
   * §9.5 #17 los exige diarios. Una zona local acá movería el reset con el
   * horario de verano.
   */
  readonly cron: string;
  readonly payload: TPayload;
}

export interface Queue {
  /** Ver {@link EnqueueOptions.transaction}. */
  enqueue<TPayload>(job: JobSpec<TPayload>): Promise<EnqueuedJob>;

  /**
   * Varios jobs en una sola ida. El fan-out de publicación crea un `Post` por
   * (contenido × plataforma × cuenta) (`FR-060`); hacerlo de a uno multiplica
   * las idas dentro de la transacción de negocio.
   *
   * **Todo o nada** cuando se pasa `transaction`: la transacción es la que da
   * la atomicidad, no el puerto.
   */
  enqueueMany(jobs: readonly JobSpec<unknown>[]): Promise<readonly EnqueuedJob[]>;

  /** Registra el consumidor. El handler debe ser idempotente: puede reintentarse. */
  work<TPayload>(
    queue: string,
    handler: JobHandler<TPayload>,
    options?: WorkOptions,
  ): Promise<void>;

  /** Para el polling de `NFR-002` y el watcher de TikTok (`NFR-015`). */
  getJob<TPayload = unknown>(jobId: string): Promise<JobStatus<TPayload> | null>;

  /**
   * Cancela si todavía no arrancó. Devuelve `false` si ya estaba corriendo o
   * terminado — `FR-060` depende de esa distinción: «Posts scheduled for today
   * are handed off quickly and can't be cancelled once they're being posted».
   */
  cancel(jobId: string): Promise<boolean>;

  /** Trabajos periódicos de §9.5: reset de cuota, staleness sweep, purga, métricas. */
  scheduleRecurring<TPayload>(spec: RecurringSpec<TPayload>): Promise<void>;

  /** Conecta y arranca los consumidores registrados. */
  start(): Promise<void>;

  /** Apagado ordenado: deja terminar lo activo y no toma trabajo nuevo. */
  stop(): Promise<void>;
}
