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
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { registerErrorHandler } from "../plugins/error-handler.js";
import {
  REDACTED_PATHS,
  REQUEST_ID_HEADER,
  bindCompanyToLogger,
  generateRequestId,
  registerAccessLogging,
} from "../plugins/observability.js";
import { INVALID_API_KEY_MESSAGE, describeRejection } from "../auth/api-keys.js";
import { resolveScope, runScoped } from "../auth/scope.js";
import { registerV1Routes } from "../routes/v1/index.js";
import type { ApiDeps, ZodApp } from "./types.js";

/** §9.3 — prefijo de la versión mayor. */
export const API_V1_PREFIX = "/api/v1";

export interface BuildServerOptions {
  readonly deps: ApiDeps;
  readonly corsOrigins?: readonly string[];
  readonly logLevel?: string;
  /** `false` en tests, para que la suite no escupa una línea por request. */
  readonly enableAccessLog?: boolean;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { deps } = options;

  const app = Fastify({
    logger: {
      level: options.logLevel ?? "info",
      redact: { paths: [...REDACTED_PATHS], remove: true },
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
  // Fuera de `/api/v1` a propósito: es para el orquestador, no para integradores, y
  // no debe cambiar cuando la API saque una v2.
  app.get("/health", async () => ({ status: "ok", service: "api" }));

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
          {
            db: deps.db,
            clock: deps.clock,
            ...(deps.sessions === undefined ? {} : { sessions: deps.sessions }),
          },
          request.headers,
        );

        if (!resolution.ok) {
          request.log.info(
            { reason: resolution.reason },
            describeRejection(resolution.reason),
          );
          // §9.1: **todas** las respuestas 401 llevan este header.
          return reply
            .status(401)
            .header("WWW-Authenticate", 'Bearer realm="api"')
            .send({
              error: { code: "unauthorized", message: INVALID_API_KEY_MESSAGE },
            });
        }

        request.auth = resolution.auth;
        bindCompanyToLogger(request, resolution.auth.companyId, {
          authKind: resolution.auth.kind,
          ...(resolution.auth.apiKeyId === undefined
            ? {}
            : { apiKeyId: resolution.auth.apiKeyId }),
        });

        request.tx = (fn) =>
          runScoped(deps.db, resolution.auth.companyId, deps.appRole, fn);
        return;
      });

      await registerV1Routes(v1);
    },
    { prefix: API_V1_PREFIX },
  );

  return app;
}
