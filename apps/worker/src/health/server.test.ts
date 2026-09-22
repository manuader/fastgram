/**
 * Lo de la sonda del worker que se puede afirmar **sin** base.
 *
 * Lo que necesita Postgres —que la sonda de verdad se ponga `down` con la base
 * caída, y que el motivo no salga por el cable— vive en
 * `test/health.int.test.ts`: con un doble en memoria eso pasaría por
 * construcción.
 */
import { describe, expect, it, vi } from "vitest";

import { createWorkerHealth, statusFrom } from "./server.js";
import type { BuildLogger } from "../content/build-handler.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Una base que responde, contando cuántas veces la sondaron. */
function baseQueResponde(): { db: never; veces: () => number } {
  let veces = 0;
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      veces += 1;
      return fn({ execute: async () => [] });
    },
  };
  return { db: db as never, veces: () => veces };
}

/** Una base que no responde nunca: la sonda tiene que caer por su techo. */
const baseColgada = {
  transaction: async () => new Promise(() => {}),
} as never;

describe("statusFrom · las dos dependencias son requeridas", () => {
  it("con todo arriba es `ok`", () => {
    expect(statusFrom({ database: "up", queue: "up" })).toBe("ok");
  });

  it("la cola caída es `unavailable`, NO `degraded`", () => {
    // Al revés que en la API, donde la cola sólo degrada porque se cae para
    // todas las réplicas a la vez y un 503 en todas asciende un fallo parcial a
    // total. Acá no hay tráfico que perder: un worker que no consume no sirve
    // para nada, y decir `ok` sería la mentira original de `/health` mudada de
    // proceso.
    expect(statusFrom({ database: "up", queue: "down" })).toBe("unavailable");
  });

  it("la base caída es `unavailable`", () => {
    expect(statusFrom({ database: "down", queue: "up" })).toBe("unavailable");
  });
});

describe("liveness NO toca la base", () => {
  it("responde `ok` con la base colgada", async () => {
    // Es la mitad que justifica que sean dos rutas. Si liveness pudiera fallar
    // por la base, una caída de Postgres reiniciaría la flota entera en bucle
    // contra una base que sigue caída.
    const health = createWorkerHealth({
      db: baseColgada,
      logger: silencioso,
      queueRunning: () => true,
      probeTimeoutMs: 20,
    });

    expect(health.liveness()).toEqual({ status: "ok", service: "worker" });
  });

  it("y responde `ok` con la cola parada", () => {
    const health = createWorkerHealth({
      db: baseColgada,
      logger: silencioso,
      queueRunning: () => false,
    });

    expect(health.liveness().status).toBe("ok");
  });
});

describe("una sonda colgada cae por su techo", () => {
  it("no se queda esperando para siempre: responde `down`", async () => {
    // Una sonda colgada es **peor** que un `down`: el orquestador la ve como
    // timeout y no como respuesta, así que no puede distinguir «la base está
    // mal» de «el proceso no contesta».
    const health = createWorkerHealth({
      db: baseColgada,
      logger: silencioso,
      queueRunning: () => true,
      probeTimeoutMs: 20,
    });

    const report = await health.readiness();
    expect(report.checks["database"]).toBe("down");
    expect(report.status).toBe("unavailable");
  });
});

describe("el cache y el single-flight", () => {
  it("dentro del TTL no vuelve a sondear", async () => {
    vi.useFakeTimers();
    try {
      const base = baseQueResponde();
      const health = createWorkerHealth({
        db: base.db,
        logger: silencioso,
        queueRunning: () => true,
        cacheTtlMs: 3_000,
      });

      await health.readiness();
      await health.readiness();
      expect(base.veces()).toBe(1);

      vi.advanceTimersByTime(3_001);
      await health.readiness();
      expect(base.veces()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("N sondas concurrentes hacen UNA ronda", async () => {
    // Sin single-flight el cache no protege durante una ráfaga, que es
    // exactamente cuando importa: una flota entera sondeando a la vez.
    const base = baseQueResponde();
    const health = createWorkerHealth({
      db: base.db,
      logger: silencioso,
      queueRunning: () => true,
      cacheTtlMs: 0,
    });

    await Promise.all([health.readiness(), health.readiness(), health.readiness()]);

    expect(base.veces()).toBe(1);
  });

  it("el fallo se cachea igual que el éxito", async () => {
    // La estampida importa sobre todo cuando la dependencia **ya** está mal.
    vi.useFakeTimers();
    try {
      let veces = 0;
      const db = {
        transaction: async () => {
          veces += 1;
          throw new Error("no");
        },
      } as never;
      const health = createWorkerHealth({
        db,
        logger: silencioso,
        queueRunning: () => true,
        cacheTtlMs: 3_000,
      });

      expect((await health.readiness()).status).toBe("unavailable");
      await health.readiness();
      expect(veces).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("el cuerpo no puede filtrar nada", () => {
  it("un fallo con host y puerto adentro no sale por el cable", async () => {
    const db = {
      transaction: async () => {
        throw new Error("connect ECONNREFUSED 10.1.2.3:5432 db=fastgram_prod");
      },
    } as never;
    const health = createWorkerHealth({
      db,
      logger: silencioso,
      queueRunning: () => true,
      cacheTtlMs: 0,
    });

    // Se afirma sobre el JSON **serializado**, no sobre el objeto: es lo que
    // viaja, y un campo de más se vería acá y no en un `toMatchObject`.
    const serializado = JSON.stringify(await health.readiness());
    expect(serializado).not.toContain("ECONNREFUSED");
    expect(serializado).not.toContain("10.1.2.3");
    expect(serializado).not.toContain("fastgram_prod");
    expect(JSON.parse(serializado)).toEqual({
      status: "unavailable",
      service: "worker",
      checks: { database: "down", queue: "up" },
    });
  });
});
