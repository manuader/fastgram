/**
 * El token de una conexión, listo para publicar: se descifra y, si está por
 * vencer, se refresca antes — `PU-PUB-001`, `P3-OAUTH-008`, PRD §19.5.
 *
 * Es la función que usa el publisher (`getAccessToken(connectionId)` del
 * brief): el worker la llama con el `ConnectionTokenStore` de `@fastgram/db`
 * **dentro de una transacción** (el `load` bloquea la fila; ver el puerto) y
 * con el cifrado, los clientes y las credenciales de `@fastgram/adapters`.
 *
 * ## Cuándo una conexión pasa a `expired`
 *
 * Sólo cuando la plataforma **rechaza** el refresco (`unauthorized` /
 * `bad_request`: el usuario revocó el acceso, el refresh token venció) o el
 * token ya venció y no hay forma de refrescarlo. Un fallo transitorio
 * (timeout, 5xx, rate limit) **no** la marca: con el token todavía vigente se
 * sigue usando, y si ya venció se reporta `refresh_failed` para reintentar.
 * Marcar `expired` por un corte de red obligaría al usuario a reconectar
 * cuentas sanas (ERR-D01 sin motivo).
 */
import {
  PortError,
  isOAuthPlatform,
  isPortError,
  type ConnectionTokenStore,
  type IntegrationStore,
  type OAuthClient,
  type OAuthPlatform,
  type OAuthTokenSet,
  type StoredConnectionTokens,
  type TokenCipher,
} from "@fastgram/ports";

import { isIntegrationConfigured } from "./integrations.js";
import { OAUTH_PLATFORM_SPECS, type OAuthPlatformSpec } from "./platforms.js";

export type ConnectionTokenFailure =
  /** No existe o es de otra marca (el 404 de §9.2). */
  | "not_found"
  /** `paused` / `revoked` / `expired`: hay que reconectar (post → `AWAITING_RECONNECT`). */
  | "inactive"
  /** Venció y la plataforma no deja refrescar: se marcó `expired`. */
  | "expired"
  /** Hay que refrescar y faltan las credenciales de la app. */
  | "integration_not_configured"
  /** Fallo transitorio refrescando un token ya vencido. Reintentable. */
  | "refresh_failed"
  /** La plataforma no tiene cliente OAuth (YouTube, LinkedIn, Reddit). */
  | "unsupported_platform";

