/**
 * `/api/v1/auth/*` — `P1-AUTH-002`, F-001…F-003, PRD §15.1–15.3, §9.1.
 *
 * ## Fuera del hook de scope, a propósito
 *
 * Estas rutas se registran en un plugin **hermano** del de `/api/v1`, no
 * adentro: el hook de scope exige una credencial y éstas son justamente las que
 * la emiten. Lo que las protege es otra cosa: el rate limit por email e IP
 * (`auth/rate-limits.ts`) y que nada de lo que devuelven dependa de un
 * workspace.
 *
 * Son **internas**: el único cliente es el servidor de `apps/web` (BFF). La API
 * devuelve el token de sesión en el cuerpo; el BFF lo guarda en su cookie
 * httpOnly y lo reenvía en `X-Fastgram-Session`. Ver `auth/session.ts`.
 *
 * ## Sin identidad configurada
 *
 * Todas responden `503 service_unavailable` (ver `env.ts`). Es el mismo
 * criterio que el generador de ángulos: sin proveedor, se dice, no se inventa.
 *
 * ## Qué nunca se loguea
 *
 * Tokens, contraseñas, el header de sesión ni el email. Los errores del
 * proveedor se loguean por **código**; el objeto entero puede arrastrar la
 * petición que lo causó. Lo verifica `test/auth.int.test.ts` capturando el log.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  SESSION_UNAUTHORIZED_MESSAGE,
  authSessionSchema,
  dataEnvelope,
  loginRequestSchema,
  passwordResetCompleteRequestSchema,
  passwordResetRequestSchema,
  sessionInfoSchema,
  signUpRequestSchema,
  type AuthSession,
  type ErrorCode,
  type SessionInfo,
} from "@fastgram/contracts";
import { companyRepository, withCompany, type Database } from "@fastgram/db";
import { isPortError, type AuthorizationResult } from "@fastgram/ports";

import { resolveClientIp } from "../auth/client-ip.js";
import {
  AUTH_RATE_LIMITS,
  normalizeEmailKey,
  type AuthRateLimitedRoute,
} from "../auth/rate-limits.js";
import {
  readSessionHeader,
  type AuthIdentity,
  type SessionResolver,
} from "../auth/session.js";
import {
  rateLimitUnavailable,
  tooManyRequests,
  type TokenBucketLimiter,
} from "../http/rate-limit.js";
import type { ZodApp } from "../server/types.js";

export const AUTH_NOT_CONFIGURED_MESSAGE =
  "Authentication is not configured on this deployment";
export const AUTH_UNAVAILABLE_MESSAGE = "Authentication is temporarily unavailable";
/** Neutro: el mismo para email inexistente y contraseña equivocada. */
export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";
export const EMAIL_TAKEN_MESSAGE = "An account with this email already exists";
export const INVALID_RESET_TOKEN_MESSAGE = "This reset link is invalid or has expired";

export interface AuthRoutesOptions {
  /** `undefined` = identidad no configurada: todo `/auth/*` responde 503. */
  readonly identity: AuthIdentity | undefined;
  readonly sessions: SessionResolver;
  readonly limiter: TokenBucketLimiter;
  /** `AUTH_TRUSTED_PROXIES`. Ver `auth/client-ip.ts`. */
  readonly trustedProxies: ReadonlySet<string>;
  /** Para leer el estado del workspace en `GET /session` (`onboardingComplete`). */
  readonly db: Database;
  readonly appRole: string | undefined;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
): FastifyReply {
  if (status === 401) {
    // PRD §9.1: todos los 401 llevan este header.
    reply.header("WWW-Authenticate", 'Bearer realm="api"');
  }
  return reply.status(status).send({ error: { code, message } });
}

function toSession(result: AuthorizationResult): AuthSession {
  const { principal } = result;
  // Campo por campo (NFR-007): nada del proveedor sale por spread.
  return {
    sessionToken: result.sessionToken,
    expiresAt: principal.expiresAt.toISOString(),
    user: {
      id: principal.userId,
      email: principal.email,
      emailVerified: principal.emailVerified,
    },
  };
}

