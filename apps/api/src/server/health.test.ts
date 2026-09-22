/**
 * `createHealthChecker` — la lógica que decide si la API está lista.
 *
 * Todo lo de acá es sin base y sin red: las sondas son funciones que resuelven o
 * lanzan, que es exactamente la forma del tipo `Probe`. Lo que hay que fijar es
 * lo que no se ve leyendo el código de producción —qué cachea, cuánto, qué pasa
 * cuando una sonda no vuelve, y **qué sale en el cuerpo**—, y eso se puede medir
 * entero acá. El camino contra Postgres de verdad lo cubre `health.int.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { FixedClock } from "@fastgram/adapters";

import {
  createHealthChecker,
  livenessReport,
  statusCodeFor,
  type Dependency,
  type Probes,
} from "./health.js";

/** Sondas que se pueden encender y apagar, y que cuentan cuántas veces corrieron. */
function probesUnder(state: Record<Dependency, boolean>): {
  probes: Probes;
  calls: Record<Dependency, number>;
} {
  const calls: Record<Dependency, number> = { database: 0, storage: 0, queue: 0 };
  const make = (dependency: Dependency) => async (): Promise<void> => {
    calls[dependency] += 1;
    if (!state[dependency]) {
      // Un mensaje con pinta de error real de proveedor: es lo que NO tiene que
      // aparecer en el cuerpo de la respuesta.
      throw new Error(
        'connect ECONNREFUSED 10.1.4.7:5432 — database "fastgram_prod" user "app"',
      );
    }
  };
  return {
    calls,
    probes: {
      database: make("database"),
      storage: make("storage"),
      queue: make("queue"),
    },
  };
}

const allUp = (): Record<Dependency, boolean> => ({
  database: true,
  storage: true,
  queue: true,
});

