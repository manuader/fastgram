/**
 * Resolución de scope — P1-API-007 · PRD §9.1 y §9.2.
 *
 * **Toda** ruta de `/api/v1` pasa por acá. La regla no admite excepciones: nada toca
 * la base sin un `companyId` resuelto, y ese `companyId` viaja a la transacción como
 * `app.current_company` para que RLS se aplique de verdad.
 *
 * ## Las dos capas, y por qué las dos
 *
 * 1. **RLS** (`withCompany` → `SET LOCAL app.current_company`). Protege incluso al SQL
 *    escrito a mano y al repositorio nuevo que se olvidó del `WHERE`.
 * 2. **Los repositorios de `@fastgram/db`**, que no tienen `findById(id)` sin
 *    `TenantScope`: olvidarse del `companyId` no compila.
 *
 * Son redundantes a propósito. La de abajo falla cerrado: sin GUC,
 * `app.current_company()` es NULL, `company_id = NULL` no es TRUE, y no se ve nada.
 *
 * ## La única consulta de este servicio que no pasa por un repositorio
 *
 * Buscar la API key por su hash es el **bootstrap**: todavía no sabemos de qué
 * workspace es, así que no existe un `companyId` que pasarle a un repositorio — esta
 * consulta lo *produce*. Ningún repositorio acepta ausencia de scope, y es correcto
 * que no lo acepte.
 *
 * Por eso es también la única consulta donde **no hay condición de tenant que olvidar**:
 * el riesgo que la regla "sólo repositorios" existe para evitar (que una ruta arme su
 * propio `and(eq(id), eq(companyId))` y se saltee la segunda mitad) aquí no aplica.
 *
 * Se usa la *relational query API* de Drizzle, que entrega los operadores por callback
 * y no necesita importar `drizzle-orm` — que además no es alcanzable desde `apps/api`.
 *
 * **Lo que falta en `packages/db` para cerrar esto:** `apiKeyRepository.findByHash(exec,
 * hash)`, deliberadamente sin scope y documentado como el bootstrap. El día que exista,
 * esta función se reduce a llamarla.
 *
 * ## El agujero de producción, escrito para que se vea
 *
 * Esta consulta corre con `withoutCompany` y **sin** `SET LOCAL ROLE`, o sea con el rol
 * de la conexión (en desarrollo, superusuario, que saltea RLS). En producción, donde la
 * conexión debería ser `fastgram_app` (NOSUPERUSER, y `api_keys` tiene `FORCE ROW LEVEL
 * SECURITY`), devolvería **cero filas y toda la API respondería 401**.
 *
 * Eso no se arregla desde `apps/api`: necesita una función `SECURITY DEFINER` que
 * resuelva `hash → companyId`, o una política sobre `api_keys` que permita la lectura
 * por hash sin scope. Queda anotado acá y en el reporte porque el síntoma —todo 401 en
 * producción, todo verde en local— no se deduce leyendo este archivo.
 */
import type { Clock } from "@fastgram/ports";
import {
  resolveApiKeyByHash,
  withCompany,
  withoutCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";

import { extractBearerToken, hashApiKey, type ApiKeyRejection } from "./api-keys.js";

/** Quién pide, y sobre qué workspace. Es lo único que autoriza tocar datos. */
export interface AuthContext {
  readonly companyId: string;
  readonly kind: "api_key" | "session";
  /** Sólo con API key. Va al log. */
  readonly apiKeyId?: string;
  readonly apiKeyKind?: "workspace" | "partner";
  /** Sólo con sesión de usuario. */
  readonly userId?: string;
}

export type ScopeResolution =
  | { readonly ok: true; readonly auth: AuthContext }
  | { readonly ok: false; readonly reason: ApiKeyRejection };

/**
 * Sesiones de usuario (`apps/web`).
 *
 * Interfaz y no implementación porque el backend de sesión todavía no existe: ADR-008
 * elige Better Auth self-hosted y esa tarea es de otra épica. La costura queda
 * declarada para que montarla sea inyectar, no reescribir el middleware.
 */
export interface SessionResolver {
  resolve(request: {
    readonly headers: Record<string, string | string[] | undefined>;
  }): Promise<{ userId: string; companyId: string } | null>;
}

/** Default honesto: no hay sesiones todavía, así que no hay sesión que resolver. */
export const noSessionResolver: SessionResolver = {
  resolve: async () => null,
};

export interface ScopeResolverOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly sessions?: SessionResolver;
}

/**
 * Traduce credenciales → `AuthContext`.
 *
 * Orden: API key primero (es el camino de la API pública), sesión después. Un
 * `Authorization` presente pero inválido **no** cae a la sesión: sería una forma
 * silenciosa de que una key revocada siga funcionando desde un browser con cookie.
 */
export async function resolveScope(
  options: ScopeResolverOptions,
  headers: Record<string, string | string[] | undefined>,
): Promise<ScopeResolution> {
  const rawAuth = headers["authorization"];
  const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;

  if (authHeader !== undefined && authHeader.trim() !== "") {
    return resolveApiKey(options, authHeader);
  }

  const session = await (options.sessions ?? noSessionResolver).resolve({ headers });
  if (session !== null) {
    return {
      ok: true,
      auth: { companyId: session.companyId, kind: "session", userId: session.userId },
    };
  }

  return { ok: false, reason: "missing_header" };
}

async function resolveApiKey(
  options: ScopeResolverOptions,
  authHeader: string,
): Promise<ScopeResolution> {
  const extracted = extractBearerToken(authHeader);
  if (!extracted.ok) return { ok: false, reason: extracted.reason };

  const hash = hashApiKey(extracted.token);

  // Una sola ida, y por `app.resolve_api_key`: ver la nota de la cabecera.
  // El rol de producción no puede leer `api_keys` directo.
  const key = await withoutCompany(options.db, (tx) => resolveApiKeyByHash(tx, hash));

  if (key === null) return { ok: false, reason: "no_match" };

  // FR-180 acceptance (2): *"Revocar invalida en el acto"*. Sin caché entre el UPDATE
  // y el próximo request: el chequeo es sobre la fila, en cada request.
  if (key.revokedAt !== null) return { ok: false, reason: "revoked" };

  if (key.expiresAt !== null && key.expiresAt.getTime() <= options.clock.nowMs()) {
    return { ok: false, reason: "expired" };
  }

  // PRD:1867 — workspace soft-deleted es causa de 401, no de 404: la credencial dejó
  // de ser válida, no es que el recurso no esté.
  if (key.companyStatus === "soft_deleted") {
    return { ok: false, reason: "workspace_soft_deleted" };
  }

  return {
    ok: true,
    auth: {
      companyId: key.companyId,
      kind: "api_key",
      apiKeyId: key.apiKeyId,
      apiKeyKind: key.kind,
    },
  };
}

/**
 * Abre la transacción con el scope puesto.
 *
 * `role` es lo que hace que RLS deje de ser decorativo cuando la conexión es
 * superusuario (desarrollo y tests). Ver `env.ts` → `DATABASE_APP_ROLE`.
 */
export function runScoped<T>(
  db: Database,
  companyId: string,
  appRole: string | undefined,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withCompany(
    db,
    companyId,
    fn,
    appRole === undefined || appRole === "" ? {} : { role: appRole },
  );
}
