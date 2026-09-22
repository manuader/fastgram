/**
 * Health checks de la API — `P1-OBS-004`.
 *
 * ## El bug que esto cierra
 *
 * `GET /health` devolvía `{status:"ok", service:"api"}` **literal**. O sea que
 * respondía `200` con Postgres caído, con las credenciales de S3 mal, y con el
 * esquema de la cola sin permisos — los tres estados en los que la API no puede
 * servir nada útil. Un health check que no puede fallar no informa: es una
 * constante con una URL, y encima una que da confianza falsa, porque el
 * orquestador la interpreta como *"esta réplica está bien"*.
 *
 * El repositorio ya tenía el síntoma escrito dos veces sin que nadie lo
 * conectara: `main.ts` y `packages/db/src/queue-grants.ts` dicen que con un
 * `QUEUE_SCHEMA` no-default *"el proceso arranca sano, `/health` responde 200, y
 * sólo la primera petición que encola se cae con permission denied"*. Ese es
 * exactamente el fallo que una sonda de readiness tiene que ver.
 *
 * ## Liveness y readiness son dos preguntas distintas
 *
 * | Ruta | Pregunta | Qué hace el orquestador con la respuesta |
 * |---|---|---|
 * | `GET /health/live` | ¿el proceso está vivo? | si falla, **reinicia** |
 * | `GET /health/ready` | ¿puede atender tráfico? | si falla, **la saca de rotación** |
 * | `GET /health` | igual que `/health/ready` | es la URL que ya estaba desplegada |
 *
 * Y por eso **no** pueden ser la misma sonda. Un proceso vivo con la base caída
 * no debe recibir tráfico, pero tampoco debe ser reiniciado: reiniciarlo no
 * levanta Postgres, tira las peticiones en vuelo, borra el pool y —si la base
 * tarda en volver— mete al deployment entero en `CrashLoopBackOff` justo cuando
 * lo que hace falta es que las réplicas estén listas para volver a servir en
 * cuanto la dependencia vuelva. Por eso `/health/live` **no toca ninguna
 * dependencia**: contesta 200 mientras el event loop conteste, que es
 * literalmente la única cosa que un reinicio puede arreglar.
 *
 * `/health` se queda con la semántica de readiness y no con la de liveness
 * porque es la URL que ya existe —la usa el smoke del binario— y dejarla
 * siempre-200 sería dejar la mentira puesta en el único sitio al que alguien
 * apunta. **Consecuencia operativa, dicha en voz alta:** si un manifiesto tiene
 * hoy `/health` como `livenessProbe`, hay que moverlo a `/health/live` **antes**
 * de desplegar esto, o una caída de Postgres pasa de "503 en rotación" a
 * "reinicio de todas las réplicas". Hoy en el repo no hay ningún manifiesto que
 * lo haga (sólo `docker-compose.yml`, y ahí los healthchecks son de Postgres y
 * MinIO, no de la API), así que el cambio es seguro; el día que lo haya, esto es
 * lo que hay que leer.
 *
 * ## Las tres dependencias, y por qué las tres cuentan
 *
 * Las tres se sondean y las tres salen en el cuerpo. Lo que **no** es igual es
 * qué código HTTP produce cada una, y ésa es la decisión que más costó:
 *
 * | Estado | HTTP | Cuándo |
 * |---|---|---|
 * | `ok` | 200 | las tres arriba |
 * | `degraded` | **200** | storage o cola abajo |
 * | `unavailable` | **503** | Postgres abajo |
 *
 * El criterio es uno solo: **un readiness que falla tiene que mejorar las
 * cosas, no empeorarlas.** Sacar una réplica de rotación sólo ayuda si esa
 * réplica no puede hacer nada útil.
 *
 *  - **Postgres** gobierna las ~30 rutas de `/api/v1`: sin base, la réplica
 *    devuelve error a todo. Sacarla no pierde nada y puede ganar mucho —si el
 *    fallo es de esta réplica y no de la base (una revisión nueva con la URL
 *    mal, una partición de red), el balanceador manda el tráfico a las sanas y
 *    el rollout se salva. Por eso es la única **requerida**.
 *  - **Storage** afecta a cinco rutas de treinta, y **la cola** a cuatro. Si se
 *    caen, se caen para **todas** las réplicas a la vez, así que un 503 en
 *    todas convierte *"las rutas de media fallan"* en *"la API no existe"*: un
 *    fallo parcial ascendido a total por el propio health check. Por eso bajan
 *    el `status` a `degraded` y lo dicen en `checks`, pero **no** sacan la
 *    réplica de rotación.
 *
 * O sea: **readiness es para el balanceador; el cuerpo y el log son para la
 * alerta.** Confundir las dos es lo que hace que un health check tire un
 * servicio que estaba a medias funcionando. Quien quiera alertar sobre el
 * storage lee `checks.storage`, que para eso está.
 *
 * Esto no es teórico y tiene un caso en este repo: el job `binario` de
 * `.github/workflows/ci.yml` corre **a propósito sin MinIO** —tiene las
 * variables de S3 puestas y nada escuchando en el puerto— porque el smoke sólo
 * hace `POST /content`, que no toca el storage. Con un readiness que se cayera
 * por el storage, ese job quedaría esperando un `/health` que nunca da 200, y el
 * health check estaría diciendo *"no listo"* de un proceso que sirve
 * perfectamente lo que le van a pedir.
 *
 * **Si alguna vez se quiere lo contrario** —que storage o cola también saquen de
 * rotación— el cambio es agregarlas a {@link REQUIRED_DEPENDENCIES}, y lo que
 * hay que configurar del otro lado es el fail-open del balanceador para cuando
 * **ningún** backend esté sano (el panic threshold de Envoy, el fail-open de un
 * ALB). Sin eso, la primera caída de R2 apaga la API entera.
 *
 * ## Por qué hay cache, y por qué 3 segundos
 *
 * Una sonda es un vector de amplificación: el orquestador sondea **por réplica**
 * y a intervalo fijo, así que el tráfico contra las dependencias crece con la
 * flota × la frecuencia, no con el tráfico real. Con 20 réplicas sondeadas cada
 * segundo son 20 transacciones/s contra Postgres y 20 `HeadObject`/s contra R2
 * —que además se facturan— sin que ningún usuario haya pedido nada. Y es peor en
 * el momento exacto en que la dependencia está sufriendo: ahí cada sonda que no
 * se amortigua es carga extra sobre lo que ya se está cayendo.
 *
 * **3 segundos**, y el número no es redondeo:
 *
 *  1. Está **por debajo** del `periodSeconds` habitual de una readinessProbe
 *     (5 s, y 10 s por defecto en Kubernetes). O sea que en la configuración
 *     normal la entrada ya venció cuando llega la sonda siguiente: el cache no
 *     esconde ninguna transición, sólo colapsa las ráfagas —varias sondas, el
 *     chequeo del balanceador y un `curl` humano cayendo en la misma ventana.
 *  2. Con una sonda agresiva de 1 s, divide por 3 la carga contra las
 *     dependencias sin que el operador tenga que tocar nada.
 *  3. El retraso que puede introducir (≤ 3 s de "up" viejo) es muy menor al
 *     tiempo que el orquestador necesita igual para actuar:
 *     `failureThreshold × periodSeconds` son ≥ 10 s en cualquier configuración
 *     sensata. No puede retrasar de forma apreciable sacar una réplica.
 *
 * El fallo se cachea **igual que el éxito**, y a propósito: la estampida importa
 * sobre todo cuando la dependencia ya está mal. Un cache que sólo guardara los
 * éxitos dejaría a la base caída recibiendo una tormenta de reconexiones.
 *
 * Además del TTL hay **single-flight**: mientras un chequeo está en vuelo, las
 * peticiones que llegan comparten esa misma promesa en vez de arrancar otro. Sin
 * eso, 50 sondas concurrentes al arrancar (o cuando el TTL vence de golpe en
 * todas) son 50 `HeadObject` simultáneos.
 *
 * **La trampa del `FixedClock`.** El TTL se mide con el `Clock` inyectado, como
 * todo lo demás del repo. Con el `FixedClock` de los tests el tiempo no avanza,
 * así que una entrada cacheada **no vence nunca** y dos llamadas seguidas
 * devuelven lo mismo aunque la dependencia haya cambiado en el medio. Es la
 * misma trampa que ya documenta el arnés para `TokenBucketLimiter`. Por eso
 * `ttlMs: 0` desactiva el cache, y es lo que usa cualquier test que quiera ver
 * una dependencia caerse.
 *
 * ## Qué sale en el cuerpo (y qué no)
 *
 * Un health check es **público**: no lleva auth y está fuera de `/api/v1`. Así
 * que el cuerpo es `status`, `service` y un `"up"`/`"down"` por dependencia, y
 * **nada más**. Ni cadenas de conexión, ni hostnames, ni el bucket, ni versiones,
 * ni el mensaje de Postgres —que dice el host, el puerto, la base y a veces el
 * usuario—. El error se loguea, que es donde sí sirve; al cable no cruza. Es la
 * misma regla que `plugins/error-handler.ts` hace cumplir para el resto de la
 * API, y `health.test.ts` la verifica sobre el cuerpo serializado.
 */
