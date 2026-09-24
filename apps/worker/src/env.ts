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
 *   (`RENDER_SERVICE_URL` y `RENDER_MEDIA_GRANT_SECRET`). Las dos =
 *   `content-build`, `content-rebuild` y `media-normalization` van contra
 *   `services/render`. Ninguna = los builds usan el renderer de memoria
 *   (artefactos sintéticos), `media-normalization` no se monta, y el arranque
 *   lo dice. Una sola = el proceso no levanta. Ver {@link renderServiceFromEnv}
 *   y `media/render-service.ts`.
 */
import {
  baseEnvSchema,
  defineEnv,
  postgresEnvSchema,
  storageEnvSchema,
  z,
} from "@fastgram/config/env";
import { APP_ROLE } from "@fastgram/db";
import { LINK_IN_BIO_MAX_DESTINATIONS } from "@fastgram/ports";

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
const LLM_VARS = [
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_CONTEXT_WINDOW_TOKENS",
] as const;
const WEBSITE_READER_VARS = [
  "BRAND_WEBSITE_TIMEOUT_MS",
  "BRAND_WEBSITE_MAX_BODY_BYTES",
  "BRAND_WEBSITE_MAX_REDIRECTS",
  "BRAND_WEBSITE_MAX_SECONDARY_PAGES",
  "BRAND_WEBSITE_MAX_TEXT_CHARS",
  "BRAND_WEBSITE_USER_AGENT",
  "BRAND_WEBSITE_ALLOWED_PORTS",
] as const;

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

    /*
     * ── `brand-source-analysis` ──────────────────────────────────────────
     *
     * Tres grupos, y el handler se monta sólo con **los tres**: sin extractor
     * no hay qué leer, sin LLM no hay síntesis, y sin retención cada snapshot
     * guardaría material de terceros sin fecha de purga (`DATA-032`). Ver
     * {@link brandAnalysisFromEnv}. Ninguno tiene default numérico: el PRD no
     * da ninguno de estos números, y ADR-009 prohíbe fijar el modelo.
     */

    /**
     * Directorio de FastGram (`PU-MODEL-001`): ahí vive `models.json`, el
     * registro de modelos que escribe la pantalla Settings → Models. Default
     * `~/.fastgram`. Tiene que ser el mismo que el de la API, o el worker lee
     * un registro que nadie escribe.
     */
    FASTGRAM_HOME: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),

    /**
     * ADR-009. Las cuatro juntas o ninguna. Desde `PU-MODEL-001` son el
     * **fallback**: si el registro de modelos tiene la tarea completa, gana el
     * registro (ver `llm/registry-llm.ts`).
     */
    LLM_BASE_URL: z.preprocess(
      unsetIfEmpty,
      z
        .string()
        .url()
        .refine((v) => /^https?:\/\//.test(v), "tiene que ser http:// o https://")
        .optional(),
    ),
    LLM_API_KEY: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
    LLM_MODEL: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
    /**
     * Ventana del modelo de `LLM_MODEL`, en tokens. El adaptador la exige
     * (rechaza como `bad_request` un prompt que no entra) y es una propiedad
     * del modelo, así que cambia con él: sale de la ficha del gateway.
     */
    LLM_CONTEXT_WINDOW_TOKENS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().positive().optional(),
    ),

    /** `WebsiteReader` (`P1-BRAND-006`). Las siete juntas o ninguna. */
    BRAND_WEBSITE_TIMEOUT_MS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().positive().optional(),
    ),
    BRAND_WEBSITE_MAX_BODY_BYTES: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().positive().optional(),
    ),
    BRAND_WEBSITE_MAX_REDIRECTS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(0).optional(),
    ),
    /** §9.14: 1 nivel, **máximo 5** destinos. El techo es del PRD; el valor, no. */
    BRAND_WEBSITE_MAX_SECONDARY_PAGES: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(0).max(LINK_IN_BIO_MAX_DESTINATIONS).optional(),
    ),
    BRAND_WEBSITE_MAX_TEXT_CHARS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().positive().optional(),
    ),
    /** Identificación del bot. La elige quien opera, no el código. */
    BRAND_WEBSITE_USER_AGENT: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
    /** Lista separada por comas, p. ej. `80,443`. Sin lista, sería un escáner de puertos. */
    BRAND_WEBSITE_ALLOWED_PORTS: z.preprocess(
      unsetIfEmpty,
      z
        .string()
        .transform((v, ctx) => {
          const ports = v.split(",").map((p) => p.trim());
          const parsed = ports.map(Number);
          if (
            ports.some((p) => p === "") ||
            parsed.some((p) => !Number.isInteger(p) || p < 1 || p > 65_535)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "lista de puertos separados por comas, cada uno en [1, 65535]",
            });
            return z.NEVER;
          }
          return parsed;
        })
        .optional(),
    ),
    /**
     * «Hosts bloqueados» de `NFR-017`. **El PRD no dice cuáles**, así que vacío
     * es un valor válido: la guarda de IPs privadas/localhost corre igual.
     */
    BRAND_WEBSITE_BLOCKED_HOSTS: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((h) => h.trim())
          .filter((h) => h.length > 0),
      ),

    /**
     * `DATA-032.rawRetentionExpiresAt`, en días. **El PRD no da la duración**:
     * la ata a la revisión legal de `OQ-16`. Sin ella el análisis no se monta.
     */
    BRAND_SNAPSHOT_RAW_RETENTION_DAYS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().positive().optional(),
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
  allOrNone(env, ctx, RENDER_VARS, "el servicio de render", "media-normalization");
  allOrNone(
    env,
    ctx,
    LLM_VARS,
    "el LLM",
    "brand-source-analysis, y discovery-refill no encola",
  );
  allOrNone(
    env,
    ctx,
    WEBSITE_READER_VARS,
    "el extractor de web",
    "brand-source-analysis",
  );
});

