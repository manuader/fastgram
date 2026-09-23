/**
 * Montaje de la identidad (Better Auth) — `P1-AUTH-002`, ADR-008.
 *
 * `BetterAuthIdentity` necesita un `Pool` de `pg`: `@fastgram/db` usa
 * `postgres.js`, que Better Auth no acepta. `pg` es dependencia directa de
 * `apps/api`, en la misma versión que la de `@fastgram/adapters` (8.23.0).
 */
import pg from "pg";
import {
  BetterAuthIdentity,
  type BetterAuthIdentityConfig,
  type IdentityEmailSender,
} from "@fastgram/adapters";

type PgPool = BetterAuthIdentityConfig["pool"];

export function createPgPool(connectionString: string, max: number): PgPool {
  return new pg.Pool({ connectionString, max });
}

/**
 * El "envío" del email de recuperación mientras no haya adaptador de email.
 *
 * **No hay adaptador de email en el repo.** El pedido de reset se acepta (202,
 * sin revelar si la cuenta existe), Better Auth guarda el token, y el email no
 * sale. Se deja una línea de log **sin el token y sin el email**: el token es
 * una credencial de un solo uso (quien lee el log podría cambiar la
 * contraseña) y el email es un dato personal que además confirmaría que la
 * cuenta existe.
 *
 * No lanza nunca: si lanzara, sólo lo haría para cuentas que existen, y el
 * 202-siempre dejaría de ser cierto.
 */
export function createUnconfiguredResetSender(log: {
  warn(obj: object, msg: string): void;
}): IdentityEmailSender {
  return async () => {
    log.warn(
      { feature: "password-reset" },
      "password reset requested but no email sender is configured: the email was not sent",
    );
  };
}

export interface IdentityMount {
  readonly identity: BetterAuthIdentity;
  close(): Promise<void>;
}

export function mountIdentity(options: {
  readonly databaseUrl: string;
  readonly secret: string;
  readonly baseUrl: string;
  readonly poolMax: number;
  readonly sendPasswordResetEmail: IdentityEmailSender;
}): IdentityMount {
  const pool = createPgPool(options.databaseUrl, options.poolMax);
  try {
    const identity = new BetterAuthIdentity({
      pool,
      secret: options.secret,
      baseUrl: options.baseUrl,
      sendPasswordResetEmail: options.sendPasswordResetEmail,
      // Better Auth loguea por consola, fuera de pino y de su redacción: sólo
      // errores. No se verificó qué escribe en `warn`/`info`.
      logLevel: "error",
    });
    return { identity, close: () => pool.end() };
  } catch (error) {
    // La configuración inválida mata el arranque; el pool no debe quedar
    // abierto (no conectó todavía, pero `end()` es barato y explícito).
    void pool.end();
    throw error;
  }
}
