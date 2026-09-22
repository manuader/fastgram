/**
 * Sonda de salud del worker — `P1-OBS-004`, `F-255`.
 *
 * ## Por qué el worker necesita una, y por qué NO es la misma que la de la API
 *
 * `apps/api` ya tiene health checks que comprueban dependencias de verdad. El
 * worker no tenía **ninguna**: un worker con la base caída no lo decía en
 * ningún lado, y ése es el modo de falla más silencioso del sistema — nada
 * responde con error porque **nadie le pregunta nada**. Los jobs se acumulan y
 * el proceso parece vivo.
 *
 * Pero la semántica se **invierte** respecto de la API, y copiar aquel diseño
 * acá sería un error:
 *
 * **Liveness.** Para la API, reiniciar por una base caída es dañino: no levanta
 * la base, tira las peticiones en vuelo y mete el deployment en
 * `CrashLoopBackOff`. Para un worker, en cambio, **un consumidor trabado es
 * exactamente lo que un reinicio arregla** — una conexión wedged o un pg-boss
 * que dejó de hacer poll se recuperan reiniciando, y no hay peticiones en vuelo
 * que perder: pg-boss reentrega el job.
 *
 * Aun así `/health/live` **no toca la base**. Si Postgres se cae, todos los
 * workers fallarían liveness a la vez y el orquestador los reiniciaría en bucle
 * contra una base que sigue caída — cambiando una degradación por un
 * `CrashLoopBackOff` de la flota entera.
 *
 * **Readiness.** Para la API saca la réplica de rotación. Acá **no hay
 * balanceador**: nadie le enruta nada a un worker. Lo que readiness sí hace es
 * **frenar un rollout** — una revisión nueva que no llega a `ready` no reemplaza
 * a los workers sanos que están corriendo. Por eso sí comprueba la base.
 *
 * ## Cero fuga
 *
 * Mismo criterio que la API: el cuerpo son tres claves y `"up"`/`"down"`. Nunca
 * la cadena de conexión, ni el host, ni el mensaje crudo de Postgres. El motivo
 * va al log.
 */
import { createServer, type Server } from "node:http";

import { withoutCompany, type Database } from "@fastgram/db";

import type { BuildLogger } from "../content/build-handler.js";

export type ProbeState = "up" | "down";

export interface WorkerHealthReport {
  readonly status: "ok" | "unavailable";
  readonly service: "worker";
  readonly checks: Readonly<Record<string, ProbeState>>;
}

export interface LivenessReport {
  readonly status: "ok";
  readonly service: "worker";
}

export interface WorkerHealthDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  /** `true` mientras la cola esté arrancada y nadie la haya parado. */
  readonly queueRunning: () => boolean;
  /** Vida de una lectura. Ver el comentario del cache. */
  readonly cacheTtlMs?: number;
  /** Techo por sonda. Una sonda colgada es peor que un `down`. */
  readonly probeTimeoutMs?: number;
}

/**
 * 3 s, el mismo que la API y por la misma razón: una sonda es un amplificador
 * —la carga crece con flota × frecuencia, no con el trabajo real— y 3 s está
 * por debajo del `periodSeconds` habitual, así que colapsa ráfagas sin esconder
 * ninguna transición.
 */
const DEFAULT_CACHE_TTL_MS = 3_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Las dos son **requeridas**, al revés que en la API.
 *
 * Allá el storage y la cola sólo degradan porque se caen para todas las
 * réplicas a la vez y un 503 en todas asciende un fallo parcial a total. Acá no
 * hay tráfico que perder: un worker que no consume **no sirve para nada**, y
 * decir `ok` sería la mentira original de `/health` mudada de proceso.
 */
export function statusFrom(
  checks: Readonly<Record<string, ProbeState>>,
): "ok" | "unavailable" {
  return Object.values(checks).some((estado) => estado === "down") ? "unavailable" : "ok";
}

async function conTecho<T>(promesa: Promise<T>, ms: number): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promesa,
      new Promise<never>((_resolve, reject) => {
        temporizador = setTimeout(() => {
          reject(new Error("la sonda excedió su techo"));
        }, ms);
      }),
    ]);
  } finally {
    if (temporizador !== undefined) clearTimeout(temporizador);
  }
}

export interface WorkerHealth {
  readonly readiness: () => Promise<WorkerHealthReport>;
  readonly liveness: () => LivenessReport;
}

export function createWorkerHealth(deps: WorkerHealthDeps): WorkerHealth {
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const techo = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  let cache: { readonly at: number; readonly report: WorkerHealthReport } | null = null;
  let enVuelo: Promise<WorkerHealthReport> | null = null;

  async function sondearBase(): Promise<ProbeState> {
    try {
      // **Por el mismo camino que un handler**, con `SET LOCAL ROLE`. Un
      // `select 1` por la conexión pelada no vería que el rol no pueda asumir
      // `fastgram_app`, que rompe cada job con la base perfectamente sana.
      await conTecho(
        withoutCompany(
          deps.db,
          // Cadena cruda y no el tag `sql` de drizzle: **`apps/worker` no puede
          // importar `drizzle-orm`**, y es a propósito — es lo que impide que
          // un proceso arme su propio `WHERE` y se olvide el tenant.
          (tx) => tx.execute("select 1"),
          deps.appRole === undefined ? {} : { role: deps.appRole },
        ),
        techo,
      );
      return "up";
    } catch (error: unknown) {
      deps.logger.error({ dependency: "database", error }, "sonda de salud fallida");
      return "down";
    }
  }

  async function medir(): Promise<WorkerHealthReport> {
    const checks: Record<string, ProbeState> = {
      database: await sondearBase(),
      queue: deps.queueRunning() ? "up" : "down",
    };
    return { status: statusFrom(checks), service: "worker", checks };
  }

  async function readiness(): Promise<WorkerHealthReport> {
    const ahora = Date.now();
    if (cache !== null && ahora - cache.at < ttl) return cache.report;
    // **Single-flight**: N sondas concurrentes hacen **una** ronda. Sin esto el
    // cache no protege durante una ráfaga, que es justo cuando importa.
    enVuelo ??= medir().finally(() => {
      enVuelo = null;
    });
    const report = await enVuelo;
    cache = { at: Date.now(), report };
    return report;
  }

  return {
    readiness,
    // No toca nada: ver el encabezado. Si esto pudiera fallar por la base, una
    // caída de Postgres reiniciaría la flota entera en bucle.
    liveness: () => ({ status: "ok", service: "worker" }),
  };
}

export function createHealthServer(health: WorkerHealth, logger: BuildLogger): Server {
  return createServer((request, response) => {
    const ruta = (request.url ?? "/").split("?")[0];

    const enviar = (code: number, cuerpo: unknown): void => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(cuerpo));
    };

    if (ruta === "/health/live") {
      enviar(200, health.liveness());
      return;
    }
    if (ruta === "/health" || ruta === "/health/ready") {
      health
        .readiness()
        .then((report) => {
          enviar(report.status === "unavailable" ? 503 : 200, report);
        })
        .catch((error: unknown) => {
          // Que la propia sonda explote **no puede** devolver 200: desde afuera
          // sería indistinguible de un worker sano.
          logger.error({ error }, "la sonda de salud del worker lanzó");
          enviar(503, { status: "unavailable", service: "worker", checks: {} });
        });
      return;
    }
    enviar(404, { error: { code: "not_found" } });
  });
}
