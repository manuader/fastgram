/**
 * Cliente OAuth de YouTube — OAuth 2.0 de Google para apps de servidor
 * (`PU-LATER-001`, `D-09`).
 *
 * Endpoints y parámetros con la URL de la documentación oficial, consultada
 * el 2026-09-24:
 *
 *  - https://developers.google.com/identity/protocols/oauth2/web-server
 *    · Autorización: `GET https://accounts.google.com/o/oauth2/v2/auth` con
 *      `client_id`, `redirect_uri`, `response_type=code`, `scope` (separados
 *      por espacio), `state`; recomendados `access_type=offline` (*"to
 *      receive refresh token"*) e `include_granted_scopes=true`; opcional
 *      `prompt=consent` (fuerza la pantalla de consentimiento: sin él, una
 *      segunda conexión de la misma cuenta **no** trae refresh token).
 *    · Token: `POST https://oauth2.googleapis.com/token` form-urlencoded,
 *      `code`, `client_id`, `client_secret`, `redirect_uri`,
 *      `grant_type=authorization_code` → `access_token`, `expires_in`,
 *      `refresh_token` (sólo con `access_type=offline`), `scope` (*"the
 *      scopes user actually granted"*), `token_type`.
 *    · Refresco: mismo endpoint con `grant_type=refresh_token`. La respuesta
 *      no trae un refresh token nuevo: se conserva el guardado.
 *    · `invalid_grant`: code vencido/usado o refresh token revocado.
 *  - Identidad: `GET https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true`
 *    (*"only return channels owned by the authenticated user"*, 1 unidad) —
 *    https://developers.google.com/youtube/v3/docs/channels/list ; campos
 *    `id`, `snippet.title`, `snippet.customUrl`, `snippet.thumbnails.default.url` —
 *    https://developers.google.com/youtube/v3/docs/channels
 *    **NO VERIFICADO**: qué scope exige `mine=true` (la referencia no lo dice).
 *    Se pide `youtube.readonly` (*"View your YouTube account"*) para cubrirlo.
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

export interface YouTubeClientConfig extends OAuthHttpConfig {
  readonly now?: () => Date;
}

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const YOUTUBE_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";

export class YouTubeOAuthClient implements OAuthClient {
  readonly platform = "youtube" as const;
  /** Google lo admite, pero el cliente web confidencial no lo necesita. */
  readonly usesPkce = false;
  readonly refreshWith = "refresh_token" as const;
  readonly #http: OAuthHttp;
  readonly #now: () => Date;

  constructor(config: YouTubeClientConfig = {}) {
    this.#http = new OAuthHttp("OAuth/youtube", config);
    this.#now = config.now ?? (() => new Date());
  }

  authorizeUrl(req: OAuthAuthorizeRequest): string {
    const q = new URLSearchParams({
      client_id: req.credentials.clientId,
      redirect_uri: req.redirectUri,
      response_type: "code",
      scope: req.scopes.join(" "),
      state: req.state,
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
    });
    return `${GOOGLE_AUTHORIZE_URL}?${q.toString()}`;
  }

  async exchangeCode(req: OAuthCodeExchangeRequest): Promise<OAuthGrantedAccount[]> {
    const body = await this.#http.form(GOOGLE_TOKEN_URL, {
      code: req.code,
      client_id: req.credentials.clientId,
      client_secret: req.credentials.clientSecret,
      redirect_uri: req.redirectUri,
      grant_type: "authorization_code",
    });
    const tokens = this.#tokenSet(body);

    const channels = await this.#http.get(
      YOUTUBE_CHANNELS_URL,
      { part: "snippet", mine: "true" },
      { Authorization: `Bearer ${tokens.accessToken}` },
    );
    const items = Array.isArray(channels["items"])
      ? (channels["items"] as unknown[])
      : // Una cuenta de Google sin canal responde sin `items`: no hay a qué publicar.
        [];
    const out: OAuthGrantedAccount[] = [];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const channel = item as Record<string, unknown>;
      const id = str(channel, "id");
      if (id === undefined) continue;
      const snippet = obj(channel, "snippet") ?? {};
      const title = str(snippet, "title");
      const handle = str(snippet, "customUrl")?.replace(/^@/, "");
      const avatarUrl = str(obj(obj(snippet, "thumbnails"), "default") ?? {}, "url");
      out.push({
        identity: {
          platformUserId: id,
          username: handle ?? title ?? id,
          ...(title === undefined ? {} : { displayName: title }),
          ...(avatarUrl === undefined ? {} : { avatarUrl }),
        },
        tokens,
      });
    }
    return out;
  }

  async refresh(req: OAuthRefreshRequest): Promise<OAuthTokenSet> {
    if (req.refreshToken === undefined) throw this.#http.contract("no refresh token");
    const body = await this.#http.form(GOOGLE_TOKEN_URL, {
      client_id: req.credentials.clientId,
      client_secret: req.credentials.clientSecret,
      refresh_token: req.refreshToken,
      grant_type: "refresh_token",
    });
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
