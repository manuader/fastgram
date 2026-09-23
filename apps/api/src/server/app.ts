/**
 * Montaje del servidor — P1-API-001 y P1-API-004.
 *
 * `buildServer` recibe las dependencias ya construidas y no las construye: es lo que
 * permite que un test levante la app entera contra un Postgres real y un `FixedClock`
 * sin variables de entorno ni puertos abiertos. El cableado con el mundo
 * (`createDb`, `systemClock`, …) vive en `main.ts`, que es el único que lee el entorno.
 *
 * ## Versionado en la ruta (P1-API-004)
 *
 * `/api/v1` es un prefijo real, no un reescritor: las rutas se registran dentro de un
 * plugin encapsulado con ese prefijo. Eso hace que el hook de scope —que se agrega
 * dentro— **no pueda** olvidarse en una ruta v1, y que no se aplique a `/health`.
 * §9.3: *"Cambios breaking → nueva versión mayor de ruta"*; montar v2 más adelante es
 * registrar otro plugin al lado.
 */
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { neutralizeMalformedIds } from "../http/route-ids.js";
import { registerErrorHandler } from "../plugins/error-handler.js";
import {
  REDACTED_PATHS,
  REQUEST_ID_HEADER,
  bindCompanyToLogger,
  generateRequestId,
  registerAccessLogging,
} from "../plugins/observability.js";
import { SESSION_UNAUTHORIZED_MESSAGE } from "@fastgram/contracts";

import { INVALID_API_KEY_MESSAGE, describeRejection } from "../auth/api-keys.js";
import { resolveScope, runScoped, type ScopeResolution } from "../auth/scope.js";
import { createSessionResolver, noSessionResolver } from "../auth/session.js";
import { registerAuthRoutes } from "../routes/auth.js";
import { registerWorkspaceRoutes } from "../routes/workspace.js";
import { registerV1Routes } from "../routes/v1/index.js";
import {
  createHealthChecker,
  livenessReport,
  probesFor,
  statusCodeFor,
} from "./health.js";
import type { ApiDeps, ZodApp } from "./types.js";

/** §9.3 — prefijo de la versión mayor. */
export const API_V1_PREFIX = "/api/v1";

/**
 * Sesión válida, usuario sin ninguna membresía activa. `403 forbidden`: ver
 * `SessionRejection` en `auth/scope.ts` para por qué no es 404 ni 401.
 */
export const NO_WORKSPACE_MESSAGE =
  "Your account isn't an active member of any workspace yet.";

export interface BuildServerOptions {
  readonly deps: ApiDeps;
  readonly corsOrigins?: readonly string[];
  readonly logLevel?: string;
  /** `false` en tests, para que la suite no escupa una línea por request. */
  readonly enableAccessLog?: boolean;
  /**
   * Destino del log. Sólo para tests que necesitan **leer** lo que se loguea
   * (que ningún token ni contraseña llegue al log). Default: stdout.
   */
  readonly logStream?: { write(msg: string): void };
  /**
   * TTL del cache de `/health`. Default: `HEALTH_CACHE_TTL_MS` (3 s).
   *
   * `0` lo desactiva, y es lo que necesita cualquier test que quiera ver una
   * dependencia caerse: el `Clock` inyectado está congelado en la suite, así que
   * una entrada cacheada no vence nunca. Ver la nota de `health.ts`.
   */
  readonly healthCacheTtlMs?: number;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { deps } = options;

