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
import { WORKSPACE_HEADER, type FastgramMode } from "@fastgram/contracts";
import {
  resolveApiKeyByHash,
  withCompany,
  withoutCompany,
  workspaceDirectory,
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
  /**
   * La company de la credencial, **antes** del header de marca.
   *
   * Es igual a `companyId` salvo en modo personal con `X-Fastgram-Workspace`, donde
   * `companyId` pasa a ser la marca elegida. Hace falta para lo único que no se
   * puede hacer sobre la marca elegida: borrar la marca a la que pertenece la key
   * (ver `routes/v1/workspaces.ts`).
   */
  readonly homeCompanyId?: string;
}

export type ScopeResolution =
  | { readonly ok: true; readonly auth: AuthContext }
  | { readonly ok: false; readonly reason: ApiKeyRejection }
  /**
   * La credencial es válida pero el `X-Fastgram-Workspace` no es una marca viva del
   * mismo dueño (no existe, es de otro, está borrada o no es un uuid). **404, no
   * 401 ni 403**: la credencial sirve, lo que no está es el recurso, y §9.2 manda
   * no distinguir "ajeno" de "inexistente".
   */
  | { readonly ok: false; readonly reason: "workspace_not_found" };

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
  /**
   * `PU-BRAND-001`. Sólo en `personal` se lee `X-Fastgram-Workspace`; en
   * `standard` (y ausente) el header se ignora por completo, ni siquiera se valida.
   */
  readonly mode?: FastgramMode;
}

/**
 * Traduce credenciales → `AuthContext`, y después aplica la marca elegida.
 *
 * El header de marca se aplica **acá** y no en cada ruta a propósito: todo lo que
 * scopea por `companyId` —las ~30 rutas, `request.tx`, el rate limit, el log—
 * toma el valor de `request.auth.companyId`, así que cambiarlo en este único punto
 * vuelve multimarca a la API entera sin tocar una ruta.
 */
export async function resolveScope(
  options: ScopeResolverOptions,
  headers: Record<string, string | string[] | undefined>,
): Promise<ScopeResolution> {
  const base = await resolveCredential(options, headers);
  if (!base.ok || options.mode !== "personal") return base;
  return applyWorkspaceHeader(options.db, base.auth, headers);
}

/**
 * Traduce credenciales → `AuthContext`.
 *
 * Orden: API key primero (es el camino de la API pública), sesión después. Un
 * `Authorization` presente pero inválido **no** cae a la sesión: sería una forma
 * silenciosa de que una key revocada siga funcionando desde un browser con cookie.
 */
async function resolveCredential(
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `X-Fastgram-Workspace` — la marca sobre la que opera la request (modo personal).
 *
 * - Ausente o vacío → la company de la credencial, como siempre.
 * - Igual a la de la credencial → nada que consultar.
 * - No-uuid → `404` sin tocar la base (un no-uuid haría fallar el cast de
 *   `app.current_company()` más abajo con un 500).
 * - Un uuid que no es una marca viva del **mismo dueño** → `404`.
 *
 * La consulta cruza companies, así que corre sin scope de tenant y con el rol de
 * la conexión: ver la cabecera de `workspace-directory.ts` en `@fastgram/db`.
 */
async function applyWorkspaceHeader(
  db: Database,
  auth: AuthContext,
  headers: Record<string, string | string[] | undefined>,
): Promise<ScopeResolution> {
  const raw = headers[WORKSPACE_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const home = { ...auth, homeCompanyId: auth.companyId };

  if (value === "" || value.toLowerCase() === auth.companyId.toLowerCase()) {
    return { ok: true, auth: home };
  }
  if (!UUID_RE.test(value)) return { ok: false, reason: "workspace_not_found" };

  const target = await withoutCompany(db, async (tx) => {
    const owner = await ownerOrFail(tx, auth.companyId);
    return workspaceDirectory.find(tx, owner, value);
  });
  if (target === null) return { ok: false, reason: "workspace_not_found" };

  return { ok: true, auth: { ...home, companyId: target.id } };
}

/**
 * El dueño de la company de la credencial, o un error **ruidoso**.
 *
 * Esa company acaba de autenticar, así que existe: si no se ve es que la conexión
 * no puede saltear RLS (`fastgram_app`), y devolver `null` convertiría cada
 * marca en un 404 sin ninguna pista. Ver `workspace-directory.ts`.
 */
export async function ownerOrFail(
  tx: Transaction,
  companyId: string,
): Promise<{ ownerUserId: string; timezone: string; billingAnchorDay: number }> {
  const owner = await workspaceDirectory.ownerOf(tx, companyId);
  if (owner === null) {
    throw new Error(
      "No se pudo leer la company de la credencial para resolver sus marcas. Casi " +
        "siempre es que la conexión a Postgres no saltea RLS (rol `fastgram_app`): " +
        "el modo personal necesita la conexión de desarrollo. Ver " +
        "packages/db/src/repositories/workspace-directory.ts.",
    );
  }
  return owner;
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