import { withoutCompany } from "@fastgram/db";
import type { Clock } from "@fastgram/ports";

import type { ApiDeps } from "./types.js";

/** Ver el bloque *"Por qué hay cache"*. `0` lo desactiva. */
export const HEALTH_CACHE_TTL_MS = 3_000;

/**
 * Tope por sonda.
 *
 * Sin esto, un Postgres que acepta el TCP y no contesta —un failover a medias,
 * una tabla de conexiones llena— deja la petición de `/health` colgada para
 * siempre. Y una sonda colgada es **peor** que un 503: el orquestador la ve como
 * timeout, no como respuesta, y en una livenessProbe eso es un reinicio.
 *
 * Las tres sondas corren en paralelo, así que el techo del chequeo completo es
 * este número y no su triple. Va por encima del `timeoutSeconds: 1` que
 * Kubernetes usa por defecto a propósito: preferimos que el 503 llegue con su
 * cuerpo —que dice *cuál* dependencia está mal— a cortar antes y no saber nada.
 * Quien despliegue esto debería poner `timeoutSeconds: 3`.
 */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

/**
 * Clave de la sonda de storage.
 *
 * No existe y no se escribe: lo que se comprueba es que el `HEAD` llegue y el
 * proveedor conteste *"no está"*, que es lo que prueba que el endpoint responde
 * y que las credenciales sirven. El prefijo `__probe__/` es el mismo que ya usa
 * `support/storage.ts`, para que quien la vea en un log del bucket sepa qué es.
 *
 * **Caveat de S3 real:** un `HeadObject` sobre una clave inexistente devuelve
 * `403` en vez de `404` cuando el principal no tiene `s3:ListBucket`. El
 * adaptador traduce ese `403` a `unauthorized` y lanza, así que la sonda diría
 * `down` con el bucket perfectamente sano. R2 y MinIO —los dos proveedores que
 * usa este proyecto— devuelven `404`, y por eso la sonda es correcta hoy; con un
 * S3 de AWS y una policy sin `ListBucket`, no.
 */
