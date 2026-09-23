/**
 * Entorno de `@fastgram/worker` — P1-QUEUE-008.
 *
 * Mismo criterio que `apps/api/src/env.ts`: si falta una variable el proceso
 * **no levanta** (P0-REPO-009). Lo que cambia es qué hace falta, y las
 * diferencias no son cosméticas:
 *
 * - **No hay puerto HTTP.** El worker no escucha nada.
 * - **`QUEUE_MIGRATE` no existe acá**, y es deliberado: quien crea el esquema
 *   de la cola es la API, con su propia bandera. Dos procesos corriendo el
 *   mismo DDL al arrancar compiten por los mismos objetos, y el worker es el
 *   que suele tener más réplicas.
 * - **`WORKER_CONCURRENCY`** sí, porque `NFR-025` dice que el render cuellea
 *   por CPU y el número de builds simultáneos es la perilla que lo controla.
 * - **Las cinco `S3_*` son obligatorias**, igual que en la API y por la misma
 *   razón: un storage que cae a memoria cuando falta una variable responde
 *   `409` para siempre sin decir nada. Morir al arrancar nombrando
 *   `S3_ENDPOINT` cuesta un minuto; el otro camino cuesta una tarde y una
 *   llamada de un cliente.
 * - **Las dos del servicio de render van juntas o no van**
 *   (`RENDER_SERVICE_URL` y `RENDER_MEDIA_GRANT_SECRET`). Ninguna = la cola
 *   `media-normalization` no se monta y el arranque lo dice. Una sola = el
 *   proceso no levanta. Ver {@link renderServiceFromEnv}.
 */
import {
  baseEnvSchema,
  defineEnv,
  postgresEnvSchema,
  storageEnvSchema,
  z,
} from "@fastgram/config/env";
import { APP_ROLE } from "@fastgram/db";

/**
 * `X=` en un `.env` llega como `""`, no como ausente. Para estas dos variables
 * vacío **es** «no configurado»: el `.env.example` las trae así, y tratar `""`
 * como un valor inválido haría que copiarlo tal cual tire abajo el worker por
 * una cola que nadie pidió.
 */
const unsetIfEmpty = (value: unknown): unknown => (value === "" ? undefined : value);

/** Mismo mínimo que `services/render/src/config.ts`: un secreto que el servicio
 * rechazaría al arrancar no tiene por qué pasar acá. */
const GRANT_SECRET_MIN_LENGTH = 32;

const RENDER_VARS = ["RENDER_SERVICE_URL", "RENDER_MEDIA_GRANT_SECRET"] as const;

