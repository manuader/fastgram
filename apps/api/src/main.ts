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
import { systemClock, MemoryStorage } from "@fastgram/adapters";
import { createDb } from "@fastgram/db";

import { loadApiEnv, parseCorsOrigins } from "./env.js";
import { buildServer } from "./server/app.js";
import { IdempotencyGuard } from "./http/idempotency.js";
import { TokenBucketLimiter } from "./http/rate-limit.js";
import { createDbIdempotencyStore } from "./support/idempotency-store.js";
import { createMemoryBucketStore } from "./support/bucket-store.js";

const env = loadApiEnv();

const handle = createDb({
  url: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
});

const clock = systemClock;
const appRole = env.DATABASE_APP_ROLE === "" ? undefined : env.DATABASE_APP_ROLE;

const app = await buildServer({
  deps: {
    db: handle.db,
    clock,
    /**
     * `MemoryStorage` es un puesto de guardia, no la solución.
     *
     * El adaptador S3/MinIO (`P1-STORAGE-*`) todavía no existe: `packages/adapters`
     * sólo trae la implementación en memoria. Con esto, los tres endpoints de reserva
     * responden con la forma correcta de §9.8 pero la `uploadUrl` es sintética y el
     * PUT del cliente no va a ningún lado. Es explícito a propósito: montar un stub
     * silencioso que "parece" firmar sería peor que un puerto declarado sin adaptador.
     */
    storage: new MemoryStorage(clock, env.S3_PUBLIC_URL ?? "memory://bucket"),
    limiter: new TokenBucketLimiter(createMemoryBucketStore(), clock),
    idempotency: new IdempotencyGuard(
      createDbIdempotencyStore({ db: handle.db, appRole }),
      clock,
    ),
    appRole,
  },
  corsOrigins: parseCorsOrigins(env.API_CORS_ORIGINS),
  logLevel: env.LOG_LEVEL,
});

try {
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
} catch (err: unknown) {
  app.log.error(err, "no se pudo abrir el puerto");
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
        await handle.close();
        process.exit(0);
      } catch (err: unknown) {
        app.log.error(err, "fallo durante el apagado");
        process.exit(1);
      }
    })();
  });
}
