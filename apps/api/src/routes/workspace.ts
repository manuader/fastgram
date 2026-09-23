/**
 * `POST /api/v1/onboarding/workspace` — `P1-TENANT-001`, `F-008`, PRD §15.4,
 * `DATA-002`/`DATA-003`, y la decisión de PRD §2.4 (2026-09-23): el primer
 * workspace nace en Free + `trialing`.
 *
 * ## Por qué está fuera del plugin de `/api/v1`
 *
 * Todas las rutas de `/api/v1` pasan por el hook de scope, que con una sesión
 * **sin** workspace responde `403` antes del handler — correcto para todas,
 * menos para la que crea el workspace. En vez de abrirle una excepción a ese
 * hook (una lista de rutas exentas adentro del único control que no admite
 * excepciones), esta ruta se monta en un plugin **hermano**, como `/auth/*`,
 * con su propio `onRequest` que exige exactamente lo que esta ruta necesita:
 *
 *  - una **sesión** válida (`X-Fastgram-Session`). Una API key no crea
 *    workspaces —ya es de uno— y recibe `403`;
 *  - y nada más: tener o no workspace lo decide el handler (409).
 *
 * Nada de lo que se registre en `/api/v1` hereda esto, y este plugin no
 * registra ninguna otra ruta. Lo mide `test/first-workspace.int.test.ts`: con la
 * misma sesión sin workspace, `GET /onboarding` sigue siendo `403`.
 *
 * ## Qué hace cada capa
 *
 *  - `@fastgram/core` (`planFirstWorkspace`): valida con la copy de `FR-010` y
 *    decide los valores (plan, estado, ancla, membresía, default).
 *  - `@fastgram/db` (`createFirstWorkspace`): lo escribe en una transacción con
 *    el usuario bloqueado, y vuelve a preguntar si ya tiene uno **bajo el lock**.
 *  - Acá: autenticar, traducir y serializar.
 *
 * El 409 rápido de abajo (la sesión ya resolvió un `companyId`) es un atajo,
 * **no** la guarda: dos pedidos simultáneos pasan los dos por él. La guarda es
 * el lock del repositorio.
 *
 * ## Sin `Idempotency-Key` y sin rate limit por workspace
 *
 * Ver la cabecera de `packages/contracts/src/resources/workspaces.ts` para la
 * key. El rate limit de escritura de la v1 es por workspace
 * (`restPerWorkspace`) y acá no hay workspace; la operación está acotada por la
 * invariante misma: **un** workspace por usuario, y después 409.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  SESSION_UNAUTHORIZED_MESSAGE,
  createWorkspaceRequestSchema,
  dataEnvelope,
  workspaceSchema,
  type ErrorCode,
  type Workspace,
} from "@fastgram/contracts";
import {
  WEBSITE_MESSAGES,
  WORKSPACE_ALREADY_EXISTS_MESSAGE,
  planFirstWorkspace,
} from "@fastgram/core";
import { createFirstWorkspace, type CompanyRow, type Database } from "@fastgram/db";
import type { Clock } from "@fastgram/ports";

import type { SessionResolver } from "../auth/session.js";
import { ApiRejection } from "../http/errors.js";
import type { ZodApp } from "../server/types.js";
import { asApiRejection } from "./v1/onboarding.js";
import { AUTH_NOT_CONFIGURED_MESSAGE, AUTH_UNAVAILABLE_MESSAGE } from "./auth.js";

/** Con API key. Una key es de un workspace; crear el primero es de un usuario. */
export const WORKSPACE_REQUIRES_SESSION_MESSAGE =
  "Workspaces can only be created from a signed-in user session.";

export interface WorkspaceRoutesOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly appRole: string | undefined;
  /** `false` = identidad no configurada: la ruta responde 503. */
  readonly identityConfigured: boolean;
  readonly sessions: SessionResolver;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): FastifyReply {
  // PRD §9.1: todos los 401 llevan este header.
  if (status === 401) reply.header("WWW-Authenticate", 'Bearer realm="api"');
  return reply
    .status(status)
    .send({ error: { code, message, ...(details === undefined ? {} : { details }) } });
}

function toWorkspace(row: CompanyRow): Workspace {
  // Campo por campo: la fila tiene `ownerUserId`, `entitlements`, `partnerId`…
  return {
    id: row.id,
    name: row.name,
    websiteUrl: row.websiteUrl,
    status: row.status,
    planId: row.planId,
    subscriptionStatus: row.subscriptionStatus,
    timezone: row.timezone,
    createdAt: row.createdAt.toISOString(),
  };
}