export const STORAGE_PROBE_KEY = "__probe__/health";

/** Tabla de pg-boss que se busca para saber si la cola está alcanzable. */
const QUEUE_PROBE_TABLE = "job";

/**
 * Identificador SQL simple. Mismo criterio que `packages/db/src/tenancy.ts`.
 *
 * `QUEUE_SCHEMA` sale del entorno y termina dentro de un literal de la consulta
 * de la sonda, porque sin el tag `sql` de drizzle —que `apps/api` no puede
 * importar— no hay forma de parametrizarlo. El regex no deja pasar comillas ni
 * espacios, así que el literal no se puede romper; y se valida al **construir**
 * la sonda, o sea al arrancar, para que un valor raro mate el proceso con un
 * mensaje claro en vez de producir una sonda que miente.
 */
const SQL_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export const DEPENDENCIES = ["database", "storage", "queue"] as const;
export type Dependency = (typeof DEPENDENCIES)[number];

/**
 * Las que, al caerse, sacan a la réplica de rotación (503). Ver la tabla de la
 * cabecera: sólo Postgres, porque es la única sin la cual la réplica no puede
 * servir **nada**.
 */
export const REQUIRED_DEPENDENCIES: readonly Dependency[] = ["database"];

export type Availability = "up" | "down";

export interface HealthReport {
  /**
   * `ok` = las tres arriba (200).
   * `degraded` = storage o cola abajo; la mayor parte de la API funciona (200).
   * `unavailable` = Postgres abajo; no funciona nada (503).
   */
  readonly status: "ok" | "degraded" | "unavailable";
  readonly service: "api";
  readonly checks: Readonly<Record<Dependency, Availability>>;
}

