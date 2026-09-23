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

/** Un límite: `limit` peticiones por `windowMs`, con refill uniforme. */
export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

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

/**
 * Almacén del bucket.
 *
 * **`compareAndSwap` y no `write`, y no es un detalle.** Entre leer y escribir
 * hay un `await`: con `write` a secas, N peticiones concurrentes del mismo
 * workspace leen todas el mismo estado y **pasan todas**, así que el límite
 * efectivo es hasta N veces el configurado. Los tests secuenciales no lo ven —
 * este bug vivió en el código hasta que alguien lo leyó pensando en
 * concurrencia.
 *
 * Con CAS, el perdedor de la carrera reintenta sobre el estado nuevo. Cada
 * implementación lo resuelve con lo que tenga: una comparación de referencia en
 * memoria, un `UPDATE ... WHERE updated_at_ms = $esperado` en Postgres, un
 * `WATCH`/`MULTI` en Redis.
 */
export interface BucketStore {
  read(key: string): Promise<BucketState | null>;
  /**
   * Escribe `next` **sólo si** el estado guardado sigue siendo `expected`
   * (`null` = no existía). Devuelve `false` si otro lo cambió primero.
   */
  compareAndSwap(
    key: string,
    expected: BucketState | null,
    next: BucketState,
  ): Promise<boolean>;
}

/**
 * Cuántas veces reintentar cuando se pierde la carrera del CAS.
 *
 * Acotado a propósito: bajo contención extrema es preferible responder
 * `unavailable` —que el PRD traduce a 503— antes que girar. Un 503 dice "no
 * pude comprobarlo"; girar convierte el limitador en el cuello de botella que
 * debía proteger.
 */
const MAX_CAS_ATTEMPTS = 5;

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
    return this.consumePolicy(name, RATE_LIMITS[name], scopeId, cost);
  }

  /**
   * Lo mismo que {@link consume} con un límite que **no** es de §9.6.
   *
   * Existe para los límites de `/auth/*` (`auth/rate-limits.ts`): NFR-009 da el
   * mecanismo y el PRD no da números para autenticación, así que esos números
   * son una decisión y no pueden vivir en `RATE_LIMITS`, que es la tabla
   * normativa. `namespace` va en la clave: dos políticas con el mismo `scopeId`
   * no comparten bucket.
   */
  async consumePolicy(
    namespace: string,
    policy: RateLimitPolicy,
    scopeId: string,
    cost = 1,
  ): Promise<RateLimitDecision> {
    const { limit, windowMs } = policy;
    const key = `${namespace}:${scopeId}`;

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const now = this.clock.nowMs();

      let state: BucketState | null;
      try {
        state = await this.store.read(key);
      } catch (e) {
        // La regla que importa: no sabemos si le queda cuota, así que no
        // podemos afirmar que se le acabó.
        return {
          outcome: "unavailable",
          reason: e instanceof Error ? e.message : "no se pudo leer el bucket",
        };
      }

      const tokens = state === null ? limit : refill(state, limit, windowMs, now);

      if (tokens < cost) {
        // Cuánto falta esperar para juntar `cost` tokens, al ritmo de refill.
        // No hace falta CAS: no estamos escribiendo nada.
        const perMs = limit / windowMs;
        const retryAfterMs = Math.ceil((cost - tokens) / perMs);
        return { outcome: "limited", retryAfterMs };
      }

      const next: BucketState = { tokens: tokens - cost, updatedAtMs: now };
      let won: boolean;
      try {
        won = await this.store.compareAndSwap(key, state, next);
      } catch (e) {
        return {
          outcome: "unavailable",
          reason: e instanceof Error ? e.message : "no se pudo escribir el bucket",
        };
      }

      if (won) return { outcome: "allowed", remaining: Math.floor(next.tokens) };
      // Perdimos la carrera: otro consumió mientras tanto. Releemos y
      // reintentamos sobre el estado nuevo.
    }

    // Contención sostenida. 503, no 429: no llegamos a saber si le quedaba.
    return {
      outcome: "unavailable",
      reason: `el bucket cambió bajo nosotros ${MAX_CAS_ATTEMPTS} veces seguidas`,
    };
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
