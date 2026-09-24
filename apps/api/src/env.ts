/**
 * Entorno de `@fastgram/api` — P1-API-001.
 *
 * Si falta una variable, el proceso **no levanta** (P0-REPO-009). La razón está
 * escrita en `@fastgram/config`: un proceso que arranca a medias falla tres horas
 * después, en la única ruta que usa la variable, y para entonces el stack trace ya
 * no apunta a la causa.
 *
 * Lo que se valida acá es lo que la API necesita para **servir**. Las credenciales
 * de proveedores (LLM, render, social) no están: sus adaptadores todavía no se
 * montan y exigirlas rompería el arranque por algo que nadie usa. Las de S3 **sí**
 * están desde `P1-STORAGE-007`, porque desde ahí su adaptador se monta y tres
 * endpoints de §9.8 dependen de él; la razón larga está sobre el `.merge`.
 */
import {
  baseEnvSchema,
  defineEnv,
  postgresEnvSchema,
  storageEnvSchema,
  z,
} from "@fastgram/config/env";
import { APP_ROLE } from "@fastgram/db";

export const apiEnvSchema = baseEnvSchema
  .merge(postgresEnvSchema)
  /**
   * **Las credenciales de S3 son obligatorias desde `P1-STORAGE-007`**, y la
   * decisión tiene costo: un entorno sin ellas deja de arrancar.
   *
   * La alternativa —dejarlas opcionales y caer a `MemoryStorage`— es
   * exactamente el bug que esta tarea cierra, no una comodidad. Con
   * `MemoryStorage` montado la API responde `200` a la reserva, devuelve una
   * `uploadUrl` sintética, el PUT del cliente se pierde y la finalización
   * contesta **`409` para siempre**: el Media Bank entero no funciona y
   * *nada* en los logs lo dice. Un arranque que muere nombrando
   * `S3_ENDPOINT` cuesta un minuto; un `409` permanente costó dos tandas de
   * no saber por qué.
   *
   * Por eso no hay `STORAGE_DRIVER=memory` ni un fallback: un interruptor
   * para apagar el storage es un interruptor que alguien va a dejar apagado
   * en producción, y el síntoma vuelve a ser silencioso.
   *
   * Lo que esto rompe, y hay que arreglar **fuera de `apps/api`**:
   *   · el job `binario` de `.github/workflows/ci.yml` no define ninguna
   *     `S3_*` — `pnpm smoke:binary` va a morir al arrancar la API. No
   *     necesita un MinIO: el cliente de S3 no abre ninguna conexión al
   *     construirse ni al firmar, así que alcanza con las cinco variables.
   *   · `scripts/smoke-binary.mjs` hereda `process.env`, así que en local
   *     funciona con el `.env` exportado y en CI no.
   * El job `integration` ya las tiene, y `.env.example` ya las trae completas
   * para el `docker compose` de desarrollo.
   */
  .merge(storageEnvSchema)
  .extend({
    API_PORT: z.coerce.number().int().positive().default(3001),

    /**
     * Dirección donde escucha. **Sin default en el schema a propósito**: el default
     * depende del modo y lo resuelve {@link resolveListenHost}. `0.0.0.0` en
     * `standard` (un contenedor detrás de un balanceador) y `127.0.0.1` en
     * `personal`, donde la API no tiene cuotas ni rate limit y escucharla desde la
     * red del café es regalarle la cuenta a cualquiera con la key.
     */
    API_HOST: z.string().min(1).optional(),

    /**
     * `PU-RUN-002` · `D-06`. `personal` = un solo usuario: sin rate limiting, sin
     * cuotas ni gates de plan, bind a loopback por defecto y multimarca por el
     * header `X-Fastgram-Workspace`. Default `standard` para que nada de lo que
     * ya existe —tests incluidos— cambie de comportamiento sin pedirlo.
     */
    FASTGRAM_MODE: z.enum(["personal", "standard"]).default("standard"),

    /**
     * Orígenes permitidos por CORS, separados por coma.
     *
     * La API v1 es server-to-server (§9.3) y no necesita CORS; quien lo necesita es
     * `apps/web`. Por eso el default es la nada: un `*` por comodidad convertiría
     * cada API key filtrada en el browser en un problema de cualquier origen.
     */
    API_CORS_ORIGINS: z.string().default(""),

    /**
     * Rol al que hacer `SET LOCAL ROLE` en cada transacción de tenant.
     *
     * **Sin esto RLS no existe.** El usuario de la cadena de conexión en desarrollo
     * (`fastgram`) es superusuario, y un superusuario saltea RLS incondicionalmente,
     * sin que nada avise. Con el rol puesto, las políticas de `0002_tenancy_rls.sql`
     * se aplican de verdad. En producción la cadena ya debería usar el rol y esto
     * sería redundante — redundante, no inútil.
     *
     * Cadena vacía = no cambiar de rol (sólo para una conexión que ya es `fastgram_app`).
     */
    DATABASE_APP_ROLE: z.string().default(APP_ROLE),

    /** Tamaño del pool de Postgres. */
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    /**
     * Direccionamiento path-style del bucket (`http://host/bucket/key`) en vez de
     * virtual-host (`http://bucket.host/key`).
     *
     * No sale de `storageEnvSchema` porque `@fastgram/config` no lo tiene; es
     * `S3StorageConfig.forcePathStyle`, y el adaptador **no lo adivina**.
     *
     * Default `true`, y el porqué es que los dos proveedores que el proyecto
     * usa de verdad lo necesitan: MinIO **exige** path-style o devuelve
     * `NoSuchBucket` con un mensaje que parece de permisos, y el endpoint de
     * cuenta de R2 (`<account>.r2.cloudflarestorage.com/<bucket>`) también lleva
     * el bucket en la ruta. El único caso que quiere `false` es AWS S3 con
     * bucket en el host, que `ADR-006` no elige. Es un default, no un
     * descubrimiento silencioso: con `S3_FORCE_PATH_STYLE=false` se invierte.
     */
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),

    /**
     * Esquema de pg-boss. Su default es `pgboss`; se deja configurable para poder
     * correr dos entornos contra la misma base sin que compartan cola.
     */
    QUEUE_SCHEMA: z.string().min(1).default("pgboss"),

    /**
     * Correr las migraciones de pg-boss al arrancar la API.
     *
     * Default **`false`**, que es lo contrario del default del adaptador, y a
     * propósito: IMPL §4 exige migraciones *"siempre hacia adelante y compatibles
     * con la versión anterior"*, y una migración que ocurre cuando arranca el
     * primer proceso no se puede ordenar respecto del resto del deploy. Con
     * varias réplicas, además, arrancan a la vez y compiten por los mismos DDL.
     *
     * En desarrollo se pone en `true` una vez y ya está.
     */
    QUEUE_MIGRATE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(
  source: Record<string, string | undefined> = process.env,
): ApiEnv {
  return defineEnv("@fastgram/api", apiEnvSchema, source);
}

/**
 * El host de `listen`. Uno explícito gana siempre; si no hay, depende del modo.
 * Ver `API_HOST`.
 */
export function resolveListenHost(
  env: Pick<ApiEnv, "API_HOST" | "FASTGRAM_MODE">,
): string {
  if (env.API_HOST !== undefined) return env.API_HOST;
  return env.FASTGRAM_MODE === "personal" ? "127.0.0.1" : "0.0.0.0";
}

/** `API_CORS_ORIGINS` como lista. Cadena vacía ⇒ lista vacía, no `[""]`. */
export function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}