/**
 * Una sonda: resuelve si la dependencia está sana, lanza si no.
 *
 * Devuelve `void` y no un booleano a propósito — así el modo natural de fallar
 * (que la llamada al proveedor lance) es también el modo correcto, y no hace
 * falta acordarse de traducir.
 */
export type Probe = () => Promise<void>;
export type Probes = Readonly<Record<Dependency, Probe>>;

export interface HealthCheckerOptions {
  readonly probes: Probes;
  readonly clock: Clock;
  /** Default {@link HEALTH_CACHE_TTL_MS}. `0` desactiva el cache. */
  readonly ttlMs?: number;
  /** Default {@link HEALTH_PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Adónde va el motivo real del fallo. Nunca al cuerpo de la respuesta. */
  readonly onProbeFailure?: (dependency: Dependency, error: unknown) => void;
}

export interface HealthChecker {
  /** El estado de las dependencias, cacheado según el TTL. */
  check(): Promise<HealthReport>;
}

/** La respuesta de liveness. No toca ninguna dependencia: ver la cabecera. */
export function livenessReport(): { status: "ok"; service: "api" } {
  return { status: "ok", service: "api" };
}

/**
 * `503` **sólo** con una dependencia requerida abajo. Ver la tabla de la
 * cabecera: `degraded` es 200 a propósito.
 */
export function statusCodeFor(report: HealthReport): number {
  return report.status === "unavailable" ? 503 : 200;
}

