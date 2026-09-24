/**
 * Aplicación del rate limiting — PRD §9.6.
 *
 * Los números y el algoritmo son de `src/http/rate-limit.ts`; acá sólo se decide
 * **dónde** se aplica cada límite y se traducen los tres desenlaces a HTTP.
 *
 * El desenlace que se implementa mal por defecto es el tercero: cuando el contador no
 * se puede consultar, el PRD manda **503**, no 429, y lo aclara con todas las letras
 * ("esto no significa cuota agotada"). Un 429 ahí le dice al cliente que gastó su
 * cuota; un cliente bien hecho reacciona esperando a la próxima ventana, y se queda
 * esperando por un contador caído.
 *
 * ## `angleGeneration` es distinto y por eso tiene su propia función
 *
 * §9.6 dice "5 **sugerencias exitosas** por minuto". Un fallo no consume presupuesto,
 * así que ese límite no se puede cobrar en un `preHandler`: cuando el preHandler corre
 * todavía no se sabe si va a haber sugerencia. Se cobra después, con
 * {@link consumeOnSuccess}. El coste es que una generación que sale del modelo y llega
 * con el bucket vacío se descarta; el beneficio es que el límite dice lo que el PRD
 * dice. Los intentos fallidos igual están acotados por el límite global de 60/min.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import {
  rateLimitUnavailable,
  tooManyRequests,
  type RateLimitName,
  type TokenBucketLimiter,
} from "../http/rate-limit.js";

/**
 * Modo personal (`PU-RUN-002`, `D-06`): un solo usuario, nadie a quien racionar.
 *
 * Se decide **acá**, en la aplicación, y no en `TokenBucketLimiter`: el algoritmo
 * y sus números (§9.6) siguen intactos y testeados para `standard`, y lo único
 * que cambia es que en `personal` no se consulta. Se lee de `request.server.deps`
 * para no tener que tocar la firma de las ~25 rutas que registran un límite.
 */
function limitsDisabled(request: FastifyRequest): boolean {
  return request.server.deps.mode === "personal";
}

function applyDecisionHeaders(
  reply: FastifyReply,
  headers: Record<string, string>,
): void {
  reply.headers(headers);
}

/**
 * `preHandler` que cobra un límite antes de ejecutar la ruta.
 *
 * Se apoya en `request.auth.companyId`, así que **tiene que registrarse después** del
 * hook de scope. Si no hay auth todavía, no hay a quién cobrarle: se deja pasar y el
 * hook de scope devolverá el 401 que corresponde.
 */
export function rateLimit(
  limiter: TokenBucketLimiter,
  name: RateLimitName,
): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (limitsDisabled(request)) return;
    const companyId = request.auth?.companyId;
    if (companyId === undefined) return;

    const decision = await limiter.consume(name, companyId);

    if (decision.outcome === "limited") {
      const res = tooManyRequests(decision.retryAfterMs);
      applyDecisionHeaders(reply, res.headers);
      request.log.info(
        { limit: name, retryAfterMs: decision.retryAfterMs },
        "rate limited",
      );
      return reply.status(res.status).send(res.body);
    }

    if (decision.outcome === "unavailable") {
      const res = rateLimitUnavailable();
      // `reason` al log, nunca al cuerpo: dice qué se cayó de nuestra infraestructura.
      request.log.error(
        { limit: name, reason: decision.reason },
        "rate limit unavailable",
      );
      return reply.status(res.status).send(res.body);
    }

    // `X-RateLimit-Remaining` no lo pide el PRD; se omite a propósito para no
    // inventar contrato. `Retry-After` sí está especificado y va en el 429.
    return;
  };
}

/**
 * Cobra un límite **después** de que la operación salió bien.
 *
 * Devuelve `null` si había presupuesto (seguir y responder normal) o la respuesta 429
 * / 503 ya armada si no. Ver la nota de `angleGeneration` en la cabecera.
 */
export async function consumeOnSuccess(
  limiter: TokenBucketLimiter,
  name: RateLimitName,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | null> {
  if (limitsDisabled(request)) return null;
  const companyId = request.auth.companyId;
  const decision = await limiter.consume(name, companyId);

  if (decision.outcome === "limited") {
    const res = tooManyRequests(decision.retryAfterMs);
    applyDecisionHeaders(reply, res.headers);
    request.log.info({ limit: name }, "rate limited after success");
    return reply.status(res.status).send(res.body);
  }
  if (decision.outcome === "unavailable") {
    const res = rateLimitUnavailable();
    request.log.error({ limit: name, reason: decision.reason }, "rate limit unavailable");
    return reply.status(res.status).send(res.body);
  }
  return null;
}
