/**
 * `/health` contra dependencias de verdad — `P1-OBS-004`.
 *
 * ## Por qué este archivo existe además del unitario
 *
 * `src/server/health.test.ts` mide la lógica del chequeo con sondas de mentira:
 * el cache, el single-flight, el timeout y que el cuerpo no filtre nada. Lo que
 * **no** puede medir es si las sondas de verdad sondean algo. Una sonda que
 * abriera una transacción y no mirara el resultado pasaría el unitario entero y
 * seguiría devolviendo 200 con Postgres caído, que es exactamente el bug que
 * esta tarea cierra.
 *
 * Así que acá se levanta la app contra el Postgres real y, sobre todo, **se
 * rompe cada dependencia a propósito** para ver el 503. Un camino de fallo que
 * nunca se ejecutó no está verificado: es una rama de código con buena
 * intención.
 *
 * ## El `FixedClock` y el cache
 *
 * El arnés monta `/health` con `healthCacheTtlMs: 0`. Con el reloj congelado un
 * cache de 3 s no vencería nunca y los casos de abajo medirían la primera
 * respuesta tres veces. Está documentado en `helpers/harness.ts` y en
 * `src/server/health.ts`; se repite acá porque es la clase de detalle que hace
 * perder una tarde.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { APP_ROLE, createDb, type DbHandle } from "@fastgram/db";
import type { Storage } from "@fastgram/ports";

import { buildServer } from "../src/server/app.js";
import { IdempotencyGuard } from "../src/http/idempotency.js";
import { createDbIdempotencyStore } from "../src/support/idempotency-store.js";
import { openLimiter, startApi, type ApiHarness } from "./helpers/harness.js";
import { DATABASE_URL } from "./helpers/fixtures.js";

/** El esquema que pg-boss crea por defecto y que `QUEUE_SCHEMA` puede cambiar. */
const QUEUE_SCHEMA = "pgboss";

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi({ queueSchema: QUEUE_SCHEMA });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

interface HealthBody {
  status: string;
  service: string;
  checks: Record<string, string>;
}

const bodyOf = (raw: string): HealthBody => JSON.parse(raw) as HealthBody;

/** Las apps que abre `appWith`. Se cierran al final del archivo. */
const abiertas: (() => Promise<void>)[] = [];

/**
 * Una app con las dependencias que se le pasen, para romper una a la vez.
 *
 * No usa `startApi` porque ése siembra y migra, y lo que hace falta acá es una
 * app con **una** dependencia rota y el resto sana. Devuelve también los handles
 * que abrió, para cerrarlos: una conexión colgada deja a vitest sin terminar.
 */
async function appWith(overrides: {
  dbUrl?: string;
  storage?: Storage;
  withQueue?: boolean;
  queueSchema?: string | null;
}): Promise<{ inject: (url: string) => Promise<{ status: number; raw: string }> }> {
  const clock = new FixedClock("2026-09-21T12:00:00.000Z");
  const handle: DbHandle = createDb({
    url: overrides.dbUrl ?? DATABASE_URL,
    max: 2,
    onnotice: () => {},
  });

  const app = await buildServer({
    deps: {
      db: handle.db,
      clock,
      storage: overrides.storage ?? new MemoryStorage(clock),
      limiter: openLimiter(clock),
      idempotency: new IdempotencyGuard(
        createDbIdempotencyStore({ db: handle.db, appRole: APP_ROLE }),
        clock,
      ),
      appRole: APP_ROLE,
      // La sonda sólo mira que `deps.queue` esté montada, y después consulta la
      // base: la `RecordingQueue` del arnés alcanza y sobra.
      ...((overrides.withQueue ?? true) ? { queue: api.queue } : {}),
      ...(overrides.queueSchema === null
        ? {}
        : { queueSchema: overrides.queueSchema ?? QUEUE_SCHEMA }),
    },
    logLevel: "silent",
    enableAccessLog: false,
    healthCacheTtlMs: 0,
  });
  await app.ready();

  // Se cierra al terminar el archivo entero; cada caso abre una app y la deja
  // registrada acá abajo.
  abiertas.push(async () => {
    await app.close();
    await handle.close();
  });

  return {
    inject: async (url) => {
      const res = await app.inject({ method: "GET", url });
      return { status: res.statusCode, raw: res.body };
    },
  };
}

afterAll(async () => {
  for (const cerrar of abiertas) await cerrar();
});

/* ══════════════════════════════════════════════════════════════════════════
 * El camino sano
 * ══════════════════════════════════════════════════════════════════════════ */

