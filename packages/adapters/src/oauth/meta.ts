/**
 * Clientes OAuth de Meta: Instagram (Instagram Login), Threads y Facebook
 * Pages (Facebook Login) — `PU-PUB-002` (`= P3-OAUTH-003`), `D-09`.
 *
 * Cada endpoint lleva la URL de la documentación oficial de la que sale,
 * consultada el 2026-09-24. Los tres refrescan **con el access token**, no
 * con un refresh token (Meta no los emite en estos flujos).
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

export interface MetaClientConfig extends OAuthHttpConfig {
  readonly now?: () => Date;
  /**
   * Versión de la Graph API para Facebook e Instagram. La doc de Facebook
   * Login y la de Instagram muestran `v25.0` en sus ejemplos
   * (https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow ,
   * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started );
   * la referencia de `/accounts` ya muestra `v26.0`. Configurable para no
   * tocar código cuando Meta retire una.
   */
  readonly graphVersion?: string;
}

const DEFAULT_GRAPH_VERSION = "v25.0";

function url(base: string, params: Readonly<Record<string, string>>): string {
  return `${base}?${new URLSearchParams(params).toString()}`;
}

/* ------------------------------------------------------------------------ *
 * Instagram API with Instagram Login
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
 * ------------------------------------------------------------------------ */

export class InstagramOAuthClient implements OAuthClient {
  readonly platform = "instagram" as const;
  readonly usesPkce = false;
  readonly refreshWith = "access_token" as const;
  readonly #http: OAuthHttp;
  readonly #now: () => Date;
  readonly #version: string;

  constructor(config: MetaClientConfig = {}) {
    this.#http = new OAuthHttp("OAuth/instagram", config);
    this.#now = config.now ?? (() => new Date());
    this.#version = config.graphVersion ?? DEFAULT_GRAPH_VERSION;
  }

  authorizeUrl(req: OAuthAuthorizeRequest): string {
    // `scope`: *"A comma-separated or URL-encoded space-separated list"*.
    return url("https://www.instagram.com/oauth/authorize", {
      client_id: req.credentials.clientId,
      redirect_uri: req.redirectUri,
      response_type: "code",
      scope: req.scopes.join(","),
      state: req.state,
    });
  }

  async exchangeCode(req: OAuthCodeExchangeRequest): Promise<OAuthGrantedAccount[]> {
    // 1. code → token corto. `POST https://api.instagram.com/oauth/access_token`.
    const short = await this.#http.form("https://api.instagram.com/oauth/access_token", {
      client_id: req.credentials.clientId,
      client_secret: req.credentials.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: req.redirectUri,
      code: req.code,
    });
    // La doc muestra `{ data: [{ access_token, user_id, permissions }] }`; se
    // acepta también la forma plana por si la respuesta real no trae `data`.
    const first = Array.isArray(short["data"]) ? (short["data"][0] as unknown) : short;
    const shortToken =
      typeof first === "object" && first !== null
        ? str(first as Record<string, unknown>, "access_token")
        : undefined;
    if (shortToken === undefined)
      throw this.#http.contract("no short-lived access_token");
    const permissions =
      typeof first === "object" && first !== null
        ? (first as Record<string, unknown>)["permissions"]
        : undefined;

    // 2. token corto → largo (60 días). `GET https://graph.instagram.com/access_token`,
    //    `grant_type=ig_exchange_token`.
    const long = await this.#http.get("https://graph.instagram.com/access_token", {
      grant_type: "ig_exchange_token",
      client_secret: req.credentials.clientSecret,
      access_token: shortToken,
    });
    const tokens = this.#tokenSet(long);

    // 3. identidad. `GET https://graph.instagram.com/v25.0/me` con `user_id`
    //    (*"The Instagram professional account ID"*), `username`, `name`,
    //    `profile_picture_url` —
    //    https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started
    const me = await this.#http.get(`https://graph.instagram.com/${this.#version}/me`, {
      fields: "user_id,username,name,profile_picture_url",
      access_token: tokens.accessToken,
    });
    const id = str(me, "user_id") ?? str(me, "id");
    const username = str(me, "username");
    if (id === undefined || username === undefined)
      throw this.#http.contract("no user_id/username");
    const displayName = str(me, "name");
    const avatarUrl = str(me, "profile_picture_url");
    const scopes =
      typeof permissions === "string"
        ? splitScopes(permissions)
        : Array.isArray(permissions)
          ? permissions.filter((p): p is string => typeof p === "string")
          : undefined;
    return [
      {
        identity: {
          platformUserId: id,
          username,
          ...(displayName === undefined ? {} : { displayName }),
          ...(avatarUrl === undefined ? {} : { avatarUrl }),
        },
        tokens: scopes === undefined ? tokens : { ...tokens, scopes },
      },
    ];
  }

  async refresh(req: OAuthRefreshRequest): Promise<OAuthTokenSet> {
    // `GET https://graph.instagram.com/refresh_access_token`, `grant_type=ig_refresh_token`.
    // Sólo con un token de más de 24 h y vigente (lo decide `core`).
    const body = await this.#http.get(
      "https://graph.instagram.com/refresh_access_token",
      {
        grant_type: "ig_refresh_token",
        access_token: req.accessToken,
      },
    );
    return this.#tokenSet(body);
  }

  #tokenSet(body: Record<string, unknown>): OAuthTokenSet {
    const accessToken = str(body, "access_token");
    if (accessToken === undefined) throw this.#http.contract("no access_token");
    return {
      accessToken,
      expiresAt: expiresAtFrom(this.#now(), num(body, "expires_in")),
    };
  }
}

