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
  systemRng,
} from "@fastgram/adapters";
import { ALL_JOB_QUEUES, JOB_QUEUES } from "@fastgram/core";
import { createDb } from "@fastgram/db";
import type { JobHandler, SocialPublisher } from "@fastgram/ports";
import pino from "pino";

import { createContentBuildHandler } from "./content/build-handler.js";
import { createInfluencerPipelineHandler } from "./influencers/pipeline-handler.js";
import { createDiscoveryRefillHandler } from "./discovery/refill-handler.js";
import { createBrandStalenessHandler } from "./brand/staleness-handler.js";
import { createSnapshotPurgeHandler } from "./brand/snapshot-purge-handler.js";
import { createHealthServer, createWorkerHealth } from "./health/server.js";
import { createPublishHandler } from "./publishing/publish-handler.js";
import { loadWorkerEnv } from "./env.js";
import { JOB_CATALOG, type JobPolicy } from "./jobs/catalog.js";
import { createQuotaResetHandler } from "./jobs/quota-reset-handler.js";

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
 * `MemoryMediaRenderer` es un puesto de guardia, no la solución.
 *
 * El adaptador real **ya existe** (`HttpMediaRenderer`, `P2-RENDER-002`) y rinde
 * video de verdad. No está montado acá porque montarlo hoy **rompería todos los
 * builds**, y los tres bloqueos están medidos en `P2-RENDER-015`: las 42
 * fuentes no están en la máquina y el default daría `font_unavailable` —que el
 * adaptador traduce, correctamente, a un `bad_request` permanente: pieza
 * fallada y save reembolsado en **cada** build—; el servicio exige grant firmado
 * por defecto y el puerto no tiene por dónde pasarlo; y un slideshow de más de
 * un slide no entra en un `RenderResult`, que transporta un artefacto.
 *
 * Con el de memoria el pipeline corre de punta a punta y el artefacto son bytes
 * sintéticos. Con el real mal configurado, el pipeline **cobra y reembolsa en
 * bucle**. El de memoria es peor producto y mejor estado.
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
 * Los handlers, en **un solo lugar**.
 *
 * El mapa existe para que la lista de colas que sí se consumen no se escriba
 * dos veces: una al registrar y otra al reportar. Lo tenía duplicado y lo
 * encontré rompiéndolo a propósito — con el `work()` apuntando a otra cola, el
 * log seguía diciendo que `content-build` tenía handler. Un reporte de arranque
 * que miente sobre esto es peor que no tenerlo, porque es exactamente donde uno
 * va a mirar cuando una pieza se quede en `BUILDING`.
 */
/**
 * Publicadores por plataforma — **vacío, y a propósito**.
 *
 * No hay ni un adaptador real de `SocialPublisher`: `MemorySocialPublisher`
 * existe para los tests de contrato y montarlo acá marcaría posts como `POSTED`
 * con un permalink inventado. Eso es **mentir en los datos del usuario**, que es
 * peor que no publicar: el de memoria es un artefacto sintético aceptable para
 * un render —se ve que no es un video— pero un post "publicado" que no existe en
 * ninguna cuenta no se distingue de uno real hasta que alguien lo busca.
 *
 * Con el mapa vacío, el handler falla la fila con `provider_unavailable` y un
 * mensaje seguro de mostrar. **Eso sí es honesto**: el usuario programó algo,
 * llegó la hora, y se le dice que publicar no está disponible. La alternativa
 * —no registrar el handler— deja el post en `SCHEDULED` para siempre sin que
 * nada falle, que es exactamente el modo de falla que este worker existe para
 * cerrar.
 */
const PUBLISHERS: Readonly<Record<string, SocialPublisher>> = {};

const HANDLERS: Readonly<Record<string, JobHandler<unknown>>> = {
  [JOB_QUEUES.contentBuild]: createContentBuildHandler({
    db: handle.db,
    renderer,
    storage,
    clock,
    appRole,
    logger,
  }),
  [JOB_QUEUES.publishing]: createPublishHandler({
    db: handle.db,
    publishers: PUBLISHERS,
    clock,
    appRole,
    logger,
  }),
  /**
   * **Sin generador, y por eso mismo hay que montarlo.**
   *
   * No hay adaptador de `MediaGeneration`: el pipeline de `FR-080` son 15–20
   * minutos de GPU contra un proveedor que todavía no se eligió. Pero
   * `POST /influencers` **ya cobra 250 créditos**, así que no registrar el
   * handler deja al personaje en `generating_variations` para siempre y al
   * cargo sin devolver — el mismo agujero que el content save tuvo hasta hace
   * dos tandas. Con el handler montado y sin generador, el personaje se cierra
   * como `failed` y los 250 vuelven.
   */
  [JOB_QUEUES.influencerPipeline]: createInfluencerPipelineHandler({
    db: handle.db,
    clock,
    appRole,
    logger,
  }),
  /**
   * **Montado sin productor, y conviene saberlo.**
   *
   * Nada en el repo encola `discovery-refill` todavía: el nombre sólo aparece
   * en el catálogo y en `queues.ts`. O sea que registrar esto no llena ninguna
   * cola por sí solo.
   *
   * Se monta igual por el mismo criterio que el de influencers: lo que el
   * handler escribe **es verdad**. Rellena la cola con `planSuggestion`, que es
   * la selección ponderada de `AI-002` completa y testeada, y la
   * `aiExplanation` que persiste se deriva de la propia selección — no la
   * inventa un modelo que no existe. Con productor, funciona; sin productor, no
   * miente.
   */
  [JOB_QUEUES.discoveryRefill]: createDiscoveryRefillHandler({
    db: handle.db,
    // `systemRng` y no uno sembrado: la instancia se comparte entre entregas
    // concurrentes, así que un `SeededRng` acá no daría el determinismo que
    // promete — daría una secuencia compartida y entrelazada.
    rng: systemRng,
    appRole,
    logger,
  }),
  /**
   * **El primer trabajo programado que de verdad hace algo cada noche.**
   *
   * El dominio sabía decidir la staleness desde hace tandas y nadie la
   * aplicaba: sin handler, el bloque de abajo no programaba su cron, así que
   * ninguna fuente envejecía nunca. Montarlo es lo que enciende el cron.
   */
  [JOB_QUEUES.brandSourceStalenessSweep]: createBrandStalenessHandler({
    db: handle.db,
    clock,
    appRole,
    logger,
  }),
  /**
   * **Una obligación de retención, no una optimización** (`DATA-032`, §9.14).
   *
   * Montarlo es lo que enciende su cron: el bloque de abajo sólo programa las
   * colas con handler. Hoy **nada escribe snapshots** —el análisis de brand
   * sources todavía no persiste `brand_source_snapshots`—, así que cada noche
   * va a purgar cero. Se monta igual: el día que aparezca el productor, la
   * retención ya se está cumpliendo en vez de quedar como tarea pendiente.
   */
  [JOB_QUEUES.snapshotPurge]: createSnapshotPurgeHandler({
    db: handle.db,
    clock,
    appRole,
    logger,
  }),
  [JOB_QUEUES.quotaReset]: createQuotaResetHandler({
    db: handle.db,
    clock,
    appRole,
    logger,
  }),
};

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
