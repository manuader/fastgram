/**
 * Límites de `/auth/*` — `P1-AUTH-002`, NFR-009.
 *
 * **Los números son una decisión de esta tarea, no del PRD.** NFR-009 fija el
 * mecanismo (token bucket con refill uniforme, `Retry-After` +
 * `details.retryAfterMs`, `503` si el contador no se puede consultar) y §9.6
 * fija límites por workspace para la API v1; para autenticación no hay ningún
 * número. Por eso no están en `RATE_LIMITS` (la tabla normativa) sino acá, y se
 * cobran con `TokenBucketLimiter.consumePolicy`.
 *
 * ## Dos dimensiones
 *
 *  - **Por email normalizado** (trim + minúsculas), siempre. Acota la fuerza
 *    bruta sobre **una cuenta** venga de donde venga. Costo aceptado: quien
 *    conoce un email puede gastar su presupuesto de login y dejar a la víctima
 *    esperando la ventana (15 min como mucho). Es el precio habitual de un
 *    límite por cuenta.
 *  - **Por IP del cliente**, sólo si la IP es confiable (`client-ip.ts`). Acota
 *    el rociado de muchas cuentas desde un origen. Detrás del BFF, sin
 *    `AUTH_TRUSTED_PROXIES`, la IP del socket es la del servidor web: un bucket
 *    por esa IP sería **un bucket global** y 20 intentos fallidos de cualquiera
 *    dejarían sin login a todo el producto. Por eso se apaga en vez de aplicarse
 *    mal.
 *
 * El bucket vive en el `BucketStore` del limitador (memoria, por proceso — ver
 * `support/bucket-store.ts`): con N réplicas, cada límite es N veces el escrito.
 */
import type { RateLimitPolicy } from "../http/rate-limit.js";

const MINUTE = 60_000;

export type AuthRateLimitedRoute =
  "signup" | "login" | "passwordReset" | "passwordResetComplete";

export const AUTH_RATE_LIMITS: Readonly<
  Record<
    AuthRateLimitedRoute,
    { readonly perEmail: RateLimitPolicy | null; readonly perIp: RateLimitPolicy }
  >
> = {
  // Nadie se da de alta cinco veces por hora con el mismo email.
  signup: {
    perEmail: { limit: 5, windowMs: 60 * MINUTE },
    perIp: { limit: 20, windowMs: 60 * MINUTE },
  },
  // 10 intentos por cuenta cada 15 minutos: ~960 por día como techo absoluto.
  login: {
    perEmail: { limit: 10, windowMs: 15 * MINUTE },
    perIp: { limit: 20, windowMs: MINUTE },
  },
  // Cada pedido manda un email: esto es también un límite anti-spam al buzón ajeno.
  passwordReset: {
    perEmail: { limit: 3, windowMs: 60 * MINUTE },
    perIp: { limit: 10, windowMs: 15 * MINUTE },
  },
  // Sin email en el cuerpo. El token es de un solo uso y no se adivina; esto
  // acota el costo de hashear contraseñas nuevas.
  passwordResetComplete: { perEmail: null, perIp: { limit: 10, windowMs: 15 * MINUTE } },
};

/** La forma canónica de un email para usarlo como clave. */
export function normalizeEmailKey(email: string): string {
  return email.trim().toLowerCase();
}
