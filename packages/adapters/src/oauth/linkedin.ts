/**
 * Cliente OAuth de LinkedIn — 3-legged OAuth (`PU-LATER-002`, `D-09`).
 *
 * Endpoints y parámetros con la URL de la documentación oficial, consultada
 * el 2026-09-24:
 *
 *  - https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 *    · Autorización: `GET https://www.linkedin.com/oauth/v2/authorization`
 *      con `response_type=code`, `client_id`, `redirect_uri`, `state` y
 *      `scope` (*"URL-encoded, space-delimited"*).
 *    · Token: `POST https://www.linkedin.com/oauth/v2/accessToken`
 *      form-urlencoded `grant_type=authorization_code`, `code`, `client_id`,
 *      `client_secret`, `redirect_uri` → `access_token`, `expires_in`
 *      (*"all access tokens are issued with a 60-day lifespan"*), `scope`, y
 *      `refresh_token` / `refresh_token_expires_in` sólo si la app tiene
 *      refresh tokens programáticos (*"available for a limited set of
 *      partners"*).
 *  - https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
 *    · Refresco: mismo endpoint, `grant_type=refresh_token`, `refresh_token`,
 *      `client_id`, `client_secret`. Un refresh token inválido o vencido es
 *      `400 invalid_request`.
 *  - Identidad del miembro: `GET https://api.linkedin.com/v2/userinfo` →
 *    `sub`, `name`, `picture` (scopes `openid` + `profile`) —
 *    https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
 *    El Person URN de la Posts API se arma con `sub`: *"See Sign In with
 *    LinkedIn using OpenID Connect to see how to retrieve the Person URN"* —
 *    https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
 *  - Páginas (sólo con los scopes opcionales concedidos):
 *    · `GET https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED`
 *      → `elements[]` con `role`, `state` y `organization` (en otros ejemplos
 *      de la misma página, `organizationTarget`) —
 *      https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role
 *    · Pueden publicar como la Página los roles `ADMINISTRATOR`,
 *      `DIRECT_SPONSORED_CONTENT_POSTER` y `CONTENT_ADMIN` (así en la Posts
 *      API; la página de roles lo llama `CONTENT_ADMINISTRATOR`: se aceptan
 *      los dos) —
 *      https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 *    · Nombre: `GET https://api.linkedin.com/rest/organizationsLookup?ids=List(…)`
 *      → `results[id].localizedName` (*"doesn't require administrator
 *      access"*) —
 *      https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api
 *      **NO VERIFICADO**: que alcance con `r_organization_admin` (la página
 *      lista `rw_organization_admin`). Si falla, la Página se muestra por id.
 *    · Headers de las APIs versionadas: `LinkedIn-Version: YYYYMM` y
 *      `X-Restli-Protocol-Version: 2.0.0` —
 *      https://learn.microsoft.com/en-us/linkedin/marketing/versioning
 *
 * El `platformUserId` que se guarda es el **URN** del autor
 * (`urn:li:person:{sub}` o `urn:li:organization:{id}`): es lo que la Posts API
 * pide en `author`, y distingue perfil de Página sin otra columna.
 */
import type {
  OAuthAuthorizeRequest,
  OAuthClient,
  OAuthCodeExchangeRequest,
  OAuthGrantedAccount,
  OAuthRefreshRequest,
  OAuthTokenSet,
} from "@fastgram/ports";

import {
  OAuthHttp,
  expiresAtFrom,
  num,
  obj,
  splitScopes,
  str,
  type OAuthHttpConfig,
} from "./http.js";

/**
 * La última versión publicada al 2026-09-24 (*"September 2026 · 202609"*) —
 * https://learn.microsoft.com/en-us/linkedin/marketing/versioning . Cada
 * versión se sostiene *"for a minimum of one (1) year"*: es configurable
 * (`PUBLISH_LINKEDIN_VERSION`) para no tocar código cuando venza.
 */
export const LINKEDIN_DEFAULT_VERSION = "202609";

export const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const REST = "https://api.linkedin.com/rest";

/** Roles que la Posts API acepta para `w_organization_social`. */
const POSTING_ROLES = new Set([
  "ADMINISTRATOR",
  "DIRECT_SPONSORED_CONTENT_POSTER",
  "CONTENT_ADMIN",
  "CONTENT_ADMINISTRATOR",
]);

export const LINKEDIN_ORG_SCOPES = ["w_organization_social", "r_organization_admin"];

export interface LinkedInClientConfig extends OAuthHttpConfig {
  readonly now?: () => Date;
  /** `LinkedIn-Version`. Default {@link LINKEDIN_DEFAULT_VERSION}. */
  readonly linkedinVersion?: string;
}

export function linkedinPersonUrn(sub: string): string {
  return `urn:li:person:${sub}`;
}

export class LinkedInOAuthClient implements OAuthClient {
  readonly platform = "linkedin" as const;
  readonly usesPkce = false;
  /** Sólo si la app tiene refresh tokens programáticos; si no, se reconecta. */
  readonly refreshWith = "refresh_token" as const;
  readonly #http: OAuthHttp;
  readonly #now: () => Date;
  readonly #version: string;