/* ------------------------------------------------------------------------ *
 * Threads API — OAuth propio
 * https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions
 * https://developers.facebook.com/docs/threads/get-started/long-lived-tokens
 * ------------------------------------------------------------------------ */

export class ThreadsOAuthClient implements OAuthClient {
  readonly platform = "threads" as const;
  readonly usesPkce = false;
  readonly refreshWith = "access_token" as const;
  readonly #http: OAuthHttp;
  readonly #now: () => Date;

  constructor(config: MetaClientConfig = {}) {
    this.#http = new OAuthHttp("OAuth/threads", config);
    this.#now = config.now ?? (() => new Date());
  }

  authorizeUrl(req: OAuthAuthorizeRequest): string {
    // La doc actual usa `threads.com` (antes `threads.net`).
    return url("https://threads.com/oauth/authorize", {
      client_id: req.credentials.clientId,
      redirect_uri: req.redirectUri,
      response_type: "code",
      scope: req.scopes.join(","),
      state: req.state,
    });
  }

  async exchangeCode(req: OAuthCodeExchangeRequest): Promise<OAuthGrantedAccount[]> {
    // `POST https://graph.threads.com/oauth/access_token`.
    const short = await this.#http.form("https://graph.threads.com/oauth/access_token", {
      client_id: req.credentials.clientId,
      client_secret: req.credentials.clientSecret,
      code: req.code,
      grant_type: "authorization_code",
      redirect_uri: req.redirectUri,
    });
    const shortToken = str(short, "access_token");
    if (shortToken === undefined)
      throw this.#http.contract("no short-lived access_token");

    // Largo: `GET https://graph.threads.net/access_token`, `grant_type=th_exchange_token`.
    // (La doc de tokens largos usa `graph.threads.net`; la de autorización,
    // `graph.threads.com`. Se respeta cada una tal como está publicada.)
    const long = await this.#http.get("https://graph.threads.net/access_token", {
      grant_type: "th_exchange_token",
      client_secret: req.credentials.clientSecret,
      access_token: shortToken,
    });
    const tokens = this.#tokenSet(long);

    // `GET https://graph.threads.net/v1.0/me?fields=id,username,name,threads_profile_picture_url`
    // — https://developers.facebook.com/docs/threads/threads-profiles
    const me = await this.#http.get("https://graph.threads.net/v1.0/me", {
      fields: "id,username,name,threads_profile_picture_url",
      access_token: tokens.accessToken,
    });
    const id = str(me, "id") ?? str(short, "user_id");
    const username = str(me, "username");
    if (id === undefined || username === undefined)
      throw this.#http.contract("no id/username");
    const displayName = str(me, "name");
    const avatarUrl = str(me, "threads_profile_picture_url");
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
    // `GET https://graph.threads.net/refresh_access_token`, `grant_type=th_refresh_token`.
    const body = await this.#http.get("https://graph.threads.net/refresh_access_token", {
      grant_type: "th_refresh_token",
      access_token: req.accessToken,
    });
    return this.#tokenSet(body);
  }

  #tokenSet(body: Record<string, unknown>): OAuthTokenSet {
    const accessToken = str(body, "access_token");
    if (accessToken === undefined) throw this.#http.contract("no access_token");
    return {
      accessToken,
      expiresAt: expiresAtFrom(this.#now(), num(body, "expires_in")),
    };
  }
}