export function registerAuthRoutes(app: ZodApp, options: AuthRoutesOptions): void {
  const { identity, sessions, limiter, trustedProxies } = options;

  /**
   * Cobra los buckets de la ruta. Devuelve la respuesta ya enviada si hay que
   * cortar, o `null` para seguir. Por email siempre; por IP sólo si la IP
   * identifica al cliente (ver `auth/rate-limits.ts`).
   */
  async function enforceRateLimit(
    route: AuthRateLimitedRoute,
    request: FastifyRequest,
    reply: FastifyReply,
    email: string | null,
  ): Promise<FastifyReply | null> {
    const policy = AUTH_RATE_LIMITS[route];
    const client = resolveClientIp(
      request.socket.remoteAddress,
      request.headers["x-forwarded-for"],
      trustedProxies,
    );

    const checks: { namespace: string; scope: string; limit: typeof policy.perIp }[] = [];
    if (policy.perEmail !== null && email !== null) {
      checks.push({
        namespace: `auth:${route}:email`,
        scope: normalizeEmailKey(email),
        limit: policy.perEmail,
      });
    }
    if (client.trusted) {
      checks.push({
        namespace: `auth:${route}:ip`,
        scope: client.ip,
        limit: policy.perIp,
      });
    }

    for (const check of checks) {
      const decision = await limiter.consumePolicy(
        check.namespace,
        check.limit,
        check.scope,
      );
      if (decision.outcome === "limited") {
        const res = tooManyRequests(decision.retryAfterMs);
        // Qué bucket, no de quién: el email no va al log.
        request.log.info({ limit: check.namespace }, "auth rate limited");
        return reply.status(res.status).headers(res.headers).send(res.body);
      }
      if (decision.outcome === "unavailable") {
        const res = rateLimitUnavailable();
        request.log.error(
          { limit: check.namespace, reason: decision.reason },
          "auth rate limit unavailable",
        );
        return reply.status(res.status).send(res.body);
      }
    }
    return null;
  }

  /**
   * Traduce un error del proveedor a un código del contrato. `unauthorized`
   * no se traduce acá: su significado depende de la ruta (login → 401,
   * reset → 400).
   */
  function providerFailure(
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
  ): FastifyReply {
    if (!isPortError(error)) throw error;
    switch (error.code) {
      case "conflict":
        return sendError(reply, 409, "conflict", EMAIL_TAKEN_MESSAGE);
      case "bad_request":
        // El mensaje del adaptador ya es neutro ("The request is not valid",
        // "Full name must have at least 2 characters").
        return sendError(reply, 400, "bad_request", error.message);
      case "rate_limited":
        return sendError(reply, 429, "rate_limited", "Too many requests");
      default:
        // Sólo el código: `cause` puede arrastrar la petición al proveedor.
        request.log.error({ providerCode: error.code }, "identity provider failed");
        return sendError(reply, 503, "service_unavailable", AUTH_UNAVAILABLE_MESSAGE);
    }
  }

  // ── POST /auth/signup ── F-001
  app.post(
    "/signup",
    {
      schema: {
        body: signUpRequestSchema,
        response: { 201: dataEnvelope(authSessionSchema) },
      },
    },
    async (request, reply) => {
      if (identity === undefined) {
        return sendError(reply, 503, "service_unavailable", AUTH_NOT_CONFIGURED_MESSAGE);
      }
      const limited = await enforceRateLimit(
        "signup",
        request,
        reply,
        request.body.email,
      );
      if (limited !== null) return limited;

      let result: AuthorizationResult;
      try {
        result = await identity.signUpWithPassword({
          email: request.body.email,
          password: request.body.password,
          fullName: request.body.fullName,
        });
      } catch (error) {
        return providerFailure(request, reply, error);
      }
      request.log.info({ userId: result.principal.userId }, "user signed up");
      return reply.status(201).send({ data: toSession(result) });
    },
  );

  // ── POST /auth/login ── F-002
  app.post(
    "/login",
    {
      schema: {
        body: loginRequestSchema,
        response: { 200: dataEnvelope(authSessionSchema) },
      },
    },
    async (request, reply) => {
      if (identity === undefined) {
        return sendError(reply, 503, "service_unavailable", AUTH_NOT_CONFIGURED_MESSAGE);
      }
      const limited = await enforceRateLimit("login", request, reply, request.body.email);
      if (limited !== null) return limited;

      let result: AuthorizationResult;
      try {
        result = await identity.signInWithPassword({
          email: request.body.email,
          password: request.body.password,
        });
      } catch (error) {
        if (isPortError(error) && error.code === "unauthorized") {
          request.log.info("login rejected");
          return sendError(reply, 401, "unauthorized", INVALID_CREDENTIALS_MESSAGE);
        }
        return providerFailure(request, reply, error);
      }
      request.log.info({ userId: result.principal.userId }, "user logged in");
      return reply.status(200).send({ data: toSession(result) });
    },
  );

  // ── POST /auth/logout ── F-003. Idempotente.
  app.post("/logout", async (request, reply) => {
    if (identity === undefined) {
      return sendError(reply, 503, "service_unavailable", AUTH_NOT_CONFIGURED_MESSAGE);
    }
    const header = readSessionHeader(request.headers);
    if (header.kind !== "present") return reply.status(204).send();

    try {
      const principal = await identity.verifySessionToken(header.token);
      await identity.revokeSession(principal.sessionId);
      request.log.info({ userId: principal.userId }, "user logged out");
    } catch (error) {
      // Token inválido, vencido o ya revocado: ya está "cerrada". 204.
      if (isPortError(error) && error.code === "unauthorized") {
        return reply.status(204).send();
      }
      // Base caída: no se puede afirmar que se cerró. El BFF igual borra su
      // cookie; la fila vence sola.
      return providerFailure(request, reply, error);
    }
    return reply.status(204).send();
  });

  // ── GET /auth/session ──
  app.get(
    "/session",
    { schema: { response: { 200: dataEnvelope(sessionInfoSchema) } } },
    async (request, reply) => {
      if (identity === undefined) {
        return sendError(reply, 503, "service_unavailable", AUTH_NOT_CONFIGURED_MESSAGE);
      }
      const session = await sessions.resolve({ headers: request.headers });
      switch (session.kind) {
        case "absent":
        case "invalid":
          return sendError(reply, 401, "unauthorized", SESSION_UNAUTHORIZED_MESSAGE);
        case "unavailable":
          request.log.error({ reason: session.reason }, "session could not be verified");
          return sendError(reply, 503, "service_unavailable", AUTH_UNAVAILABLE_MESSAGE);
        case "valid": {
          const { principal } = session;
          // El estado vive en `companies.status`. Con el GUC del propio
          // workspace: la sesión ya lo resolvió, así que RLS deja leer esa fila
          // y ninguna otra.
          const onboardingComplete =
            session.companyId === null
              ? false
              : await withCompany(
                  options.db,
                  session.companyId,
                  async (tx) =>
                    (
                      await companyRepository.billing(tx, {
                        companyId: session.companyId as string,
                      })
                    )?.status === "active",
                  options.appRole === undefined || options.appRole === ""
                    ? {}
                    : { role: options.appRole },
                );
          const body: SessionInfo = {
            user: {
              id: principal.userId,
              email: principal.email,
              emailVerified: principal.emailVerified,
            },
            companyId: session.companyId,
            onboardingComplete,
          };
          return reply.status(200).send({ data: body });
        }
      }
    },
  );

  // ── POST /auth/password-reset ── §15.3. 202 siempre.
  app.post(
    "/password-reset",
    { schema: { body: passwordResetRequestSchema } },
    async (request, reply) => {
      if (identity === undefined) {
        return sendError(reply, 503, "service_unavailable", AUTH_NOT_CONFIGURED_MESSAGE);
      }
      const limited = await enforceRateLimit(
        "passwordReset",
        request,
        reply,
        request.body.email,
      );
      if (limited !== null) return limited;

      try {
        await identity.requestPasswordReset(request.body.email);
      } catch (error) {
        return providerFailure(request, reply, error);
      }
      // Exista o no la cuenta: la misma respuesta, sin cuerpo.
      return reply.status(202).send();
    },
  );

  // ── POST /auth/password-reset/complete ── §15.3
  app.post(
    "/password-reset/complete",
    { schema: { body: passwordResetCompleteRequestSchema } },
    async (request, reply) => {
      if (identity === undefined) {
        return sendError(reply, 503, "service_unavailable", AUTH_NOT_CONFIGURED_MESSAGE);
      }
      const limited = await enforceRateLimit(
        "passwordResetComplete",
        request,
        reply,
        null,
      );
      if (limited !== null) return limited;

      try {
        await identity.completePasswordReset({
          token: request.body.token,
          newPassword: request.body.newPassword,
        });
      } catch (error) {
        if (isPortError(error) && error.code === "unauthorized") {
          return sendError(reply, 400, "bad_request", INVALID_RESET_TOKEN_MESSAGE);
        }
        return providerFailure(request, reply, error);
      }
      request.log.info("password reset completed");
      return reply.status(204).send();
    },
  );
}
