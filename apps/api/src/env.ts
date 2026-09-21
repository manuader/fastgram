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
 * montan y exigirlas rompería el arranque por algo que nadie usa.
 */
import { baseEnvSchema, defineEnv, postgresEnvSchema, z } from "@fastgram/config/env";
import { APP_ROLE } from "@fastgram/db";

export const apiEnvSchema = baseEnvSchema.merge(postgresEnvSchema).extend({
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_HOST: z.string().min(1).default("0.0.0.0"),

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
   * URL pública del bucket. **Opcional a propósito**, a diferencia de
   * `storageEnvSchema` de `@fastgram/config`: hoy la API sólo monta `MemoryStorage`
   * y exigir credenciales de S3 impediría arrancar por algo que no se usa. Cuando
   * exista el adaptador S3, esto pasa a ser `storageEnvSchema` entero y deja de ser
   * opcional — ahí sí faltarlo es un arranque roto.
   */
  S3_PUBLIC_URL: z.string().url().optional(),

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

/** `API_CORS_ORIGINS` como lista. Cadena vacía ⇒ lista vacía, no `[""]`. */
export function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}
