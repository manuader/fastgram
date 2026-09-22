/**
 * La sonda del worker, contra Postgres y por HTTP de verdad — `P1-OBS-004`.
 *
 * ## Por qué HTTP real y no llamar a `readiness()` a secas
 *
 * Lo que un orquestador consume es el **código de estado**, y ésa es
 * precisamente la parte que un test de la función pura no toca: que
 * `unavailable` viaje como **503** y `ok` como **200**, y que liveness siga
 * dando 200 con todo lo demás caído. Una sonda que devolviera el informe
 * correcto con un 200 pegado sería indistinguible de un worker sano.
 *
 * ## La base caída se simula apuntando a un puerto muerto
 *
 * No se baja el contenedor: lo comparten las otras suites. `postgres.js` conecta
 * de forma perezosa, así que un handle con una URL mala se construye sin error y
 * falla al primer query — que es exactamente el camino que la sonda recorre.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createDb, APP_ROLE, type DbHandle } from "@fastgram/db";

import { createHealthServer, createWorkerHealth } from "../src/health/server.js";
import type { BuildLogger } from "../src/content/build-handler.js";
import { openDb } from "./helpers/fixtures.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let sana: DbHandle;
let muerta: DbHandle;
const servidores: Server[] = [];

interface Respuesta {
  readonly status: number;
  readonly texto: string;
  readonly cuerpo: Record<string, unknown>;
}

/** Levanta un servidor en un puerto efímero y devuelve su base. */
async function levantar(options: {
  db: DbHandle;
  queueRunning: boolean;
}): Promise<string> {
  const server = createHealthServer(
    createWorkerHealth({
      db: options.db.db,
      appRole: APP_ROLE,
      logger: silencioso,
      queueRunning: () => options.queueRunning,
      // Sin cache: cada test quiere una medición, no la de otro test.
      cacheTtlMs: 0,
      probeTimeoutMs: 3_000,
    }),
    silencioso,
  );
  servidores.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const dir = server.address();
  if (dir === null || typeof dir === "string") throw new Error("sin puerto");
  return `http://127.0.0.1:${String(dir.port)}`;
}

async function pedir(base: string, ruta: string): Promise<Respuesta> {
  const res = await fetch(`${base}${ruta}`);
  const texto = await res.text();
  return {
    status: res.status,
    texto,
    cuerpo: JSON.parse(texto) as Record<string, unknown>,
  };
}

beforeAll(() => {
  sana = openDb();
  // Puerto 1: nada escucha ahí. No se toca el contenedor de nadie.
  muerta = createDb({ url: "postgres://x:x@127.0.0.1:1/x", max: 1, onnotice: () => {} });
}, 60_000);

afterAll(async () => {
  for (const s of servidores) s.close();
  await sana?.close();
  await muerta?.close().catch(() => {});
});

describe("todo arriba", () => {
  it("`/health` responde 200 con las dos sondas en `up`", async () => {
    const base = await levantar({ db: sana, queueRunning: true });

    const res = await pedir(base, "/health");

    expect(res.status).toBe(200);
    expect(res.cuerpo).toEqual({
      status: "ok",
      service: "worker",
      checks: { database: "up", queue: "up" },
    });
  });

  it("`/health/ready` dice lo mismo que `/health`", async () => {
    const base = await levantar({ db: sana, queueRunning: true });

    const ready = await pedir(base, "/health/ready");
    const health = await pedir(base, "/health");

    expect(ready.cuerpo).toEqual(health.cuerpo);
    expect(ready.status).toBe(health.status);
  });
});

describe("la base caída", () => {
  it("`/health` responde 503, no 200", async () => {
    const base = await levantar({ db: muerta, queueRunning: true });

    const res = await pedir(base, "/health");

    expect(res.status).toBe(503);
    expect(res.cuerpo["status"]).toBe("unavailable");
    expect((res.cuerpo["checks"] as Record<string, string>)["database"]).toBe("down");
  });

  it("`/health/live` sigue en 200: reiniciar no levanta la base", async () => {
    // **La mitad que justifica que sean dos rutas.** Si liveness cayera acá,
    // una caída de Postgres reiniciaría la flota entera en bucle contra una
    // base que sigue caída.
    const base = await levantar({ db: muerta, queueRunning: true });

    const res = await pedir(base, "/health/live");

    expect(res.status).toBe(200);
    expect(res.cuerpo).toEqual({ status: "ok", service: "worker" });
  });

  it("el `ECONNREFUSED` con host y puerto NO sale por el cable", async () => {
    const base = await levantar({ db: muerta, queueRunning: true });

    const res = await pedir(base, "/health");

    // Sobre el **texto** de la respuesta, no sobre el objeto: es lo que viaja.
    expect(res.texto).not.toContain("ECONNREFUSED");
    expect(res.texto).not.toContain("127.0.0.1");
    expect(res.texto).not.toContain("5432");
    expect(Object.keys(res.cuerpo).sort()).toEqual(["checks", "service", "status"]);
  });
});

describe("la cola parada", () => {
  it("con la base sana pero sin consumir, responde 503", async () => {
    // Es el caso que la sonda existe para ver: el proceso está vivo, la base
    // responde, y **nadie está sacando jobs de la cola**. Sin esto, un worker
    // así no lo dice en ningún lado y los jobs se acumulan en silencio.
    const base = await levantar({ db: sana, queueRunning: false });

    const res = await pedir(base, "/health");

    expect(res.status).toBe(503);
    expect((res.cuerpo["checks"] as Record<string, string>)["queue"]).toBe("down");
    expect((res.cuerpo["checks"] as Record<string, string>)["database"]).toBe("up");
  });
});

describe("cualquier otra ruta", () => {
  it("es 404 y no un 200 vacío", async () => {
    const base = await levantar({ db: sana, queueRunning: true });

    expect((await pedir(base, "/")).status).toBe(404);
    expect((await pedir(base, "/metrics")).status).toBe(404);
  });
});