  const app = Fastify({
    logger: {
      level: options.logLevel ?? "info",
      redact: { paths: [...REDACTED_PATHS], remove: true },
      ...(options.logStream === undefined ? {} : { stream: options.logStream }),
    },
    // P1-OBS-001: el id de request respeta el `x-request-id` entrante para que la
    // traza cruce el borde entre apps sin cortarse.
    genReqId: (req) => generateRequestId(req.headers[REQUEST_ID_HEADER]),
    // §9.3 es server-to-server; un body gigante es abuso, no un caso de uso.
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  // Zod como única fuente de validación: los schemas son los de `@fastgram/contracts`.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("deps", deps);

  await app.register(helmet, {
    // La API devuelve JSON, no HTML: la CSP por defecto de helmet no aporta nada acá
    // y sí rompe la UI de OpenAPI si más adelante se sirve desde el mismo origen.
    contentSecurityPolicy: false,
  });

  const origins = options.corsOrigins ?? [];
  await app.register(cors, {
    // Lista explícita. `origin: true` reflejaría cualquier origen, y eso convierte
    // una API key filtrada en el browser en un problema de todos los sitios.
    origin: origins.length === 0 ? false : [...origins],
    credentials: origins.length > 0,
  });

  registerErrorHandler(app);
  if (options.enableAccessLog !== false) registerAccessLogging(app);

  // ── /health: sin auth y fuera de la versión ──
  //
  // Fuera de `/api/v1` a propósito: es para el orquestador, no para integradores, y
  // no debe cambiar cuando la API saque una v2.
  //
  // `P1-OBS-004`: acá había un literal `{status:"ok"}` que respondía 200 con
  // Postgres caído. El razonamiento entero —por qué liveness y readiness son dos
  // rutas, por qué hay cache y de cuánto, y qué puede salir en el cuerpo— está en
  // `server/health.ts`; lo que queda acá es el cableado.
  const health = createHealthChecker({
    probes: probesFor(deps),
    clock: deps.clock,
    ...(options.healthCacheTtlMs === undefined
      ? {}
      : { ttlMs: options.healthCacheTtlMs }),
    // El motivo real del fallo va **al log y sólo al log**: el cuerpo de la
    // respuesta es público y no lleva ni el mensaje de Postgres ni el del SDK.
    onProbeFailure: (dependency, error) => {
      app.log.error({ dependency, err: error }, "health probe failed");
    },
  });

  /**
   * Liveness. No toca ninguna dependencia: si falla, la respuesta correcta del
   * orquestador es reiniciar, y reiniciar no arregla una base caída.
   */
  app.get("/health/live", async () => livenessReport());

  /** Readiness. Es el que puede fallar. */
  const readiness = async (_request: unknown, reply: FastifyReply): Promise<unknown> => {
    const report = await health.check();
    return reply.status(statusCodeFor(report)).send(report);
  };

  app.get("/health/ready", readiness);
  // La URL que ya estaba desplegada se queda con la readiness, que es la pregunta
  // que alguien que la consulta se está haciendo. Ver la nota operativa de
  // `health.ts` sobre mover una livenessProbe existente a `/health/live`.
  app.get("/health", readiness);

  // ── /api/v1/auth: la única parte de la v1 SIN scope ──
  //
  // Plugin **hermano** del de `/api/v1`, no hijo: el hook de scope que se
  // agrega ahí adentro no lo alcanza, que es lo que tiene que pasar con las
  // rutas que emiten la credencial. Ver `routes/auth.ts`.
  const sessions =
    deps.sessions ??
    (deps.identity === undefined
      ? noSessionResolver
      : createSessionResolver({ identity: deps.identity, db: deps.db }));
  const trustedProxies = new Set(deps.authTrustedProxies ?? []);
  await app.register(
    async (raw) => {
      registerAuthRoutes(raw.withTypeProvider<ZodTypeProvider>() as ZodApp, {
        identity: deps.identity,
        sessions,
        limiter: deps.limiter,
        trustedProxies,
        db: deps.db,
        appRole: deps.appRole,
      });
      await Promise.resolve();
    },
    { prefix: `${API_V1_PREFIX}/auth` },
  );

  // ── POST /api/v1/onboarding/workspace: sesión SIN workspace (P1-TENANT-001) ──
  //
  // Otro plugin hermano, por la misma razón que `/auth`: es la ruta que crea
  // lo que el hook de scope exige, así que ese hook la rechazaría siempre. En
  // vez de una lista de exenciones adentro del hook, un plugin que registra
  // **una** ruta con su propio `onRequest` (sesión obligatoria, API key 403).
  // Ver `routes/workspace.ts`.
  await app.register(
    async (raw) => {
      registerWorkspaceRoutes(raw.withTypeProvider<ZodTypeProvider>() as ZodApp, {
        db: deps.db,
        clock: deps.clock,
        appRole: deps.appRole,
        identityConfigured: deps.identity !== undefined,
        sessions,
      });
      await Promise.resolve();
    },
    { prefix: `${API_V1_PREFIX}/onboarding` },
  );

  // ── /api/v1: todo lo de adentro pasa por el scope ──
  await app.register(
    async (raw) => {
      // Sin el provider, `request.body`/`request.query` vuelven a ser `unknown`.
      const v1 = raw.withTypeProvider<ZodTypeProvider>() as ZodApp;
      // Fastify v5: se declaran sin valor. Decorar fija la "forma" del objeto
      // request una sola vez, que es lo que evita que V8 lo vuelva a optimizar en
      // cada petición; el valor real lo pone el hook de scope de acá abajo.
      v1.decorateRequest("auth");
      v1.decorateRequest("tx");

      /**
       * P1-API-007. Se registra como `onRequest`, el hook más temprano con headers
       * disponibles: una petición sin credencial válida no llega a parsear body ni a
       * consumir rate limit.
       */
      v1.addHook("onRequest", async (request, reply) => {
        const resolution = await resolveScope(
          { db: deps.db, clock: deps.clock, sessions },
          request.headers,
        );

        if (!resolution.ok) return rejectScope(request, reply, resolution);

        request.auth = resolution.auth;
        bindCompanyToLogger(request, resolution.auth.companyId, {
          authKind: resolution.auth.kind,
          ...(resolution.auth.apiKeyId === undefined
            ? {}
            : { apiKeyId: resolution.auth.apiKeyId }),
          ...(resolution.auth.userId === undefined
            ? {}
            : { userId: resolution.auth.userId }),
        });

        request.tx = (fn) =>
          runScoped(deps.db, resolution.auth.companyId, deps.appRole, fn);
        return;
      });

      // NFR-006: un `:id` que no es uuid se contesta como uno que no existe, en
      // todas las rutas v1 y sin que cada una tenga que acordarse. Antes daba
      // 500 en 11 de las 17 operaciones con `{id}`. Ver `http/route-ids.ts`.
      v1.addHook("preValidation", neutralizeMalformedIds);

      await registerV1Routes(v1);
    },
    { prefix: API_V1_PREFIX },
  );

  return app;
}

/**
 * La respuesta a una credencial que no autoriza.
 *
 * El cuerpo de un 401 de API key es **idéntico** para las ocho causas de
 * `FR-180` (el log las distingue). El de sesión lleva el copy de §15.2, que es
 * lo que el BFF muestra. Una sesión sin workspace es 403, y una que no se pudo
 * comprobar es 503: ver `SessionRejection`.
 */
function rejectScope(
  request: FastifyRequest,
  reply: FastifyReply,
  resolution: Extract<ScopeResolution, { ok: false }>,
): FastifyReply {
  const { reason } = resolution;
  if (reason === "session_unavailable") {
    request.log.error(
      { reason, detail: "detail" in resolution ? resolution.detail : undefined },
      "session could not be verified",
    );
    return reply.status(503).send({
      error: {
        code: "service_unavailable",
        message: "Authentication is temporarily unavailable",
      },
    });
  }

  if (reason === "session_invalid" || reason === "session_without_workspace") {
    request.log.info({ reason }, `session rejected: ${reason}`);
  } else {
    request.log.info({ reason }, describeRejection(reason));
  }

  if (reason === "session_without_workspace") {
    return reply
      .status(403)
      .send({ error: { code: "forbidden", message: NO_WORKSPACE_MESSAGE } });
  }

  // §9.1: **todas** las respuestas 401 llevan este header.
  reply.header("WWW-Authenticate", 'Bearer realm="api"');
  const message =
    reason === "session_invalid" ? SESSION_UNAUTHORIZED_MESSAGE : INVALID_API_KEY_MESSAGE;
  return reply.status(401).send({ error: { code: "unauthorized", message } });
}
