/**
 * Ampliación de los tipos de Fastify y contrato de dependencias.
 *
 * `request.auth` y `request.tx` se declaran **no opcionales** a propósito: dentro de
 * `/api/v1` el hook de scope corre antes que cualquier handler, así que si están
 * ausentes el bug es de montaje, no del handler. Declararlos opcionales obligaría a
 * cada una de las ~30 rutas a comprobar algo que no puede pasar, y esa comprobación
 * repetida es ruido que esconde las comprobaciones que sí importan.
 *
 * Fuera de `/api/v1` (por ejemplo `/health`) no existen, y por eso `/health` no los toca.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyBaseLogger, FastifyInstance, RawServerDefault } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Clock, Queue, Storage } from "@fastgram/ports";
import type { Database, Transaction } from "@fastgram/db";

/**
 * La instancia con el type provider de Zod puesto.
 *
 * Sin este alias, `registerXRoutes(app: FastifyInstance)` pierde el provider y
 * `request.body` / `request.query` vuelven a ser `unknown`: los schemas de
 * `@fastgram/contracts` seguirían validando en runtime, pero el handler dejaría de
 * saber qué recibió y el compilador no podría avisar de un campo mal escrito.
 */
export type ZodApp = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

import type { IdempotencyGuard } from "../http/idempotency.js";
import type { TokenBucketLimiter } from "../http/rate-limit.js";
import type { AuthContext, SessionResolver } from "../auth/scope.js";

/**
 * Generador de ángulos (AI-005).
 *
 * Es opcional y no hay implementación por defecto: `POST /blitz/angles/generate`
 * necesita un LLM y ese adaptador todavía no existe. Sin él la ruta responde
 * `503 service_unavailable`, que es un código del PRD, en vez de inventar sugerencias.
 */
export interface AngleGenerator {
  generate(input: { readonly companyId: string }): Promise<{
    title: string;
    description: string;
    targetAudience: string;
    brandRevision: number;
  }>;
}

export interface ApiDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly storage: Storage;
  readonly limiter: TokenBucketLimiter;
  readonly idempotency: IdempotencyGuard;
  /** Ver `env.ts` → `DATABASE_APP_ROLE`. Sin esto RLS no se aplica. */
  readonly appRole: string | undefined;
  readonly sessions?: SessionResolver;
  readonly angleGenerator?: AngleGenerator;
  /**
   * Cola de trabajos (`ADR-005`).
   *
   * Opcional por la misma razón que `angleGenerator`: se monta donde hay Postgres y
   * los tests de ruta no lo necesitan. Pero la consecuencia es distinta y conviene
   * decirla — una ruta que crea contenido en `BUILDING` **sin** encolar el build deja
   * la fila colgada para siempre, y eso es peor que fallar. Sin esta dependencia esas
   * rutas responden `503 service_unavailable`; no crean la fila.
   */
  readonly queue?: Queue;
  /**
   * Esquema de pg-boss (`QUEUE_SCHEMA`). Sólo lo usa la sonda de `/health`.
   *
   * Está acá y no dentro de `queue` porque el puerto `Queue` no expone su
   * esquema —ni tiene por qué: es un detalle del adaptador de pg-boss— y
   * `packages/ports` no se toca desde esta tarea. Sin este dato la sonda de la
   * cola sólo puede decir si está montada; con él comprueba además que el rol de
   * la aplicación vea las tablas, que es el fallo real que describe
   * `packages/db/src/queue-grants.ts`. Ver `server/health.ts`.
   */
  readonly queueSchema?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Quién pide y sobre qué workspace. Lo pone el hook de scope. */
    auth: AuthContext;
    /**
     * Abre una transacción con `app.current_company` seteado.
     * **Es el único camino soportado** para tocar tablas de cliente desde una ruta.
     */
    tx: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  }

  interface FastifyInstance {
    deps: ApiDeps;
  }
}
