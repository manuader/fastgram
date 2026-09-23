/**
 * Worker — consumidores de la cola (`ADR-005`, cola en Postgres).
 *
 * Hasta esta tanda este archivo imprimía *"sin handlers todavía"* y terminaba.
 * Eso tenía una consecuencia que no se veía desde acá: `POST /content` creaba
 * la pieza, **cobraba el content save** y encolaba el build, y la pieza se
 * quedaba en `BUILDING` para siempre con el save cobrado y sin devolver.
 *
 * Ahora consume `content-build` y `quota-reset`. Los otros 19 trabajos de §9.5
 * siguen sin handler, y eso se dice en el log al arrancar en vez de quedar
 * implícito: una cola con productor y sin consumidor es el peor modo de falla
 * que tiene este sistema, porque no falla nada.
 *
 * Orden de arranque, y por qué ése:
 *  1. **Validar el entorno.** Si falta algo, el proceso muere acá con el nombre
 *     de la variable.
 *  2. Abrir la base y construir los adaptadores.
 *  3. Registrar los handlers — antes de `start()`, porque el adaptador los
 *     encola y los registra al arrancar.
 *  4. Arrancar la cola.
 *  5. **Programar los recurrentes**, que va después de `start()` porque crean
 *     la cola si falta y pg-boss rechaza el DDL con el boss parado.
 *  6. Y recién entonces el apagado limpio.
 */
import {
  createPgBossQueue,
  drizzleTransactionToExecutor,
  MemoryMediaRenderer,
  S3Storage,
  systemClock,
} from "@fastgram/adapters";
import { ALL_JOB_QUEUES } from "@fastgram/core";
import { createDb } from "@fastgram/db";
import type { MediaRenderer } from "@fastgram/ports";
import pino from "pino";

import { createHandlers } from "./handlers.js";
import { createHealthServer, createWorkerHealth } from "./health/server.js";
import { loadWorkerEnv, renderServiceFromEnv } from "./env.js";
import { JOB_CATALOG, type JobPolicy } from "./jobs/catalog.js";
import { createNormalizationRenderer } from "./media/normalization-renderer.js";

const env = loadWorkerEnv();
const logger = pino({ level: env.LOG_LEVEL });