/**
 * Un grupo de variables que va entero o no va. La mitad configurada es el
 * peor estado, porque **parece andar**: el arranque no dice nada y la cola
 * queda sin montar, o montada contra algo que falla en cada job.
 */
function allOrNone(
  env: z.infer<typeof workerEnvObject>,
  ctx: z.RefinementCtx,
  group: readonly (keyof z.infer<typeof workerEnvObject>)[],
  what: string,
  queue: string,
): void {
  const present = group.filter((name) => env[name] !== undefined);
  if (present.length === 0 || present.length === group.length) return;
  for (const name of group) {
    if (env[name] !== undefined) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [name],
      message:
        `falta, y ${present.join(", ")} sí está: ${what} se ` +
        `configura con ${group.join(" + ")} juntas, o sin ninguna ` +
        `(la cola ${queue} no se monta)`,
    });
  }
}

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

/** Lo que hace falta para `OpenAiCompatibleLlm` (ADR-009). */
export interface LlmConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly contextWindowTokens: number;
}

/**
 * El LLM solo, o `null` — lo usa `discovery-refill` para la copy de `AI-002`,
 * que a diferencia de `brand-source-analysis` no necesita extractor ni
 * retención. El «todas o ninguna» de las cuatro variables ya lo cortó el
 * esquema.
 */
export function llmFromEnv(env: WorkerEnv): LlmConfig | null {
  if (
    env.LLM_BASE_URL === undefined ||
    env.LLM_API_KEY === undefined ||
    env.LLM_MODEL === undefined ||
    env.LLM_CONTEXT_WINDOW_TOKENS === undefined
  ) {
    return null;
  }
  return {
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    contextWindowTokens: env.LLM_CONTEXT_WINDOW_TOKENS,
  };
}

/** `WebsiteReaderConfig` sin `source`: se monta una vez por `website` y otra por `other_url`. */
export interface WebsiteReaderSettings {
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly maxRedirects: number;
  readonly maxSecondaryPages: number;
  readonly maxTextChars: number;
  readonly userAgent: string;
  readonly allowedPorts: readonly number[];
  readonly blockedHosts: readonly string[];
}

/**
 * Lo de `brand-source-analysis` **que no es el LLM**: extractor y retención.
 * Desde `PU-MODEL-001` el LLM puede venir del registro de modelos y aparecer
 * con el worker ya arriba, así que `main.ts` los mira por separado.
 */
export type BrandReaderConfig =
  | {
      readonly kind: "configured";
      readonly website: WebsiteReaderSettings;
      readonly rawRetentionDays: number;
    }
  | { readonly kind: "missing"; readonly missing: readonly string[] };

export function brandReaderFromEnv(env: WorkerEnv): BrandReaderConfig {
  const missing: string[] = [];
  const website =
    env.BRAND_WEBSITE_TIMEOUT_MS !== undefined &&
    env.BRAND_WEBSITE_MAX_BODY_BYTES !== undefined &&
    env.BRAND_WEBSITE_MAX_REDIRECTS !== undefined &&
    env.BRAND_WEBSITE_MAX_SECONDARY_PAGES !== undefined &&
    env.BRAND_WEBSITE_MAX_TEXT_CHARS !== undefined &&
    env.BRAND_WEBSITE_USER_AGENT !== undefined &&
    env.BRAND_WEBSITE_ALLOWED_PORTS !== undefined
      ? {
          timeoutMs: env.BRAND_WEBSITE_TIMEOUT_MS,
          maxBodyBytes: env.BRAND_WEBSITE_MAX_BODY_BYTES,
          maxRedirects: env.BRAND_WEBSITE_MAX_REDIRECTS,
          maxSecondaryPages: env.BRAND_WEBSITE_MAX_SECONDARY_PAGES,
          maxTextChars: env.BRAND_WEBSITE_MAX_TEXT_CHARS,
          userAgent: env.BRAND_WEBSITE_USER_AGENT,
          allowedPorts: env.BRAND_WEBSITE_ALLOWED_PORTS,
          blockedHosts: env.BRAND_WEBSITE_BLOCKED_HOSTS,
        }
      : null;
  if (website === null) missing.push(WEBSITE_READER_VARS.join(" + "));

  const rawRetentionDays = env.BRAND_SNAPSHOT_RAW_RETENTION_DAYS;
  if (rawRetentionDays === undefined) missing.push("BRAND_SNAPSHOT_RAW_RETENTION_DAYS");

  if (website === null || rawRetentionDays === undefined) {
    return { kind: "missing", missing };
  }
  return { kind: "configured", website, rawRetentionDays };
}

export type BrandAnalysisConfig =
  | {
      readonly kind: "configured";
      readonly llm: LlmConfig;
      readonly website: WebsiteReaderSettings;
      readonly rawRetentionDays: number;
    }
  | { readonly kind: "missing"; readonly missing: readonly string[] };

/**
 * Los tres grupos que el handler necesita, o **cuáles faltan**, para que el
 * arranque lo diga con nombres de variable. El «todas o ninguna» de cada grupo
 * ya lo cortó el esquema.
 */
export function brandAnalysisFromEnv(env: WorkerEnv): BrandAnalysisConfig {
  const missing: string[] = [];
  const llm = llmFromEnv(env);
  if (llm === null) missing.push(LLM_VARS.join(" + "));
  const reader = brandReaderFromEnv(env);
  if (reader.kind === "missing") missing.push(...reader.missing);
  if (llm === null || reader.kind === "missing") return { kind: "missing", missing };
  return {
    kind: "configured",
    llm,
    website: reader.website,
    rawRetentionDays: reader.rawRetentionDays,
  };
}