export function createHealthChecker(options: HealthCheckerOptions): HealthChecker {
  const ttlMs = options.ttlMs ?? HEALTH_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;

  let cached: { at: number; report: HealthReport } | null = null;
  let inFlight: Promise<HealthReport> | null = null;

  async function run(): Promise<HealthReport> {
    const results = await Promise.all(
      DEPENDENCIES.map(async (dependency): Promise<[Dependency, Availability]> => {
        try {
          await withTimeout(options.probes[dependency](), timeoutMs, dependency);
          return [dependency, "up"];
        } catch (error: unknown) {
          options.onProbeFailure?.(dependency, error);
          return [dependency, "down"];
        }
      }),
    );

    const checks = Object.fromEntries(results) as Record<Dependency, Availability>;
    return { status: statusFrom(checks), service: "api", checks };
  }

  return {
    async check(): Promise<HealthReport> {
      const now = options.clock.nowMs();
      if (ttlMs > 0 && cached !== null && now - cached.at < ttlMs) {
        return cached.report;
      }
      // Single-flight: el segundo que llega mientras el primero corre no arranca
      // otro chequeo, espera el mismo.
      if (inFlight !== null) return inFlight;

      inFlight = run()
        .then((report) => {
          // La marca de tiempo es la de **antes** de sondear: cachear con la de
          // después alargaría la ventana justo cuando las sondas tardan, que es
          // cuando menos conviene servir un estado viejo.
          cached = { at: now, report };
          return report;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

/** Traduce el mapa de dependencias al estado. Ver la tabla de la cabecera. */
export function statusFrom(
  checks: Readonly<Record<Dependency, Availability>>,
): HealthReport["status"] {
  if (REQUIRED_DEPENDENCIES.some((d) => checks[d] === "down")) return "unavailable";
  if (DEPENDENCIES.some((d) => checks[d] === "down")) return "degraded";
  return "ok";
}

/**
 * Las tres sondas, a partir de las dependencias ya construidas.
 *
 * Es una función y no tres constantes porque las tres necesitan `deps`, y
 * dejarlas armadas en `app.ts` obligaría a levantar Fastify para testearlas.
 */
export function probesFor(deps: ApiDeps): Probes {
  const role =
    deps.appRole === undefined || deps.appRole === "" ? {} : { role: deps.appRole };
  const queueSchema = deps.queueSchema;
  if (queueSchema !== undefined && !SQL_IDENT_RE.test(queueSchema)) {
    throw new Error(
      `QUEUE_SCHEMA inválido: ${JSON.stringify(queueSchema)}. ` +
        "La sonda de la cola lo interpola en la consulta y sólo acepta " +
        "identificadores [a-z_][a-z0-9_]*.",
    );
  }

  return {
    /**
     * Postgres, **por el mismo camino que una petición**.
     *
     * No es un `select 1` pelado: va dentro de `withoutCompany` con el mismo
     * `SET LOCAL ROLE` que hace `runScoped` en cada request. Cuesta un par de
     * idas más y a cambio cubre un fallo que un `select 1` no ve — que el rol de
     * la conexión no pueda asumir `fastgram_app`, que hace fallar **todas** las
     * rutas de `/api/v1` con el proceso arrancado y la base perfecta.
     */
    database: async () => {
      await withoutCompany(
        deps.db,
        async (tx) => {
          await tx.execute("select 1");
        },
        role,
      );
    },

    /** Ver {@link STORAGE_PROBE_KEY}: `null` es la respuesta sana. */
    storage: async () => {
      await deps.storage.head(STORAGE_PROBE_KEY);
    },

    /**
     * La cola.
     *
     * Dos niveles, porque el puerto `Queue` **no tiene** un método de salud y
     * `packages/ports` no es de esta tarea:
     *
     *  1. Sin `deps.queue` montada, las rutas que encolan responden `503`. Eso
     *     es `down` y no hay más que preguntar.
     *  2. Con `queueSchema`, se comprueba que las tablas de pg-boss sean
     *     **visibles para el rol de la aplicación**. `information_schema.tables`
     *     sólo lista lo que el rol actual tiene algún privilegio de tocar, así
     *     que dentro del `SET LOCAL ROLE` la consulta responde a la vez "el
     *     esquema existe" y "el rol puede usarlo" — que es exactamente el fallo
     *     que `queue-grants.ts` describe y que hoy no se ve hasta la primera
     *     petición que encola.
     *
     * Sin `queueSchema` se queda en el nivel 1 y lo dice el docstring, en vez de
     * fingir un chequeo que no hizo.
     */
    queue: async () => {
      if (deps.queue === undefined) {
        throw new Error("queue not mounted");
      }
      if (queueSchema === undefined) return;
      await withoutCompany(
        deps.db,
        async (tx) => {
          const rows = await tx.execute(
            "select 1 from information_schema.tables " +
              `where table_schema = '${queueSchema}' ` +
              `and table_name = '${QUEUE_PROBE_TABLE}' limit 1`,
          );
          if (rows.length === 0) {
            throw new Error("queue schema not reachable");
          }
        },
        role,
      );
    },
  };
}

/**
 * Corta una sonda que no vuelve. Ver {@link HEALTH_PROBE_TIMEOUT_MS}.
 *
 * `unref()` en el timer: sin eso, un timeout pendiente mantiene vivo el event
 * loop y un proceso que se está apagando —o una suite de tests— se queda colgado
 * esperando a un `setTimeout` que ya no le importa a nadie.
 */
async function withTimeout(
  work: Promise<void>,
  ms: number,
  dependency: Dependency,
): Promise<void> {
  if (ms <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`health probe "${dependency}" timed out`));
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
