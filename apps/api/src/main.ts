/**
 * Punto de entrada de la API — P1-API-001.
 *
 * Este es el **único** archivo que lee el entorno y construye adaptadores. Todo lo
 * demás recibe sus dependencias, que es lo que permite que la suite de integración
 * levante la app entera contra un Postgres real sin variables de entorno ni puertos.
 *
 * Orden de arranque, y por qué ese:
 *  1. **Validar el entorno.** Si falta algo, el proceso muere acá con el nombre de la
 *     variable. Un proceso que arranca a medias falla tres horas después, en la única
 *     ruta que la usa (P0-REPO-009).
 *  2. Abrir la base y construir los adaptadores.
 *  3. Montar el servidor.
 *  4. Escuchar, y recién entonces registrar el apagado limpio.
 */
import {
  createPgBossQueue,
  drizzleTransactionToExecutor,
  systemClock,
} from "@fastgram/adapters";
import { ALL_JOB_QUEUES } from "@fastgram/core";
import { createDb, grantQueueSchemaAccess } from "@fastgram/db";

import { loadApiEnv, parseCorsOrigins } from "./env.js";
import { buildServer } from "./server/app.js";
import { IdempotencyGuard } from "./http/idempotency.js";
import { TokenBucketLimiter } from "./http/rate-limit.js";
import { createDbIdempotencyStore } from "./support/idempotency-store.js";
import { createMemoryBucketStore } from "./support/bucket-store.js";
import { checkCanonicalUrlBase, createStorage } from "./support/storage.js";

const env = loadApiEnv();

const handle = createDb({
  url: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
});

const clock = systemClock;
const appRole = env.DATABASE_APP_ROLE === "" ? undefined : env.DATABASE_APP_ROLE;

/**
 * El storage — `P1-STORAGE-007`, `ADR-006`, §9.8.
 *
 * Acá estaba `MemoryStorage`, con un comentario que se llamaba a sí mismo *"un
 * puesto de guardia"*. La consecuencia no era teórica: la `uploadUrl` de la
 * reserva era sintética, el PUT del cliente no iba a ningún lado y el `head()`
 * de la finalización devolvía `null`, así que **`POST /media` respondía `409`
 * siempre** y el Media Bank entero no funcionaba.
 *
 * Construirlo no abre ninguna conexión: el cliente de S3 es perezoso y firmar
 * es CPU local. O sea que un endpoint inalcanzable **no** se ve acá — se ve en
 * la primera petición que firma. Es lo correcto: lo que el arranque puede
 * comprobar es que la configuración existe, no que el bucket responda.
 */
const storage = createStorage(env);

/**
 * La cola — `ADR-005`.
 *
 * Tres cosas que no son obvias y que costaron encontrarlas:
 *
 * 1. **`toExecutor` es obligatorio.** El puente por defecto no reconoce el
 *    handle de una transacción de Drizzle, y ése es justamente el handle que
 *    viaja desde las rutas. Sin él, encolar dentro de la transacción de negocio
 *    —o sea, lo único que `ADR-005` compra sobre Redis— falla con
 *    `bad_request`.
 *
 * 2. **Las colas se registran al arrancar.** pg-boss exige que la cola exista
 *    antes de encolar en ella, y dentro de una transacción no hay forma de
 *    crearla al vuelo. Se pasan las 21 de `JOB_QUEUES`, que es la misma lista
 *    que consume el catálogo del worker.
 *
 * 3. **`supervise` y `schedule` en `false`.** La API sólo encola; mantener y
 *    disparar el cron es trabajo del worker. Con esto encendido, cada réplica
 *    de la API haría el mantenimiento en paralelo con todas las demás.
 */
const { queue } = createPgBossQueue({
  connectionString: env.DATABASE_URL,
  schema: env.QUEUE_SCHEMA,
  queues: [...ALL_JOB_QUEUES],
  toExecutor: drizzleTransactionToExecutor,
  migrate: env.QUEUE_MIGRATE,
  supervise: false,
  schedule: false,
});

// **`queue.start()`, no `boss.start()`.** El adaptador hace las dos cosas: arranca
// pg-boss y **crea las colas** de `queues`. Arrancando el `boss` pelado, el proceso
// levanta bien y la primera petición que encola muere con *"Queue must be registered
// before enqueuing inside a transaction"* — que es correcto, porque dentro de una
// transacción no hay forma de crear la cola al vuelo. Lo encontré haciendo un
// `POST /content` contra el binario compilado; los tipos no lo ven, porque las dos
// llamadas existen.
await queue.start();

