/**
 * Facebook Login para anuncios — sprint 9 (R), `D-21`.
 *
 * Es una conexión **aparte y opcional** de la de publicar: se pide recién
 * cuando la marca quiere anuncios, con sus propios permisos, y usa la misma
 * app de Meta (las credenciales de `facebook` en Settings → Integrations). No
 * se agrega a `OAUTH_PLATFORMS` ni a `connections`: una cuenta publicitaria no
 * es una cuenta donde se publica, y mezclarla haría que conectar IG pidiera
 * permisos de plata.
 *
 * Mismo flujo que `FacebookPagesOAuthClient` (`oauth/meta.ts`):
 * https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 * y token de usuario largo —
 * https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 * La Marketing API trabaja con el **token de usuario** (no el de Página).
 *
 * Permisos — https://developers.facebook.com/docs/permissions (2026-09-28):
 *  - `ads_management`: *"read and manage the Ads account it owns, or has been
 *    granted access to"* (depende de `pages_read_engagement`, `pages_show_list`).
 *  - `ads_read`: *"access the Ads Insights API"*.
 *  - `pages_manage_ads`: *"manage ads associated with the Page"* (el creativo
 *    lleva `page_id`).
 *  - `pages_show_list`, `pages_read_engagement`: listar las Páginas.
 *  - `instagram_basic`: leer la cuenta de IG vinculada a la Página.
 *  - `business_management`: cuentas publicitarias de un Business Manager y
 *    `/{business_id}/ad_studies`.
 * Con acceso estándar (sin App Review) alcanzan para cuentas propias: la doc
 * de autorización de la Marketing API dice que con standard access se puede
 * *"manage an unlimited number of ad accounts"* propias.
 */
import type { OAuthAppCredentials } from "@fastgram/ports";

import {
  OAuthHttp,
  expiresAtFrom,
  num,
  str,
  type OAuthHttpConfig,
} from "../../oauth/http.js";

export const META_ADS_SCOPES = [
  "ads_management",
  "ads_read",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_ads",
  "instagram_basic",
] as const;

const DEFAULT_VERSION = "v25.0";

export function metaAdsAuthorizeUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly graphVersion?: string;
}): string {
  const q = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    response_type: "code",
    scope: META_ADS_SCOPES.join(","),
  });
  return `https://www.facebook.com/${input.graphVersion ?? DEFAULT_VERSION}/dialog/oauth?${q.toString()}`;
}

export interface MetaAdsToken {
  /** En claro: se cifra antes de tocar la base. */
  readonly accessToken: string;
  /** ~60 días para un token de usuario largo; `null` si Meta no lo dice. */
  readonly expiresAt: Date | null;
}

/** `code` → token corto → token de usuario largo (`fb_exchange_token`). */
export async function exchangeMetaAdsCode(
  input: {
    readonly credentials: OAuthAppCredentials;
    readonly redirectUri: string;
    readonly code: string;
    readonly now: Date;
    readonly graphVersion?: string;
  },
  config: OAuthHttpConfig = {},
): Promise<MetaAdsToken> {
  const http = new OAuthHttp("OAuth/meta-ads", config);
  const graph = `https://graph.facebook.com/${input.graphVersion ?? DEFAULT_VERSION}`;
  const short = await http.get(`${graph}/oauth/access_token`, {
    client_id: input.credentials.clientId,
    redirect_uri: input.redirectUri,
    client_secret: input.credentials.clientSecret,
    code: input.code,
  });
  const shortToken = str(short, "access_token");
  if (shortToken === undefined) throw http.contract("no user access_token");
  const long = await http.get(`${graph}/oauth/access_token`, {
    grant_type: "fb_exchange_token",
    client_id: input.credentials.clientId,
    client_secret: input.credentials.clientSecret,
    fb_exchange_token: shortToken,
  });
  const accessToken = str(long, "access_token");
  if (accessToken === undefined) throw http.contract("no long-lived user token");
  return { accessToken, expiresAt: expiresAtFrom(input.now, num(long, "expires_in")) };
}
