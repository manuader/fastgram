/**
 * Clientes OAuth de TikTok (Login Kit, para Content Posting API **Upload**,
 * `D-10`) y de X (OAuth 2.0 con PKCE) — `P3-OAUTH-002`, `D-09`.
 *
 * Endpoints y parámetros con la URL de la documentación oficial,
 * consultada el 2026-09-24.
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

export interface TikTokXClientConfig extends OAuthHttpConfig {
  readonly now?: () => Date;
}

/* ------------------------------------------------------------------------ *
 * TikTok
 * Autorización: https://developers.tiktok.com/doc/login-kit-web
 * Token y refresh: https://developers.tiktok.com/doc/oauth-user-access-token-management
 * Identidad: https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info
 * ------------------------------------------------------------------------ */

const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

export class TikTokOAuthClient implements OAuthClient {
  readonly platform = "tiktok" as const;
  /** *"`code_verifier` — Required for mobile and desktop app only"*: la web no lo usa. */
  readonly usesPkce = false;
  readonly refreshWith = "refresh_token" as const;
  readonly #http: OAuthHttp;
  readonly #now: () => Date;

  constructor(config: TikTokXClientConfig = {}) {
    this.#http = new OAuthHttp("OAuth/tiktok", config);
    this.#now = config.now ?? (() => new Date());
  }

  authorizeUrl(req: OAuthAuthorizeRequest): string {
    const q = new URLSearchParams({
      client_key: req.credentials.clientId,
      // *"A comma (,) separated string of authorization scope(s)"*.
      scope: req.scopes.join(","),
      redirect_uri: req.redirectUri,
      state: req.state,
      response_type: "code",
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${q.toString()}`;
  }

  async exchangeCode(req: OAuthCodeExchangeRequest): Promise<OAuthGrantedAccount[]> {
    const body = await this.#http.form(TIKTOK_TOKEN_URL, {
      client_key: req.credentials.clientId,
      client_secret: req.credentials.clientSecret,
      code: req.code,
      grant_type: "authorization_code",
      redirect_uri: req.redirectUri,
    });
    this.#http.rejectIfError(body);
    const tokens = this.#tokenSet(body);
    const openId = str(body, "open_id");

    // `GET https://open.tiktokapis.com/v2/user/info/?fields=…` con Bearer.
    // `open_id`, `avatar_url`, `display_name` son de `user.info.basic`.
    const info = await this.#http.get(
      "https://open.tiktokapis.com/v2/user/info/",
      { fields: "open_id,avatar_url,display_name" },
      { Authorization: `Bearer ${tokens.accessToken}` },
    );
    // `error.code` vale `"ok"` en una respuesta exitosa.
    this.#http.rejectIfError(info, ["ok"]);
    const user = obj(obj(info, "data"), "user") ?? {};
    const id = str(user, "open_id") ?? openId;
    if (id === undefined) throw this.#http.contract("no open_id");
    const displayName = str(user, "display_name");
    const avatarUrl = str(user, "avatar_url");
    return [
      {
        identity: {
          platformUserId: id,
          // El `username` pide `user.info.profile`, que no se pide (ver platforms.ts).
          username: displayName ?? id,
          ...(displayName === undefined ? {} : { displayName }),
          ...(avatarUrl === undefined ? {} : { avatarUrl }),
        },
        tokens,
      },
    ];
  }

  async refresh(req: OAuthRefreshRequest): Promise<OAuthTokenSet> {
    if (req.refreshToken === undefined) throw this.#http.contract("no refresh token");
    const body = await this.#http.form(TIKTOK_TOKEN_URL, {
      client_key: req.credentials.clientId,
      client_secret: req.credentials.clientSecret,
      grant_type: "refresh_token",
      refresh_token: req.refreshToken,
    });
    this.#http.rejectIfError(body);
    return this.#tokenSet(body);
  }

  #tokenSet(body: Record<string, unknown>): OAuthTokenSet {
    const now = this.#now();
    const accessToken = str(body, "access_token");
    if (accessToken === undefined) throw this.#http.contract("no access_token");
    const refreshToken = str(body, "refresh_token");
    const scopes = splitScopes(str(body, "scope"));
    return {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      expiresAt: expiresAtFrom(now, num(body, "expires_in")),
      refreshExpiresAt: expiresAtFrom(now, num(body, "refresh_expires_in")),
      ...(scopes === undefined ? {} : { scopes }),
    };
  }
}