/**
 * Los privilegios del rol de la aplicación sobre el esquema de la cola.
 *
 * Va acá y no en una migración porque el nombre del esquema es configurable y
 * una migración SQL no se parametriza: la migración `0004` cubre el default
 * (`pgboss`) y esto cubre cualquier otro. Va **después** de `queue.start()`
 * porque hasta ahí las tablas de pg-boss no existen.
 *
 * Y va atado a `QUEUE_MIGRATE` porque es el mismo permiso: un proceso que no
 * está autorizado a hacer DDL sobre la cola tampoco debería repartir
 * privilegios. En producción esto es parte del deploy, no del arranque.
 *
 * Sin esto, con un `QUEUE_SCHEMA` que no sea el default, el proceso arranca
 * sano, `/health` responde 200, y **sólo la primera petición que encola se
 * cae** con *permission denied*. Lo encontró `pnpm smoke:binary`.
 */
if (env.QUEUE_MIGRATE) {
  await grantQueueSchemaAccess(handle.db, { schema: env.QUEUE_SCHEMA });
}

const app = await buildServer({
  deps: {
    db: handle.db,
    clock,
    storage,
    limiter: new TokenBucketLimiter(createMemoryBucketStore(), clock),
    idempotency: new IdempotencyGuard(
      createDbIdempotencyStore({ db: handle.db, appRole }),
      clock,
    ),
    appRole,
    queue,
    // Sólo para la sonda de `/health` (`P1-OBS-004`): con el nombre del esquema
    // se puede comprobar que el rol de la aplicación **vea** las tablas de
    // pg-boss, que es justo el fallo que describe el bloque de
    // `grantQueueSchemaAccess` de más arriba y que hasta ahora no se notaba
    // hasta la primera petición que encolaba.
    queueSchema: env.QUEUE_SCHEMA,
  },
  corsOrigins: parseCorsOrigins(env.API_CORS_ORIGINS),
  logLevel: env.LOG_LEVEL,
});

/**
 * El hueco del CDN, dicho en voz alta.
 *
 * `canonicalObjectUrl` arma la dirección que se **persiste** (`Media.r2Url`,
 * `Content.files`) firmando una descarga y tirándole la query, así que apunta
 * al endpoint de firma. Con MinIO en desarrollo eso coincide con
 * `S3_PUBLIC_URL`; con R2 detrás de un CDN, no, y lo guardado queda apuntando
 * al endpoint de la API de R2 —que no sirve nada públicamente— sin ningún
 * síntoma hasta que alguien abre un video.
 *
 * Cerrarlo de verdad es un cambio en `@fastgram/adapters` (ver el reporte de
 * `P1-STORAGE-007`); lo que se puede hacer desde acá es que no sea silencioso.
 * No aborta el arranque: la configuración es válida, sólo produce URLs que no
 * son las del CDN, y matar el proceso por eso dejaría sin API a quien todavía
 * no tiene CDN.
 */
const urlCheck = await checkCanonicalUrlBase(storage, env.S3_PUBLIC_URL);
if (urlCheck.kind === "diverged") {
  app.log.warn(
    { canonicalBase: urlCheck.canonicalBase, publicBase: urlCheck.publicBase },
    "las URLs que se persisten apuntan al endpoint de firma, no a S3_PUBLIC_URL: " +
      "`Media.r2Url` y `Content.files` van a guardar direcciones que el CDN no sirve",
  );
} else if (urlCheck.kind === "unknown") {
  app.log.warn(
    { reason: urlCheck.reason },
    "no se pudo comprobar la base de las URLs canónicas",
  );
}

try {
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
} catch (err: unknown) {
  app.log.error(err, "no se pudo abrir el puerto");
  await queue.stop();
  await handle.close();
  process.exit(1);
}

/**
 * Apagado limpio.
 *
 * `app.close()` deja de aceptar conexiones y **espera a que terminen las que están en
 * vuelo**. Importa más de lo que parece: una request que estaba a mitad de la
 * transacción que descuenta cuota no puede cortarse por la mitad. La conexión a la
 * base se cierra después, no antes, por la misma razón.
 *
 * `once` y no `on`: un segundo SIGTERM durante el apagado no debe reentrar.
 */
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "apagando");
    void (async () => {
      try {
        await app.close();
        // La cola después del servidor y antes de la base, por el mismo motivo
        // que el resto del orden: una request en vuelo puede estar encolando.
        await queue.stop();
        await handle.close();
        process.exit(0);
      } catch (err: unknown) {
        app.log.error(err, "fallo durante el apagado");
        process.exit(1);
      }
    })();
  });
}