describe("GET /health — todo arriba", () => {
  it("200 con las tres dependencias en `up`, sin auth y fuera de /api/v1", async () => {
    const res = await api.app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(bodyOf(res.body)).toEqual({
      status: "ok",
      service: "api",
      checks: { database: "up", storage: "up", queue: "up" },
    });
  });

  it("`/health/ready` dice exactamente lo mismo que `/health`", async () => {
    const health = await api.app.inject({ method: "GET", url: "/health" });
    const ready = await api.app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(health.statusCode);
    expect(ready.body).toBe(health.body);
  });

  it("`/health/live` responde 200 y no menciona ninguna dependencia", async () => {
    const res = await api.app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res.body)).toEqual({ status: "ok", service: "api" });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * Los caminos de fallo — el punto entero de la tarea
 * ══════════════════════════════════════════════════════════════════════════ */

describe("GET /health — la sonda puede fallar", () => {
  it("con Postgres inalcanzable: 503 y `database: down`", async () => {
    // El bug de `P1-OBS-004` en una línea. Antes de esto, esta misma app
    // respondía `200 {status:"ok"}` con la base apuntando a un puerto muerto.
    //
    // Puerto 1: nadie escucha nunca ahí, así que el `connect` falla rápido con
    // ECONNREFUSED en vez de esperar al timeout de la sonda. Eso hace el caso
    // determinista y de milisegundos, que es lo que permite tenerlo en CI en vez
    // de como experimento manual.
    const app = await appWith({
      dbUrl: "postgres://fastgram:fastgram@127.0.0.1:1/fastgram",
    });

    const res = await app.inject("/health");
    expect(res.status).toBe(503);
    const body = bodyOf(res.raw);
    expect(body.status).toBe("unavailable");
    expect(body.checks["database"]).toBe("down");
    // La cola consulta la misma base, así que cae con ella. El storage no.
    expect(body.checks["queue"]).toBe("down");
    expect(body.checks["storage"]).toBe("up");
  });

  it("con Postgres caído, `/health/live` SIGUE en 200", async () => {
    // Es la mitad que justifica que sean dos rutas. Si liveness también fallara,
    // el orquestador reiniciaría todas las réplicas por una base caída:
    // reiniciar no levanta Postgres, tira las peticiones en vuelo, y deja al
    // deployment en CrashLoopBackOff justo cuando lo que hace falta es que las
    // réplicas estén listas para volver a servir en cuanto la base vuelva.
    const app = await appWith({
      dbUrl: "postgres://fastgram:fastgram@127.0.0.1:1/fastgram",
    });

    const live = await app.inject("/health/live");
    expect(live.status).toBe(200);
    expect(bodyOf(live.raw)).toEqual({ status: "ok", service: "api" });
  });

  it("con el storage rechazando: 503 y `storage: down`", async () => {
    // Se delega en `MemoryStorage` para todo menos `head`, en vez de desparramar
    // la instancia con `...`: un spread de una instancia de clase copia las
    // propiedades propias y **no** los métodos del prototipo, así que el objeto
    // resultante no implementaría el puerto y el fallo aparecería como un
    // `TypeError` en la sonda — o sea, un `down` por la razón equivocada.
    const base = new MemoryStorage(new FixedClock("2026-09-21T12:00:00.000Z"));
    const roto: Storage = {
      createUploadUrl: (r) => base.createUploadUrl(r),
      put: (r) => base.put(r),
      get: (k) => base.get(k),
      createDownloadUrl: (r) => base.createDownloadUrl(r),
      delete: (k) => base.delete(k),
      head: async (): Promise<never> => {
        // Con la forma del error que tira el adaptador de S3 cuando las
        // credenciales están mal. Nada de esto puede aparecer en el cuerpo.
        throw new Error(
          "Object storage rejected the credentials — bucket fastgram-prod at " +
            "https://abc123.r2.cloudflarestorage.com",
        );
      },
    };
    const app = await appWith({ storage: roto });

    const res = await app.inject("/health");
    // **200, no 503**, y a propósito: el storage afecta a cinco rutas de treinta
    // y se cae para todas las réplicas a la vez, así que sacarlas de rotación
    // ascendería un fallo parcial a total. Lo que tiene que pasar es que el
    // cuerpo lo diga. Ver la tabla de `src/server/health.ts`.
    expect(res.status).toBe(200);
    const body = bodyOf(res.raw);
    expect(body.status).toBe("degraded");
    expect(body.checks["storage"]).toBe("down");
    // Y la base sigue sana: una dependencia caída no arrastra a las otras.
    expect(body.checks["database"]).toBe("up");

    // Cero fuga, medido sobre el cuerpo tal como sale al cable.
    for (const secreto of [
      "r2.cloudflarestorage.com",
      "fastgram-prod",
      "credentials",
      "bucket",
    ]) {
      expect(res.raw).not.toContain(secreto);
    }
  });

  it("sin cola montada: `degraded` con `queue: down`, y sigue en 200", async () => {
    // Sin `deps.queue` las cuatro rutas que encolan responden `503` a propósito.
    // Es información que el cuerpo tiene que dar —y que hoy no daba ningún
    // lado— pero no motivo para sacar la réplica de rotación: las otras 26 rutas
    // funcionan, y la cola no se cae "sólo acá".
    const app = await appWith({ withQueue: false });

    const res = await app.inject("/health");
    expect(res.status).toBe(200);
    expect(bodyOf(res.raw).status).toBe("degraded");
    expect(bodyOf(res.raw).checks["queue"]).toBe("down");
    expect(bodyOf(res.raw).checks["database"]).toBe("up");
  });

  it("con un QUEUE_SCHEMA que no existe: `queue: down`", async () => {
    // Éste es el que prueba que la sonda de la cola **consulta de verdad**. Con
    // la cola montada y la base sana, lo único que puede tumbarla es que el
    // esquema no sea visible para el rol de la aplicación — que es el fallo que
    // describe `packages/db/src/queue-grants.ts` y que hasta ahora aparecía
    // recién en la primera petición que encolaba.
    const app = await appWith({ queueSchema: "pgboss_que_no_existe" });

    const res = await app.inject("/health");
    const body = bodyOf(res.raw);
    expect(body.status).toBe("degraded");
    expect(body.checks["queue"]).toBe("down");
    expect(body.checks["database"]).toBe("up");
    expect(body.checks["storage"]).toBe("up");
  });

  it("el control: con el esquema bueno, la misma app dice `queue: up`", async () => {
    // Sin este caso, un `queue: "down"` constante pasaría el de arriba sin que
    // nadie lo note.
    const app = await appWith({ queueSchema: QUEUE_SCHEMA });
    const res = await app.inject("/health");
    expect(res.status).toBe(200);
    expect(bodyOf(res.raw).status).toBe("ok");
    expect(bodyOf(res.raw).checks["queue"]).toBe("up");
  });
});