/* ------------------------------------------------------------------------ *
 * X — OAuth 2.0 Authorization Code con PKCE
 * https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
 * https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
 * Identidad: https://docs.x.com/x-api/users/get-my-user
 * ------------------------------------------------------------------------ */

const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";

export class XOAuthClient implements OAuthClient {
  readonly platform = "x" as const;
  readonly usesPkce = true;
  readonly refreshWith = "refresh_token" as const;
  readonly #http: OAuthHttp;
  readonly #now: () => Date;

  constructor(config: TikTokXClientConfig = {}) {
    this.#http = new OAuthHttp("OAuth/x", config);
    this.#now = config.now ?? (() => new Date());
  }

  authorizeUrl(req: OAuthAuthorizeRequest): string {
    if (req.codeChallenge === undefined) throw this.#http.contract("X needs PKCE");
    const q = new URLSearchParams({
      response_type: "code",
      client_id: req.credentials.clientId,
      redirect_uri: req.redirectUri,
      // Separados por espacio.
      scope: req.scopes.join(" "),
      state: req.state,
      code_challenge: req.codeChallenge,
      code_challenge_method: "S256",
    });
    return `https://x.com/i/oauth2/authorize?${q.toString()}`;
  }

  /** Cliente confidencial: `Authorization: Basic base64(client_id:client_secret)`. */
  #basic(req: { credentials: { clientId: string; clientSecret: string } }) {
    const raw = `${req.credentials.clientId}:${req.credentials.clientSecret}`;
    return { Authorization: `Basic ${Buffer.from(raw, "utf8").toString("base64")}` };
  }

  async exchangeCode(req: OAuthCodeExchangeRequest): Promise<OAuthGrantedAccount[]> {
    if (req.codeVerifier === undefined)
      throw this.#http.contract("X needs code_verifier");
    const body = await this.#http.form(
      X_TOKEN_URL,
      {
        code: req.code,
        grant_type: "authorization_code",
        client_id: req.credentials.clientId,
        redirect_uri: req.redirectUri,
        code_verifier: req.codeVerifier,
      },
      this.#basic(req),
    );
    const tokens = this.#tokenSet(body);
    const me = await this.#http.get(
      "https://api.x.com/2/users/me",
      { "user.fields": "profile_image_url" },
      { Authorization: `Bearer ${tokens.accessToken}` },
    );
    const data = obj(me, "data") ?? {};
    const id = str(data, "id");
    const username = str(data, "username");
    if (id === undefined || username === undefined)
      throw this.#http.contract("no id/username");
    const displayName = str(data, "name");
    const avatarUrl = str(data, "profile_image_url");
    return [
      {
        identity: {
          platformUserId: id,
          username,
          ...(displayName === undefined ? {} : { displayName }),
          ...(avatarUrl === undefined ? {} : { avatarUrl }),
        },
        tokens,
      },
    ];
  }

  async refresh(req: OAuthRefreshRequest): Promise<OAuthTokenSet> {
    if (req.refreshToken === undefined) throw this.#http.contract("no refresh token");
    const body = await this.#http.form(
      X_TOKEN_URL,
      {
        grant_type: "refresh_token",
        refresh_token: req.refreshToken,
        client_id: req.credentials.clientId,
      },
      this.#basic(req),
    );
    return this.#tokenSet(body);
  }

  #tokenSet(body: Record<string, unknown>): OAuthTokenSet {
    const accessToken = str(body, "access_token");
    if (accessToken === undefined) throw this.#http.contract("no access_token");
    const refreshToken = str(body, "refresh_token");
    const scopes = splitScopes(str(body, "scope"));
    return {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      expiresAt: expiresAtFrom(this.#now(), num(body, "expires_in")),
      ...(scopes === undefined ? {} : { scopes }),
    };
  }
}