describe("createHealthChecker", () => {
  it("con las tres arriba: `ok`, y el código HTTP es 200", async () => {
    const { probes } = probesUnder(allUp());
    const health = createHealthChecker({
      probes,
      clock: new FixedClock("2026-09-22T00:00:00.000Z"),
      ttlMs: 0,
    });

    const report = await health.check();
    expect(report).toEqual({
      status: "ok",
      service: "api",
      checks: { database: "up", storage: "up", queue: "up" },
    });
    expect(statusCodeFor(report)).toBe(200);
  });

  it("una sonda caída: `degraded`, **503**, y dice cuál", async () => {
    // Éste es el caso entero de `P1-OBS-004`: antes esto era un literal y el 503
    // no existía. Si alguien vuelve a poner una constante, este test lo dice.
    const state = { ...allUp(), database: false };
    const { probes } = probesUnder(state);
    const health = createHealthChecker({
      probes,
      clock: new FixedClock("2026-09-22T00:00:00.000Z"),
      ttlMs: 0,
    });

    const report = await health.check();
    expect(report.status).toBe("unavailable");
    expect(statusCodeFor(report)).toBe(503);
    expect(report.checks).toEqual({ database: "down", storage: "up", queue: "up" });
  });

  it("storage o cola abajo: `degraded` pero **200**, no saca de rotación", async () => {
    // La decisión de la tabla de la cabecera, fijada donde se puede romper sin
    // querer. Storage afecta a 5 rutas de 30 y la cola a 4, y se caen para todas
    // las réplicas a la vez: un 503 acá asciende un fallo parcial a total. Lo
    // que sí tiene que pasar es que el cuerpo lo diga, para que la alerta lo vea.
    for (const caida of ["storage", "queue"] as const) {
      const { probes } = probesUnder({ ...allUp(), [caida]: false });
      const health = createHealthChecker({
        probes,
        clock: new FixedClock("2026-09-22T00:00:00.000Z"),
        ttlMs: 0,
      });

      const report = await health.check();
      expect(report.status).toBe("degraded");
      expect(statusCodeFor(report)).toBe(200);
      expect(report.checks[caida]).toBe("down");
      expect(report.checks.database).toBe("up");
    }
  });

  it("Postgres abajo gana sobre el resto: `unavailable`, no `degraded`", async () => {
    const { probes } = probesUnder({ database: false, storage: false, queue: false });
    const health = createHealthChecker({
      probes,
      clock: new FixedClock("2026-09-22T00:00:00.000Z"),
      ttlMs: 0,
    });

    const report = await health.check();
    expect(report.status).toBe("unavailable");
    expect(statusCodeFor(report)).toBe(503);
  });

  it("una sonda caída no impide que las otras dos se evalúen", async () => {
    // Corren en paralelo y se recogen con `Promise.all` sobre resultados ya
    // capturados: si alguna vez se escribieran en secuencia con un `await` que
    // lanza, un storage caído escondería el estado de la cola y el operador
    // arreglaría una cosa para descubrir la otra recién en el siguiente deploy.
    const { probes, calls } = probesUnder({
      database: false,
      storage: false,
      queue: true,
    });
    const health = createHealthChecker({
      probes,
      clock: new FixedClock("2026-09-22T00:00:00.000Z"),
      ttlMs: 0,
    });

    const report = await health.check();
    expect(report.checks).toEqual({
      database: "down",
      storage: "down",
      queue: "up",
    });
    expect(calls).toEqual({ database: 1, storage: 1, queue: 1 });
  });

  it("el cuerpo NO filtra el error del proveedor", async () => {
    // La sonda lanza con host, puerto, nombre de base y usuario adentro. El
    // cuerpo es público —`/health` no lleva auth— así que nada de eso puede
    // cruzar. Se mide sobre el JSON serializado y no sobre el objeto, porque lo
    // que viaja al cable es el string.
    const { probes } = probesUnder({ ...allUp(), database: false });
    const seen: { dependency: Dependency; message: string }[] = [];
    const health = createHealthChecker({
      probes,
      clock: new FixedClock("2026-09-22T00:00:00.000Z"),
      ttlMs: 0,
      onProbeFailure: (dependency, error) => {
        seen.push({ dependency, message: (error as Error).message });
      },
    });

    const body = JSON.stringify(await health.check());
    for (const secreto of [
      "ECONNREFUSED",
      "10.1.4.7",
      "5432",
      "fastgram_prod",
      "postgres",
      "user",
    ]) {
      expect(body).not.toContain(secreto);
    }
    // Las claves son exactamente tres: nada de `version`, `uptime`, `hostname`
    // ni `error`, que es lo que la gente agrega "para diagnosticar".
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual([
      "checks",
      "service",
      "status",
    ]);

    // Y el motivo real sí llegó al log, que es donde sirve.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.dependency).toBe("database");
    expect(seen[0]?.message).toContain("ECONNREFUSED");
  });

  it("con TTL, la segunda llamada no vuelve a sondear", async () => {
    const state = allUp();
    const { probes, calls } = probesUnder(state);
    const health = createHealthChecker({
      probes,
      clock: new FixedClock("2026-09-22T00:00:00.000Z"),
      ttlMs: 3_000,
    });

    await health.check();
    await health.check();
    await health.check();

    // Tres peticiones, una sola ronda de sondas: es la amortiguación que evita
    // que la carga contra la base crezca con la flota × la frecuencia de sondeo.
    expect(calls).toEqual({ database: 1, storage: 1, queue: 1 });
  });

  it("vencido el TTL, vuelve a sondear y ve el cambio de estado", async () => {
    // El control del anterior. Sin esto, "no vuelve a sondear" pasaría también
    // con un cache que no vence nunca, que es un bug y no una optimización.
    const state = allUp();
    const { probes, calls } = probesUnder(state);
    const clock = new FixedClock("2026-09-22T00:00:00.000Z");
    const health = createHealthChecker({ probes, clock, ttlMs: 3_000 });

    expect((await health.check()).status).toBe("ok");

    state.storage = false;
    // Dentro de la ventana sigue diciendo lo viejo, y eso es lo aceptado: el
    // retraso máximo es el TTL.
    clock.advanceMs(2_999);
    expect((await health.check()).status).toBe("ok");
    expect(calls.storage).toBe(1);

    clock.advanceMs(2);
    const report = await health.check();
    expect(report.status).toBe("degraded");
    expect(report.checks.storage).toBe("down");
    expect(calls.storage).toBe(2);
  });

  it("el fallo se cachea igual que el éxito", async () => {
    // A propósito: la estampida importa sobre todo cuando la dependencia ya está
    // mal. Un cache que sólo guardara los éxitos dejaría a una base caída
    // recibiendo una tormenta de reconexiones desde cada réplica.
    const { probes, calls } = probesUnder({ ...allUp(), queue: false });
    const health = createHealthChecker({
      probes,
      clock: new FixedClock("2026-09-22T00:00:00.000Z"),
      ttlMs: 3_000,
    });

    expect((await health.check()).status).toBe("degraded");
    expect((await health.check()).status).toBe("degraded");
    expect(calls.queue).toBe(1);
  });

  it("single-flight: N peticiones concurrentes son una sola ronda de sondas", async () => {
    // Sin esto, el arranque de una réplica —o el vencimiento simultáneo del TTL
    // en todas— dispara un `HeadObject` por petición en vuelo.
    let resolver: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    let corridas = 0;
    const probe = async (): Promise<void> => {
      corridas += 1;
      await gate;
    };
    const health = createHealthChecker({
      probes: { database: probe, storage: probe, queue: probe },
      clock: new FixedClock("2026-09-22T00:00:00.000Z"),
      // Sin cache: lo único que puede colapsar las diez es el single-flight.
      ttlMs: 0,
    });

    const enVuelo = Array.from({ length: 10 }, () => health.check());
    resolver?.();
    const reports = await Promise.all(enVuelo);

    expect(reports.every((r) => r.status === "ok")).toBe(true);
    // 3 = una por dependencia, no diez por dependencia.
    expect(corridas).toBe(3);
  });

  it("una sonda que no vuelve se corta y cuenta como caída", async () => {
    // Una sonda colgada es **peor** que un 503: el orquestador la ve como
    // timeout y no como respuesta, y en una livenessProbe eso es un reinicio.
    const nuncaVuelve = (): Promise<void> => new Promise<void>(() => {});
    const health = createHealthChecker({
      probes: {
        database: nuncaVuelve,
        storage: async () => {},
        queue: async () => {},
      },
      clock: new FixedClock("2026-09-22T00:00:00.000Z"),
      ttlMs: 0,
      timeoutMs: 20,
    });

    const report = await health.check();
    expect(report.status).toBe("unavailable");
    expect(report.checks.database).toBe("down");
    // Las otras dos no esperaron a la colgada: corren en paralelo.
    expect(report.checks.storage).toBe("up");
    expect(report.checks.queue).toBe("up");
  });
});

describe("livenessReport", () => {
  it("es constante y no menciona ninguna dependencia", async () => {
    // Que sea constante es el punto: liveness responde *"el proceso está vivo"*,
    // y lo único que un reinicio puede arreglar es que no lo esté. Mezclar acá
    // una dependencia convierte una caída de Postgres en un reinicio en cascada.
    expect(livenessReport()).toEqual({ status: "ok", service: "api" });
    expect(Object.keys(livenessReport())).not.toContain("checks");
  });
});