const handle = createDb({ url: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
const clock = systemClock;
const appRole = env.DATABASE_APP_ROLE === "" ? undefined : env.DATABASE_APP_ROLE;

/**
 * La cola.
 *
 * `supervise: true` y `schedule: true`, al revés que en la API: el
 * mantenimiento (expirar, archivar) y el cron de §9.5 son trabajo del
 * consumidor. Si los hiciera la API, cada réplica de la API los haría en
 * paralelo con todas las demás.
 *
 * `migrate: false` sin bandera que lo cambie: el DDL del esquema de la cola lo
 * hace la API con `QUEUE_MIGRATE`. Dos procesos compitiendo por los mismos
 * objetos al arrancar es un modo de falla que no hace falta tener.
 */
const { queue } = createPgBossQueue({
  connectionString: env.DATABASE_URL,
  schema: env.QUEUE_SCHEMA,
  queues: [...ALL_JOB_QUEUES],
  toExecutor: drizzleTransactionToExecutor,
  migrate: false,
  supervise: true,
  schedule: true,
});

/**
 * `MemoryMediaRenderer` es un puesto de guardia **para `content-build`**, no la
 * solución.
 *
 * El adaptador real **ya existe** (`HttpMediaRenderer`, `P2-RENDER-002`) y rinde
 * video de verdad. No está montado para los builds porque hoy **rompería todos
 * los builds**, y los bloqueos están medidos en `P2-RENDER-015`: las fuentes no
 * están instaladas donde el motor las busca y el servicio respondería
 * `font_unavailable` —que el adaptador traduce, correctamente, a un
 * `bad_request` permanente: pieza fallada y save reembolsado en **cada**
 * build—; el audio no tiene origen definido; y `build-handler` todavía no usa
 * `renderAll`, así que un slideshow de más de un slide no entra.
 *
 * Con el de memoria el pipeline corre de punta a punta y el artefacto son bytes
 * sintéticos. Con el real mal configurado, el pipeline **cobra y reembolsa en
 * bucle**. El de memoria es peor producto y mejor estado.
 *
 * **`media-normalization` no usa esta instancia**: tiene su propio
 * `HttpMediaRenderer`, montado sólo si el entorno trae `RENDER_SERVICE_URL` y
 * `RENDER_MEDIA_GRANT_SECRET` (ver {@link createNormalizationRendererFromEnv}).
 * `probe`/`normalize` no dibujan texto, así que el bloqueo de las fuentes no les
 * aplica. Cambiar *esta* línea por el real sigue siendo `P2-RENDER-015`.
 */
const renderer = new MemoryMediaRenderer();

/**
 * El storage, **real** — `P1-STORAGE-007`, `ADR-006`.
 *
 * Acá estaba `MemoryStorage`. Con la API ya sobre S3 y el worker sobre memoria,
 * `contents.files` guardaría `memory://bucket/...`: URLs que no sirve nadie,
 * escritas en una columna persistida y devueltas por la API como si fueran
 * buenas.
 *
 * Campo por campo igual que `apps/api/src/support/storage.ts`. **No se importa
 * de ahí**: `apps/worker` no depende de `apps/api`, y si conviene que exista
 * una sola definición el sitio es `@fastgram/adapters` o `@fastgram/config` —
 * es una decisión de IMPL §2.2, no de un `import`.
 *
 * **Una diferencia real con la API, y no es cosmética:** la API nunca hace
 * `put()` —los bytes del usuario van directo al bucket por la URL firmada— y el
 * worker sí, al guardar el render. Ahí entra la deuda declarada del adaptador:
 * sin `@aws-sdk/lib-storage` no hay multipart, así que `put` con un
 * `AsyncIterable` **acumula en memoria** hasta `maxBufferedBytes` y falla
 * fuerte. En la API ese tope es inerte; acá es el que se va a tocar.
 */
const storage = new S3Storage({
  bucket: env.S3_BUCKET,
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

/**
 * El renderer de `media-normalization`, o `null` si el servicio de render no
 * está configurado. El «todas o ninguna» de las variables ya lo cortó
 * `loadWorkerEnv`; acá sólo se decide entre las dos mitades válidas.
 *
 * Con configuración, pide la versión del motor a `GET /capabilities` **antes**
 * de montar nada: si el servicio no contesta, el worker no levanta (ver
 * `media/normalization-renderer.ts` por qué).
 */
async function createNormalizationRendererFromEnv(): Promise<MediaRenderer | null> {
  const config = renderServiceFromEnv(env);
  if (config === null) return null;
  const created = await createNormalizationRenderer(config);
  // Nunca el secreto: sólo a dónde se habla.
  logger.info({ baseUrl: config.baseUrl }, "servicio de render para media-normalization");
  return created;
}

const normalizationRenderer = await createNormalizationRendererFromEnv();

const { handlers: HANDLERS, unmounted } = createHandlers({
  db: handle.db,
  renderer,
  normalizationRenderer,
  storage,
  clock,
  appRole,
  logger,
});

for (const [name, handler] of Object.entries(HANDLERS)) {
  await queue.work(name, handler, { concurrency: env.WORKER_CONCURRENCY });
}

const conHandler = Object.keys(HANDLERS);
const sinHandler = Object.values(JOB_CATALOG)
  .map((p) => p.name)
  .filter((name) => !(name in HANDLERS));

await queue.start();

/**
 * Los trabajos programados de §9.5.
 *
 * **Después de `start()`**, no antes: `scheduleRecurring` crea la cola si falta
 * y pg-boss rechaza el DDL con el boss parado. Es el mismo orden que la trampa
 * 21 deja escrito para `work()`.
 *
 * Y **sólo los que tienen handler.** Programar el cron de una cola que nadie
 * consume es el peor modo de falla de este sistema —el que no falla—: los jobs
 * se acumulan, nadie los toma, y el log de arranque diría que el trabajo está
 * programado. La lista de los que quedaran afuera va al log, igual que las
 * colas sin consumidor.
 *
 * El cron sale del catálogo y no de acá: es la política del consumidor y ya
 * está escrita con su razón. El adaptador lo registra **en UTC** (§16.2 fija
 * los resets a 00:00 UTC y una zona local los movería con el horario de verano).
 */
const programados: string[] = [];
const programablesSinHandler: string[] = [];
// Se ensancha a `JobPolicy` a propósito: `JOB_CATALOG` es `as const`, así que
// las entradas sin cron **no tienen** la propiedad `scheduled` en su tipo
// literal y la unión no la deja leer. El `satisfies` del catálogo garantiza que
// este ensanchamiento es correcto.
const policies: readonly JobPolicy[] = Object.values(JOB_CATALOG);
for (const policy of policies) {
  if (policy.scheduled === undefined) continue;
  if (!(policy.name in HANDLERS)) {
    programablesSinHandler.push(policy.name);
    continue;
  }
  await queue.scheduleRecurring({
    // `RecurringSpec.name` tiene que ser único y el adaptador lo indexa por
    // cola (una programación por cola, ver su cabecera), así que el nombre de
    // la cola es el nombre natural de la programación.
    name: policy.name,
    queue: policy.name,
    cron: policy.scheduled.cron,
    // Vacío a propósito: un barrido no se apunta a nadie. Ver el handler.
    payload: {},
  });
  programados.push(`${policy.name} (${policy.scheduled.cron} UTC)`);
}

logger.info(
  {
    colas: conHandler,
    sinHandler: sinHandler.length,
    programados,
    concurrency: env.WORKER_CONCURRENCY,
  },
  "worker arriba",
);
if (programablesSinHandler.length > 0) {
  logger.warn(
    { colas: programablesSinHandler },
    "trabajos con cron en el catálogo y sin handler: NO se programaron, " +
      "porque encolar contra una cola que nadie consume no falla nunca",
  );
}
// Una línea por cola que **tiene** handler y quedó afuera por configuración,
// con el porqué. Hoy es sólo `media-normalization` sin servicio de render.
for (const { queue: name, why } of unmounted) {
  logger.warn({ cola: name }, `handler no montado: ${why}`);
}
// A nivel `warn` y con la lista entera: son 20 colas en las que la API ya
// encola y que nadie lee. Verlo cada vez que arranca el proceso es el punto.
logger.warn(
  { colas: sinHandler },
  "colas sin handler: lo que se encole ahí no lo consume nadie",
);

/**
 * Apagado limpio.
 *
 * `queue.stop()` deja de tomar trabajo nuevo y **espera a que terminen los jobs
 * activos**. Importa: un build a mitad de camino puede estar en la transacción
 * que reembolsa un save. La base se cierra después, no antes, por eso mismo.
 */
/**
 * La sonda de salud, **después** de `queue.start()`.
 *
 * `queueRunning` es una función y no un booleano capturado: tiene que reflejar
 * el apagado. Un worker que ya recibió SIGTERM y dejó de consumir debe decir
 * `unavailable` mientras termina, no `ok` hasta el último milisegundo.
 */
let queueRunning = true;
const healthServer =
  env.WORKER_HEALTH_PORT === 0
    ? null
    : createHealthServer(
        createWorkerHealth({
          db: handle.db,
          appRole,
          logger,
          queueRunning: () => queueRunning,
        }),
        logger,
      );

if (healthServer !== null) {
  healthServer.listen(env.WORKER_HEALTH_PORT, () => {
    logger.info({ port: env.WORKER_HEALTH_PORT }, "sonda de salud escuchando");
  });
}

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "apagando");
    void (async () => {
      try {
        // Antes de nada: el worker deja de estar listo **en cuanto** empieza a
        // apagarse, no cuando termina.
        queueRunning = false;
        healthServer?.close();
        await queue.stop();
        await handle.close();
        process.exit(0);
      } catch (error: unknown) {
        logger.error({ error }, "fallo durante el apagado");
        process.exit(1);
      }
    })();
  });
}