function alreadyExists(): ApiRejection {
  return new ApiRejection(409, "conflict", WORKSPACE_ALREADY_EXISTS_MESSAGE, {
    reason: "workspace_already_exists",
  });
}

/**
 * Quién pide. Lo pone el `onRequest` de este plugin y lo lee el handler.
 * `WeakMap` y no `decorateRequest`: la forma de `FastifyRequest` la fija el
 * plugin de `/api/v1` (`auth`, `tx`), y esto no es un `AuthContext` —no hay
 * `companyId`—, así que no se disfraza de uno.
 */
const owners = new WeakMap<FastifyRequest, { readonly userId: string }>();

/**
 * Se registra dentro de un plugin **propio** con prefijo
 * `/api/v1/onboarding`. Ver la cabecera.
 */
export function registerWorkspaceRoutes(
  app: ZodApp,
  options: WorkspaceRoutesOptions,
): void {
  const { db, clock, appRole, identityConfigured, sessions } = options;

  // Antes de parsear el cuerpo, como el hook de scope: una petición sin
  // credencial no llega a validar body.
  app.addHook("onRequest", async (request, reply) => {
    if (!identityConfigured) {
      return sendError(reply, 503, "service_unavailable", AUTH_NOT_CONFIGURED_MESSAGE);
    }

    const rawAuth = request.headers["authorization"];
    const authHeader = Array.isArray(rawAuth) ? rawAuth.join(",") : rawAuth;
    if (authHeader !== undefined && authHeader.trim() !== "") {
      request.log.info(
        { reason: "api_key_on_workspace_create" },
        "workspace create rejected",
      );
      return sendError(reply, 403, "forbidden", WORKSPACE_REQUIRES_SESSION_MESSAGE);
    }

    const session = await sessions.resolve({ headers: request.headers });
    switch (session.kind) {
      case "absent":
      case "invalid":
        return sendError(reply, 401, "unauthorized", SESSION_UNAUTHORIZED_MESSAGE);
      case "unavailable":
        request.log.error({ reason: session.reason }, "session could not be verified");
        return sendError(reply, 503, "service_unavailable", AUTH_UNAVAILABLE_MESSAGE);
      case "valid":
        // El atajo: ya resuelve a un workspace. La guarda real está en el
        // repositorio, bajo lock (ver la cabecera).
        if (session.companyId !== null) {
          request.log.info(
            { userId: session.principal.userId, companyId: session.companyId },
            "workspace create rejected: user already has one",
          );
          const rejection = alreadyExists();
          return sendError(
            reply,
            rejection.status,
            rejection.code,
            rejection.message,
            rejection.publicDetails,
          );
        }
        owners.set(request, { userId: session.principal.userId });
        return;
    }
  });

  app.post(
    "/workspace",
    {
      schema: {
        body: createWorkspaceRequestSchema,
        response: { 201: dataEnvelope(workspaceSchema) },
      },
    },
    async (request, reply) => {
      const owner = owners.get(request);
      if (owner === undefined) {
        // No puede pasar: el `onRequest` de arriba corta o lo pone.
        throw new Error("POST /onboarding/workspace sin dueño resuelto: bug de montaje.");
      }

      let plan: ReturnType<typeof planFirstWorkspace>;
      try {
        plan = planFirstWorkspace(
          {
            ownerUserId: owner.userId,
            name: request.body.name,
            websiteUrl: request.body.websiteUrl,
          },
          new Date(clock.nowMs()),
        );
      } catch (error) {
        // `out_of_range` no está en el contrato: sale como 400 con la copy
        // literal y `details.field`. Misma traducción que el cuestionario.
        throw asApiRejection(error);
      }

      const result = await createFirstWorkspace(
        db,
        plan,
        appRole === undefined || appRole === "" ? {} : { role: appRole },
      );

      switch (result.kind) {
        case "created":
          request.log.info(
            { userId: owner.userId, companyId: result.company.id },
            "workspace created",
          );
          return reply.status(201).send({ data: toWorkspace(result.company) });
        case "already_has_workspace":
          // Perdió la carrera contra otro pedido del mismo usuario.
          request.log.info(
            { userId: owner.userId, companyId: result.companyId },
            "workspace create rejected under lock: user already has one",
          );
          throw alreadyExists();
        case "website_taken":
          throw new ApiRejection(409, "conflict", WEBSITE_MESSAGES.alreadyRegistered, {
            reason: "website_already_registered",
            field: "websiteUrl",
          });
        case "owner_not_found":
          // La firma de la sesión era buena y el usuario ya no existe: se borró
          // entre la verificación y el lock. Para el BFF es una sesión muerta.
          return sendError(reply, 401, "unauthorized", SESSION_UNAUTHORIZED_MESSAGE);
      }
    },
  );
}
