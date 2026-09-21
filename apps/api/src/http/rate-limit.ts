/**
 * Rate limiting — PRD §9.6 (valores normativos).
 *
 * Dos cosas de esta sección son fáciles de implementar mal:
 *
 * 1. **Si el sistema NO PUEDE comprobar el límite de forma segura, devuelve
 *    `503 service_unavailable`, NO `429`.** El PRD lo aclara explícitamente
 *    ("esto no significa cuota agotada"). Confundirlas le dice al cliente que
 *    gastó su cuota cuando en realidad se cayó el contador — y un cliente bien
 *    hecho reaccionará esperando a la próxima ventana en vez de reintentar.
 *
 * 2. **El bucket rellena de forma uniforme en la ventana de 60 s**, no de
 *    golpe al cambiar el minuto. Con reset por minuto de reloj, un cliente
 *    puede gastar 60 a las 10:00:59 y otros 60 a las 10:01:00: 120 peticiones
 *    en dos segundos contra un límite que dice 60 por minuto.
 */
import type { Clock } from "@fastgram/ports";

/**
 * Límites del PRD §9.6. Los números NO se tocan sin cambiar el PRD.
 *
 * `restPerWorkspace` está en 60. El PRD documenta también un límite legacy de
 * 20 req/min citado en varios endpoints y lo marca como **conflicto
 * documental** (OQ-05). Se toma 60 porque es el valor que la tabla presenta
 * como normativo; queda anotado para que quien resuelva OQ-05 sepa qué cambiar
 * y dónde.
 */
export const RATE_LIMITS = {
  restPerWorkspace: { limit: 60, windowMs: 60_000 },
  blitzPreferencesUpdate: { limit: 3, windowMs: 60_000 },
  /** 5 sugerencias **exitosas** por minuto: un fallo no consume presupuesto. */
  angleGeneration: { limit: 5, windowMs: 60_000 },
  contentBuilds: { limit: 10, windowMs: 60_000 },
  /** MCP es por usuario, no por workspace (PRD §9.6). */
  mcpPerUser: { limit: 30, windowMs: 60_000 },
  partnerAggregate: { limit: 5_000, windowMs: 60_000 },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;

export type RateLimitDecision =
  | { outcome: "allowed"; remaining: number }
  | { outcome: "limited"; retryAfterMs: number }
  /**
   * No se pudo consultar el contador. El PRD manda 503, no 429.
   * `reason` va al log, no al cliente.
   */
  | { outcome: "unavailable"; reason: string };

export interface BucketState {
  /** Tokens disponibles, en coma flotante: el refill es continuo. */
  tokens: number;
  /** Último instante en que se recalcularon los tokens. */
  updatedAtMs: number;
}

export interface BucketStore {
  read(key: string): Promise<BucketState | null>;
  write(key: string, state: BucketState): Promise<void>;
}

export class TokenBucketLimiter {
  constructor(
    private readonly store: BucketStore,
    private readonly clock: Clock,
  ) {}

  async consume(
    name: RateLimitName,
    scopeId: string,
    cost = 1,
  ): Promise<RateLimitDecision> {
    const { limit, windowMs } = RATE_LIMITS[name];
    const key = `${name}:${scopeId}`;
    const now = this.clock.nowMs();

    let state: BucketState | null;
    try {
      state = await this.store.read(key);
    } catch (e) {
      // Acá está la regla que importa: no sabemos si le queda cuota, así que
      // no podemos afirmar que se le acabó.
      return {
        outcome: "unavailable",
        reason: e instanceof Error ? e.message : "no se pudo leer el bucket",
      };
    }

    const tokens = state === null ? limit : refill(state, limit, windowMs, now);

    if (tokens < cost) {
      // Cuánto falta esperar para juntar `cost` tokens, al ritmo de refill.
      const perMs = limit / windowMs;
      const retryAfterMs = Math.ceil((cost - tokens) / perMs);
      return { outcome: "limited", retryAfterMs };
    }

    const next: BucketState = { tokens: tokens - cost, updatedAtMs: now };
    try {
      await this.store.write(key, next);
    } catch (e) {
      return {
        outcome: "unavailable",
        reason: e instanceof Error ? e.message : "no se pudo escribir el bucket",
      };
    }

    return { outcome: "allowed", remaining: Math.floor(next.tokens) };
  }
}

/** Refill uniforme y continuo. No hay salto al cambiar el minuto de reloj. */
function refill(
  state: BucketState,
  limit: number,
  windowMs: number,
  nowMs: number,
): number {
  const elapsed = Math.max(0, nowMs - state.updatedAtMs);
  const gained = (elapsed * limit) / windowMs;
  return Math.min(limit, state.tokens + gained);
}

/** La respuesta 429 del PRD §9.6: header `Retry-After` y `details.retryAfterMs`. */
export function tooManyRequests(retryAfterMs: number): {
  status: number;
  headers: Record<string, string>;
  body: { error: { code: string; message: string; details: { retryAfterMs: number } } };
} {
  return {
    status: 429,
    headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
    body: {
      error: {
        code: "rate_limited",
        message: "Too many requests",
        details: { retryAfterMs },
      },
    },
  };
}

/** El 503 del PRD §9.6 — explícitamente NO es cuota agotada. */
export function rateLimitUnavailable(): {
  status: number;
  headers: Record<string, string>;
  body: { error: { code: string; message: string } };
} {
  return {
    status: 503,
    headers: {},
    body: {
      error: {
        code: "service_unavailable",
        message:
          "Rate limit could not be verified. This does not mean your quota is exhausted.",
      },
    },
  };
}
