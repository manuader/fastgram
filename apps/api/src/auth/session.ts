/**
 * Sesiones de usuario — `P1-AUTH-002`, PRD §9.1, §15.2, ADR-008.
 *
 * ## Cómo llega una sesión hasta acá
 *
 * `apps/web` es un BFF. La API emite el token de sesión **sólo** en el cuerpo de
 * `POST /auth/signup|login`, al servidor web; éste lo guarda en una cookie
 * httpOnly **suya** y lo reenvía en el header `X-Fastgram-Session`.
 *
 * Este módulo lee **sólo** ese header. Nunca cookies: si la API aceptara la
 * cookie, cualquier página que el navegador visite podría disparar peticiones
 * autenticadas contra la API (CSRF), y la cookie de sesión dejaría de ser
 * "de la web" para ser de cualquiera que conozca el nombre.
 *
 * ## Del token al workspace
 *
 *  1. `verifySessionToken` (Better Auth): firma, vencimiento, fila viva.
 *     → `userId` = `users.id`.
 *  2. `resolveSessionWorkspace` (`@fastgram/db`, migración `0012`): el
 *     `default_workspace_id` si es una membresía activa; si no, la membresía
 *     activa más vieja. `null` si no tiene ninguna.
 *
 * El paso 2 **no crea** workspaces: sin membresía, la sesión es válida y el
 * `companyId` es `null`. `GET /auth/session` lo devuelve así (el BFF manda al
 * onboarding); las rutas de negocio responden `403 forbidden` (ver `app.ts`).
 */
import type { AuthorizationResult, IdentityPrincipal } from "@fastgram/ports";
import { isPortError } from "@fastgram/ports";
import { resolveSessionWorkspace, withoutCompany, type Database } from "@fastgram/db";

/** En minúsculas: así los expone Node en `request.headers`. */
export const SESSION_HEADER = "x-fastgram-session";

/**
 * Lo que `apps/api` usa del proveedor de identidad.
 *
 * Un subconjunto estructural de `BetterAuthIdentity` y no el puerto `Identity`:
 * el puerto no modela email/contraseña (ver el reporte de `P1-AUTH-001`). Tener
 * la interfaz acá permite testear las rutas contra un doble **sin** que el doble
 * tenga que implementar SSO, que nadie llama.
 */
export interface AuthIdentity {
  signUpWithPassword(request: {
    readonly email: string;
    readonly password: string;
    readonly fullName: string;
  }): Promise<AuthorizationResult>;
  signInWithPassword(request: {
    readonly email: string;
    readonly password: string;
  }): Promise<AuthorizationResult>;
  verifySessionToken(sessionToken: string): Promise<IdentityPrincipal>;
  revokeSession(sessionId: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  completePasswordReset(request: {
    readonly token: string;
    readonly newPassword: string;
  }): Promise<void>;
}

export type SessionResolution =
  /** No vino el header: no hay sesión que resolver. */
  | { readonly kind: "absent" }
  /** Vino y no vale: basura, vencido, revocado, usuario borrado. Todo igual. */
  | { readonly kind: "invalid" }
  /**
   * No se pudo comprobar (base caída, proveedor roto). **No** es `invalid`:
   * responder 401 le diría al BFF que tire una sesión que puede estar viva.
   * `reason` va al log, nunca al cuerpo, y nunca lleva el token.
   */
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "valid";
      readonly principal: IdentityPrincipal;
      /** `null` = sesión válida sin ningún workspace activo. */
      readonly companyId: string | null;
    };

export interface SessionResolver {
  resolve(request: {
    readonly headers: Record<string, string | string[] | undefined>;
  }): Promise<SessionResolution>;
}

/** Default honesto cuando la identidad no está configurada: nunca hay sesión. */
export const noSessionResolver: SessionResolver = {
  resolve: async () => ({ kind: "absent" }),
};

/**
 * El valor del header, o `null` si no vino.
 *
 * Repetido (`string[]`) cuenta como inválido y no como "el primero": dos
 * valores distintos del mismo header son una petición que alguien armó, no una
 * que armó nuestro BFF, y elegir uno sería decidir por el atacante.
 */
export function readSessionHeader(
  headers: Record<string, string | string[] | undefined>,
):
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly token: string }
  | {
      readonly kind: "malformed";
    } {
  const raw = headers[SESSION_HEADER];
  if (raw === undefined) return { kind: "absent" };
  if (Array.isArray(raw)) return { kind: "malformed" };
  const token = raw.trim();
  if (token === "") return { kind: "absent" };
  return { kind: "present", token };
}

export interface SessionResolverOptions {
  readonly identity: Pick<AuthIdentity, "verifySessionToken">;
  readonly db: Database;
}

export function createSessionResolver(options: SessionResolverOptions): SessionResolver {
  return {
    async resolve({ headers }) {
      const header = readSessionHeader(headers);
      if (header.kind === "absent") return { kind: "absent" };
      if (header.kind === "malformed") return { kind: "invalid" };

      let principal: IdentityPrincipal;
      try {
        principal = await options.identity.verifySessionToken(header.token);
      } catch (error) {
        if (isPortError(error) && error.code === "unauthorized") {
          return { kind: "invalid" };
        }
        return { kind: "unavailable", reason: describeFailure(error) };
      }

      // `withoutCompany`: el `companyId` es lo que se está averiguando. La
      // consulta es por `userId`, que acaba de salir de una firma verificada —
      // nunca de algo que mandó el cliente. Ver `session-workspace.ts`.
      let companyId: string | null;
      try {
        companyId = await withoutCompany(options.db, (tx) =>
          resolveSessionWorkspace(tx, principal.userId),
        );
      } catch (error) {
        return { kind: "unavailable", reason: describeFailure(error) };
      }

      return { kind: "valid", principal, companyId };
    },
  };
}

/**
 * Qué falló, para el log. Sólo código y mensaje del `PortError` (que el
 * adaptador ya neutralizó) o el nombre del error: el objeto entero podría
 * arrastrar la petición que lo causó, y esa petición lleva el token.
 */
function describeFailure(error: unknown): string {
  if (isPortError(error)) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.name;
  return "unknown";
}
