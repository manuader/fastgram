import { z } from "zod";

/**
 * Validación de entorno — P0-REPO-009.
 *
 * Regla: si falta una variable requerida, el proceso NO levanta.
 * Un proceso que arranca a medias y falla a las tres horas, cuando un usuario
 * toca la única ruta que usa esa variable, cuesta mucho más que un crash al
 * arrancar. El error tiene que decir exactamente qué falta y en qué app.
 */

export class EnvError extends Error {
  override readonly name = "EnvError";
  constructor(
    readonly appName: string,
    readonly issues: readonly { path: string; message: string }[],
  ) {
    super(
      `[${appName}] configuración de entorno inválida:\n` +
        issues.map((i) => `  · ${i.path}: ${i.message}`).join("\n") +
        `\n\nRevisá .env.example y tu .env local.`,
    );
  }
}

export function defineEnv<S extends z.ZodTypeAny>(
  appName: string,
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(
      appName,
      parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return parsed.data as z.infer<S>;
}

/** Piezas que comparten todas las apps. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export const postgresEnvSchema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgres"),
});

export const storageEnvSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default("auto"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** URL pública del CDN delante del bucket. Sin esto se sirve el master. */
  S3_PUBLIC_URL: z.string().url(),
});

export { z };