export class ConnectionTokenError extends Error {
  override readonly name = "ConnectionTokenError";
  constructor(
    readonly reason: ConnectionTokenFailure,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

export function isConnectionTokenError(e: unknown): e is ConnectionTokenError {
  return e instanceof ConnectionTokenError;
}

export type RefreshDecision = "not_needed" | "due" | "too_young";

/** Si hay que refrescar ahora. Sin vencimiento conocido, no. */
export function refreshDecision(
  row: Pick<StoredConnectionTokens, "tokenExpiry" | "tokenIssuedAt">,
  spec: Pick<OAuthPlatformSpec, "refreshMarginMs" | "minTokenAgeForRefreshMs">,
  now: Date,
): RefreshDecision {
  if (row.tokenExpiry === null) return "not_needed";
  if (row.tokenExpiry.getTime() - spec.refreshMarginMs > now.getTime())
    return "not_needed";
  if (
    spec.minTokenAgeForRefreshMs > 0 &&
    row.tokenIssuedAt !== null &&
    now.getTime() - row.tokenIssuedAt.getTime() < spec.minTokenAgeForRefreshMs
  ) {
    return "too_young";
  }
  return "due";
}

export function tokenStillValid(
  row: Pick<StoredConnectionTokens, "tokenExpiry">,
  now: Date,
): boolean {
  return row.tokenExpiry === null || row.tokenExpiry.getTime() > now.getTime();
}

export interface ResolveAccessTokenDeps {
  readonly store: ConnectionTokenStore;
  readonly cipher: TokenCipher;
  readonly clients: Readonly<Partial<Record<OAuthPlatform, OAuthClient>>>;
  readonly integrations: IntegrationStore;
  readonly now: () => Date;
}

export interface ResolvedAccessToken {
  /** En claro. Nunca se loguea ni se devuelve por la API (`NFR-007`). */
  readonly accessToken: string;
  readonly platform: OAuthPlatform;
  readonly expiresAt: Date | null;
  readonly refreshed: boolean;
}

export async function resolveAccessToken(
  deps: ResolveAccessTokenDeps,
  input: {
    readonly companyId: string;
    readonly connectionId: string;
    /** Refrescar aunque no toque (el botón «Refresh» de la pantalla). */
    readonly force?: boolean;
  },
): Promise<ResolvedAccessToken> {
  const { store, cipher } = deps;
  const now = deps.now();
  const row = await store.load(input.companyId, input.connectionId);
  if (row === null) throw new ConnectionTokenError("not_found", "connection not found");
  if (row.status !== "active") {
    throw new ConnectionTokenError("inactive", `connection is ${row.status}`);
  }
  if (!isOAuthPlatform(row.platform)) {
    throw new ConnectionTokenError(
      "unsupported_platform",
      "platform has no OAuth client",
    );
  }
  const platform = row.platform;
  const expire = async (
    reason: string,
    message: string,
    cause?: unknown,
  ): Promise<never> => {
    await store.markExpired(input.companyId, input.connectionId, reason);
    throw new ConnectionTokenError(
      "expired",
      message,
      cause === undefined ? undefined : { cause },
    );
  };
  if (row.accessToken === null) return expire("token_missing", "connection has no token");

  const current = async (): Promise<ResolvedAccessToken> => ({
    accessToken: await cipher.decrypt(row.accessToken as string),
    platform,
    expiresAt: row.tokenExpiry,
    refreshed: false,
  });

  const spec = OAUTH_PLATFORM_SPECS[platform];
  const valid = tokenStillValid(row, now);
  const decision = input.force === true ? "due" : refreshDecision(row, spec, now);
  if (decision === "not_needed") return current();
  if (decision === "too_young") {
    return valid ? current() : expire("token_expired", "token expired");
  }

  const client = deps.clients[platform];
  const canRefresh =
    client !== undefined &&
    (client.refreshWith === "access_token" ||
      (client.refreshWith === "refresh_token" && row.refreshToken !== null)) &&
    (row.refreshTokenExpiry === null || row.refreshTokenExpiry.getTime() > now.getTime());
  if (!canRefresh || client === undefined) {
    return valid
      ? current()
      : expire("token_expired", "token expired and cannot be refreshed");
  }

  const snapshot = await deps.integrations.read();
  const app = snapshot.apps[platform];
  if (
    !isIntegrationConfigured(app) ||
    app === undefined ||
    app.clientSecret === undefined
  ) {
    if (valid) return current();
    throw new ConnectionTokenError(
      "integration_not_configured",
      "the developer app credentials are missing",
    );
  }

  const accessToken = await cipher.decrypt(row.accessToken);
  const refreshToken =
    row.refreshToken === null ? undefined : await cipher.decrypt(row.refreshToken);

  let fresh: OAuthTokenSet;
  try {
    fresh = await client.refresh({
      credentials: { clientId: app.clientId, clientSecret: app.clientSecret },
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
    });
  } catch (error) {
    const rejected =
      isPortError(error) &&
      (error.code === "unauthorized" || error.code === "bad_request");
    if (rejected)
      return expire("refresh_rejected", "the platform rejected the refresh", error);
    if (valid)
      return { accessToken, platform, expiresAt: row.tokenExpiry, refreshed: false };
    throw new ConnectionTokenError("refresh_failed", "refresh failed", { cause: error });
  }

  await store.saveTokens(input.companyId, input.connectionId, {
    accessToken: await cipher.encrypt(fresh.accessToken),
    ...(fresh.refreshToken === undefined
      ? {}
      : { refreshToken: await cipher.encrypt(fresh.refreshToken) }),
    tokenExpiry: fresh.expiresAt,
    ...(fresh.refreshExpiresAt === undefined
      ? {}
      : { refreshTokenExpiry: fresh.refreshExpiresAt }),
    tokenIssuedAt: now,
  });
  return {
    accessToken: fresh.accessToken,
    platform,
    expiresAt: fresh.expiresAt,
    refreshed: true,
  };
}

/* ------------------------------------------------------------------------ *
 * El puerto `ConnectionTokens` (`packages/ports/src/connection-tokens.ts`)
 * ------------------------------------------------------------------------ */

/**
 * Corre `fn` con un `ConnectionTokenStore` **dentro de una transacción** con
 * la marca seteada (en el worker: `withCompany(db, companyId, tx =>
 * fn(connectionTokenStore(tx)))`). Lo que `fn` devuelve, la transacción lo
 * confirma.
 */
export type WithConnectionTokenStore = <T>(
  companyId: string,
  fn: (store: ConnectionTokenStore) => Promise<T>,
) => Promise<T>;

export interface ConnectionTokensDeps extends Omit<ResolveAccessTokenDeps, "store"> {
  readonly withStore: WithConnectionTokenStore;
}

/** `ConnectionTokenError` → el `PortError` que el puerto `ConnectionTokens` promete. */
export function toConnectionTokenPortError(error: ConnectionTokenError): PortError {
  const source = "ConnectionTokens/core";
  switch (error.reason) {
    case "not_found":
      return new PortError("not_found", "connection not found", { source });
    case "refresh_failed": {
      const cause = error.cause;
      const code =
        isPortError(cause) && (cause.code === "timeout" || cause.code === "rate_limited")
          ? cause.code
          : "provider_unavailable";
      return new PortError(code, "the token could not be refreshed", { source });
    }
    case "unsupported_platform":
      return new PortError("bad_request", "platform has no OAuth client", { source });
    // `inactive`, `expired`, `integration_not_configured`: hay que reconectar
    // (o cargar las credenciales) → el post va a `AWAITING_RECONNECT`.
    default:
      return new PortError(
        "unauthorized",
        `connection needs reconnect (${error.reason})`,
        {
          source,
        },
      );
  }
}

/**
 * Implementación de `ConnectionTokens.getAccessToken(connectionId, scope)`.
 *
 * El error de dominio se **devuelve** desde dentro de la transacción y se
 * lanza afuera: si se lanzara adentro, el rollback se llevaría el
 * `markExpired`, y la conexión que la plataforma rechazó seguiría `active`
 * para el próximo intento.
 */
export function createConnectionTokens(deps: ConnectionTokensDeps): {
  getAccessToken(
    connectionId: string,
    scope: { readonly companyId: string },
  ): Promise<string>;
} {
  return {
    async getAccessToken(connectionId, scope) {
      const outcome = await deps.withStore(scope.companyId, async (store) => {
        try {
          const r = await resolveAccessToken(
            { ...deps, store },
            { companyId: scope.companyId, connectionId },
          );
          return { ok: true as const, token: r.accessToken };
        } catch (error) {
          if (isConnectionTokenError(error)) return { ok: false as const, error };
          throw error;
        }
      });
      if (!outcome.ok) throw toConnectionTokenPortError(outcome.error);
      return outcome.token;
    },
  };
}