  constructor(config: LinkedInClientConfig = {}) {
    this.#http = new OAuthHttp("OAuth/linkedin", config);
    this.#now = config.now ?? (() => new Date());
    this.#version = config.linkedinVersion ?? LINKEDIN_DEFAULT_VERSION;
  }

  authorizeUrl(req: OAuthAuthorizeRequest): string {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: req.credentials.clientId,
      redirect_uri: req.redirectUri,
      state: req.state,
      scope: req.scopes.join(" "),
    });
    return `${LINKEDIN_AUTHORIZE_URL}?${q.toString()}`;
  }

  /** El perfil primero; después, una cuenta por Página que puede publicar. */
  async exchangeCode(req: OAuthCodeExchangeRequest): Promise<OAuthGrantedAccount[]> {
    const body = await this.#http.form(LINKEDIN_TOKEN_URL, {
      grant_type: "authorization_code",
      code: req.code,
      client_id: req.credentials.clientId,
      client_secret: req.credentials.clientSecret,
      redirect_uri: req.redirectUri,
    });
    const tokens = this.#tokenSet(body);
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };

    const me = await this.#http.get(LINKEDIN_USERINFO_URL, {}, auth);
    const sub = str(me, "sub");
    if (sub === undefined) throw this.#http.contract("no sub in userinfo");
    const name = str(me, "name");
    const picture = str(me, "picture");
    const accounts: OAuthGrantedAccount[] = [
      {
        identity: {
          platformUserId: linkedinPersonUrn(sub),
          username: name ?? sub,
          ...(name === undefined ? {} : { displayName: name }),
          ...(picture === undefined ? {} : { avatarUrl: picture }),
        },
        tokens,
      },
    ];

    const granted = tokens.scopes ?? [];
    if (!LINKEDIN_ORG_SCOPES.every((s) => granted.includes(s))) return accounts;
    for (const org of await this.#organizations(auth)) {
      accounts.push({
        identity: { platformUserId: org.urn, username: org.name, displayName: org.name },
        tokens,
      });
    }
    return accounts;
  }

  /**
   * Las Páginas donde el miembro tiene un rol que publica. Un fallo acá **no**
   * tumba la conexión: el perfil ya está autorizado y el `code` ya se gastó.
   */
  async #organizations(
    auth: Record<string, string>,
  ): Promise<{ readonly urn: string; readonly name: string }[]> {
    const headers = {
      ...auth,
      "LinkedIn-Version": this.#version,
      "X-Restli-Protocol-Version": "2.0.0",
    };
    let acls: Record<string, unknown>;
    try {
      acls = await this.#http.get(
        `${REST}/organizationAcls`,
        { q: "roleAssignee", state: "APPROVED" },
        headers,
      );
    } catch {
      return [];
    }
    const elements = Array.isArray(acls["elements"])
      ? (acls["elements"] as unknown[])
      : [];
    const urns: string[] = [];
    for (const el of elements) {
      if (typeof el !== "object" || el === null) continue;
      const e = el as Record<string, unknown>;
      const role = str(e, "role");
      const state = str(e, "state");
      const urn = str(e, "organization") ?? str(e, "organizationTarget");
      if (role === undefined || !POSTING_ROLES.has(role)) continue;
      if (state !== undefined && state !== "APPROVED") continue;
      if (urn === undefined || !urn.startsWith("urn:li:organization:")) continue;
      if (!urns.includes(urn)) urns.push(urn);
    }
    if (urns.length === 0) return [];

    const ids = urns.map((u) => u.slice("urn:li:organization:".length));
    const names = new Map<string, string>();
    try {
      // `List(…)` es sintaxis Rest.li: va sin codificar, como en la doc.
      const lookup = await this.#http.get(
        `${REST}/organizationsLookup?ids=List(${ids.map(encodeURIComponent).join(",")})`,
        {},
        headers,
      );
      const results = obj(lookup, "results") ?? {};
      for (const id of ids) {
        const name = str(obj(results, id) ?? {}, "localizedName");
        if (name !== undefined) names.set(id, name);
      }
    } catch {
      // Sin nombres: se muestran por id (ver la cabecera).
    }
    return urns.map((urn, i) => {
      const id = ids[i] ?? urn;
      return { urn, name: names.get(id) ?? `LinkedIn Page ${id}` };
    });
  }

  async refresh(req: OAuthRefreshRequest): Promise<OAuthTokenSet> {
    if (req.refreshToken === undefined) throw this.#http.contract("no refresh token");
    const body = await this.#http.form(LINKEDIN_TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: req.refreshToken,
      client_id: req.credentials.clientId,
      client_secret: req.credentials.clientSecret,
    });
    return this.#tokenSet(body);
  }

  #tokenSet(body: Record<string, unknown>): OAuthTokenSet {
    const now = this.#now();
    const accessToken = str(body, "access_token");
    if (accessToken === undefined) throw this.#http.contract("no access_token");
    const refreshToken = str(body, "refresh_token");
    const scopes = splitScopes(str(body, "scope"));
    const refreshIn = num(body, "refresh_token_expires_in");
    return {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      expiresAt: expiresAtFrom(now, num(body, "expires_in")),
      ...(refreshIn === undefined
        ? {}
        : { refreshExpiresAt: expiresAtFrom(now, refreshIn) }),
      ...(scopes === undefined ? {} : { scopes }),
    };
  }
}