/* ------------------------------------------------------------------------ *
 * Facebook Login → Páginas
 * https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 * https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 * ------------------------------------------------------------------------ */

export class FacebookPagesOAuthClient implements OAuthClient {
  readonly platform = "facebook" as const;
  readonly usesPkce = false;
  /** El token de Página sacado de un token de usuario largo no vence. */
  readonly refreshWith = "none" as const;
  readonly #http: OAuthHttp;
  readonly #version: string;

  constructor(config: MetaClientConfig = {}) {
    this.#http = new OAuthHttp("OAuth/facebook", config);
    this.#version = config.graphVersion ?? DEFAULT_GRAPH_VERSION;
  }

  authorizeUrl(req: OAuthAuthorizeRequest): string {
    return url(`https://www.facebook.com/${this.#version}/dialog/oauth`, {
      client_id: req.credentials.clientId,
      redirect_uri: req.redirectUri,
      state: req.state,
      response_type: "code",
      scope: req.scopes.join(","),
    });
  }

  /** Devuelve **una cuenta por Página**; la API deja elegir cuál conectar. */
  async exchangeCode(req: OAuthCodeExchangeRequest): Promise<OAuthGrantedAccount[]> {
    const graph = `https://graph.facebook.com/${this.#version}`;
    // `GET /oauth/access_token` con `client_id`, `redirect_uri`, `client_secret`, `code`.
    const short = await this.#http.get(`${graph}/oauth/access_token`, {
      client_id: req.credentials.clientId,
      redirect_uri: req.redirectUri,
      client_secret: req.credentials.clientSecret,
      code: req.code,
    });
    const shortToken = str(short, "access_token");
    if (shortToken === undefined) throw this.#http.contract("no user access_token");

    // Token de usuario largo (`grant_type=fb_exchange_token`): los tokens de
    // Página que salen de él *"do not have an expiration date"*.
    const long = await this.#http.get(`${graph}/oauth/access_token`, {
      grant_type: "fb_exchange_token",
      client_id: req.credentials.clientId,
      client_secret: req.credentials.clientSecret,
      fb_exchange_token: shortToken,
    });
    const userToken = str(long, "access_token");
    if (userToken === undefined) throw this.#http.contract("no long-lived user token");

    // `GET /me/accounts` — https://developers.facebook.com/docs/graph-api/reference/user/accounts/
    // (`picture` figura como campo de la Página en esa referencia; `name` y
    // `access_token` son los que describe la guía de tokens de Página).
    const pages = await this.#http.get(`${graph}/me/accounts`, {
      fields: "id,name,access_token,picture",
      access_token: userToken,
    });
    const data = Array.isArray(pages["data"]) ? (pages["data"] as unknown[]) : null;
    if (data === null) throw this.#http.contract("no data[] in /me/accounts");

    const out: OAuthGrantedAccount[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const page = item as Record<string, unknown>;
      const id = str(page, "id");
      const name = str(page, "name");
      const accessToken = str(page, "access_token");
      if (id === undefined || name === undefined || accessToken === undefined) continue;
      const avatarUrl = str(obj(page["picture"], "data") ?? {}, "url");
      out.push({
        identity: {
          platformUserId: id,
          username: name,
          displayName: name,
          ...(avatarUrl === undefined ? {} : { avatarUrl }),
        },
        tokens: { accessToken, expiresAt: null },
      });
    }
    return out;
  }

  refresh(): Promise<OAuthTokenSet> {
    // Nunca se llama (`refreshWith: "none"`): un token de Página inválido se
    // arregla reconectando.
    return Promise.reject(this.#http.contract("facebook page tokens are not refreshed"));
  }
}