const workerEnvObject = baseEnvSchema
  .merge(postgresEnvSchema)
  .merge(storageEnvSchema)
  .extend({
    /** Ver la nota larga en `apps/api/src/env.ts`: sin esto RLS no existe. */
    DATABASE_APP_ROLE: z.string().default(APP_ROLE),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    /** Debe coincidir con el de la API o el worker escucha una cola vacía. */
    QUEUE_SCHEMA: z.string().min(1).default("pgboss"),

    /**
     * Builds simultáneos en este proceso.
     *
     * Default 1 y no un número mayor: un build es CPU pura del lado del motor de
     * render (`ADR-007`), y el tope que importa es el de ese servicio, no el de
     * cuántos jobs saque el worker de la cola. Subirlo acá sin subirlo allá sólo
     * mueve la cola de un lado al otro.
     */
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),

    /**
     * Puerto de la sonda de salud.
     *
     * **`0` la apaga**, y el default es `0` a propósito: el worker no servía
     * ningún puerto hasta ahora, y abrir uno donde nadie lo espera cambia el
     * despliegue —firewalls, `EADDRINUSE` con varios workers en la misma
     * máquina— sin que nadie lo haya pedido. Quien la quiera, la enciende.
     */
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(0),

    /**
     * MinIO lo exige y el endpoint de cuenta de R2 también lleva el bucket en la
     * ruta; el único caso que quiere `false` es AWS S3 con el bucket en el host,
     * que `ADR-006` no elige. Default escrito, no adivinado por el adaptador.
     */
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),

    /**
     * Base de `services/render` (p. ej. `http://render:3002`), del lado cliente.
     *
     * **Sin default, a propósito.** Hoy la usa una sola cola,
     * `media-normalization`, con su propia instancia de `HttpMediaRenderer`
     * (`content-build` sigue en memoria, ver `main.ts`). Un default a
     * `localhost` montaría esa cola en cualquier despliegue que no la pidió, y
     * cada video terminaría en reintentos contra un puerto cerrado.
     */
    RENDER_SERVICE_URL: z.preprocess(
      unsetIfEmpty,
      z
        .string()
        .url()
        .refine((v) => /^https?:\/\//.test(v), "tiene que ser http:// o https://")
        .optional(),
    ),

    /**
     * El secreto HMAC del grant de media (`NFR-006`). **Es la MISMA variable que
     * lee `services/render`** y tiene que tener el mismo valor: el worker firma,
     * el servicio verifica. Con valores distintos cada pedido da
     * `media_grant_invalid`.
     */
    RENDER_MEDIA_GRANT_SECRET: z.preprocess(
      unsetIfEmpty,
      z
        .string()
        .min(
          GRANT_SECRET_MIN_LENGTH,
          `mínimo ${GRANT_SECRET_MIN_LENGTH} caracteres, igual que en services/render`,
        )
        .optional(),
    ),
  });

/**
 * Todas o ninguna.
 *
 * Una mitad configurada es el peor estado posible, porque **parece andar**: con
 * URL y sin secreto el worker mandaría pedidos sin grant, el servicio (con
 * `RENDER_REQUIRE_GRANT=true`, su default) rechazaría
 * cada pedido y cada video terminaría `failed` después de tres intentos. Con
 * secreto y sin URL, la cola no se montaría y nadie sabría que alguien quiso
 * montarla. Las dos cosas se ven recién mirando la base; morir acá nombrando la
 * variable que falta se ve en el primer segundo.
 *
 * Un servicio que sólo aplica prefijos globales (`RENDER_REQUIRE_GRANT=false`)
 * es una topología que el adaptador admite, y **este worker no la acepta**: sin
 * grant no hay aislamiento por workspace. Si hiciera falta en desarrollo, es una
 * bandera explícita, no la ausencia de una variable.
 */
export const workerEnvSchema = workerEnvObject.superRefine((env, ctx) => {
  const present = RENDER_VARS.filter((name) => env[name] !== undefined);
  if (present.length === 0 || present.length === RENDER_VARS.length) return;
  for (const name of RENDER_VARS) {
    if (env[name] !== undefined) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [name],
      message:
        `falta, y ${present.join(", ")} sí está: el servicio de render se ` +
        `configura con ${RENDER_VARS.join(" + ")} juntas, o sin ninguna ` +
        "(la cola media-normalization no se monta)",
    });
  }
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Lo que hace falta para hablar con `services/render`. */
export interface RenderServiceConfig {
  readonly baseUrl: string;
  readonly grantSecret: string;
}

/**
 * `null` = no configurado. El «todas o ninguna» ya lo garantizó el esquema, así
 * que acá una sola presente no puede llegar; si llegara (alguien armó un
 * `WorkerEnv` a mano), se trata como no configurado en vez de a medias.
 */
export function renderServiceFromEnv(env: WorkerEnv): RenderServiceConfig | null {
  if (
    env.RENDER_SERVICE_URL === undefined ||
    env.RENDER_MEDIA_GRANT_SECRET === undefined
  ) {
    return null;
  }
  return { baseUrl: env.RENDER_SERVICE_URL, grantSecret: env.RENDER_MEDIA_GRANT_SECRET };
}

export function loadWorkerEnv(
  source: Record<string, string | undefined> = process.env,
): WorkerEnv {
  return defineEnv("@fastgram/worker", workerEnvSchema, source);
}
