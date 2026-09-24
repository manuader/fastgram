/**
 * Qué se le pide a cada plataforma al conectar — `PU-PUB-002`, `D-09`, `D-10`.
 *
 * Lógica pura: scopes, si exige https en la redirect URI, cuándo refrescar y
 * dónde está la consola. Los **endpoints** (URLs de autorización y de token)
 * son del adaptador (`packages/adapters/src/oauth/`), que es quien habla HTTP.
 *
 * Cada dato lleva la URL de la documentación oficial de la que sale,
 * consultada el 2026-09-24. Lo que no se pudo confirmar dice
 * **NO VERIFICADO** y queda del lado conservador.
 */
import type { OAuthPlatform } from "@fastgram/ports";

export interface OAuthPlatformSpec {
  readonly platform: OAuthPlatform;
  readonly label: string;
  /** Scopes que se piden, en el orden y con el separador que arma el adaptador. */
  readonly scopes: readonly string[];
  /**
   * `verified`: la doc oficial dice que la redirect URI tiene que ser https.
   * `recommended`: la doc no lo dice de esta plataforma, pero la app de Meta
   * trae "Enforce HTTPS" prendido por default — se avisa, no se bloquea.
   * `no`: la doc no lo exige (y localhost suele andar).
   */
  readonly https: "verified" | "recommended" | "no";
  /** Dónde se crea la app y se cargan las redirect URIs. */
  readonly consoleUrl: string;
  /** La página de la doc que dice qué cargar en la consola. */
  readonly docsUrl: string;
  /**
   * Cuánto antes del vencimiento se refresca. El margen es nuestro: la
   * plataforma sólo publica la vida del token.
   */
  readonly refreshMarginMs: number;
  /**
   * Edad mínima del token para poder refrescarlo. Instagram y Threads:
   * *"at least 24 hours old"* (ver las URLs en {@link OAUTH_PLATFORM_SPECS}).
   */
  readonly minTokenAgeForRefreshMs: number;
  /** Nota para la pantalla de Integrations (qué app crear, qué producto sumar). */
  readonly setupNote: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const OAUTH_PLATFORM_SPECS: Readonly<Record<OAuthPlatform, OAuthPlatformSpec>> = {
  /**
   * Instagram API with Instagram Login (no necesita Página de Facebook).
   * Scopes: `instagram_business_basic`, `instagram_business_content_publish`
   * — https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
   * Token largo: 60 días (`expires_in` 5183944 en el ejemplo) y se refresca
   * con `ig_refresh_token` si tiene más de 24 h — misma página.
   * https: la doc de Instagram no lo dice; ver `https: "recommended"`.
   */
  instagram: {
    platform: "instagram",
    label: "Instagram",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    https: "recommended",
    consoleUrl: "https://developers.facebook.com/apps/",
    docsUrl:
      "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login",
    // Una semana antes de los 60 días: un refresco que falla deja margen para reconectar.
    refreshMarginMs: 7 * DAY_MS,
    minTokenAgeForRefreshMs: DAY_MS,
    setupNote:
      "In your Meta app, add the Instagram product with “API setup with Instagram login”. Use the Instagram app ID and secret shown there — not the Facebook App ID.",
  },
  /**
   * TikTok Login Kit + Content Posting API **Upload** (borrador, `D-10`).
   * `video.upload` — https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
   * `user.info.basic` (open_id, avatar_url, display_name) —
   * https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info
   * (el `username` pide `user.info.profile`: no se pide, para no exigir un
   * scope más en la app; se muestra `display_name`).
   * https obligatorio: *"URIs must be absolute and begin with https"* —
   * https://developers.tiktok.com/doc/login-kit-web
   * Access token 24 h, refresh token 365 días —
   * https://developers.tiktok.com/doc/oauth-user-access-token-management
   */
  tiktok: {
    platform: "tiktok",
    label: "TikTok",
    scopes: ["user.info.basic", "video.upload"],
    https: "verified",
    consoleUrl: "https://developers.tiktok.com/apps/",
    docsUrl: "https://developers.tiktok.com/doc/login-kit-web",
    refreshMarginMs: 30 * 60 * 1000,
    minTokenAgeForRefreshMs: 0,
    setupNote:
      "Create a TikTok app with Login Kit and Content Posting API (Upload). Its client key goes in Client ID. TikTok only accepts https redirect URIs, so set FASTGRAM_PUBLIC_URL to your tunnel first.",
  },
  /**
   * X OAuth 2.0 con PKCE. Scopes `tweet.read tweet.write users.read
   * media.write offline.access` (el último, para tener refresh token) —
   * https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
   * `users.read` para `GET /2/users/me` — https://docs.x.com/x-api/users/get-my-user
   * https: la doc sólo pide *"exact match"*; no lo exige.
   * Vida del token: la doc consultada no la da; se usa el `expires_in` de la
   * respuesta y un margen de 5 minutos.
   */
  x: {
    platform: "x",
    label: "X",
    scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
    https: "no",
    consoleUrl: "https://developer.x.com/en/portal/dashboard",
    docsUrl:
      "https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code",
    refreshMarginMs: 5 * 60 * 1000,
    minTokenAgeForRefreshMs: 0,
    setupNote:
      "In the X developer portal, enable OAuth 2.0 (type: Web App, confidential client) and copy its OAuth 2.0 Client ID and Client Secret — not the API key.",
  },
  /**
   * Threads API — OAuth **propio** (`threads.com/oauth/authorize`), con el
   * *Threads App ID* de la app de Meta. Scopes `threads_basic`,
   * `threads_content_publish` —
   * https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions
   * Token largo 60 días, refresco con más de 24 h —
   * https://developers.facebook.com/docs/threads/get-started/long-lived-tokens
   */
  threads: {
    platform: "threads",
    label: "Threads",
    scopes: ["threads_basic", "threads_content_publish"],
    https: "recommended",
    consoleUrl: "https://developers.facebook.com/apps/",
    docsUrl:
      "https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions",
    refreshMarginMs: 7 * DAY_MS,
    minTokenAgeForRefreshMs: DAY_MS,
    setupNote:
      "In your Meta app, add the Threads use case. Use the Threads App ID and Threads App secret (App settings → Basic), not the Facebook App ID.",
  },
  /**
   * Facebook Login → token de Página. Permisos para Reels en una Página:
   * `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` —
   * https://developers.facebook.com/docs/video-api/guides/reels-publishing
   * Listar Páginas (`/me/accounts`) pide además `pages_manage_metadata`
   * según https://developers.facebook.com/docs/graph-api/reference/user/accounts/
   * El token de Página sacado de un token de usuario largo *"do not have an
   * expiration date"* —
   * https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
   * "Enforce HTTPS" *"requires HTTPS for OAuth Redirects"* —
   * https://developers.facebook.com/documentation/facebook-login/security
   * (que localhost en modo desarrollo quede exento: NO VERIFICADO).
   */
  facebook: {
    platform: "facebook",
    label: "Facebook Page",
    scopes: [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "pages_manage_metadata",
    ],
    https: "recommended",
    consoleUrl: "https://developers.facebook.com/apps/",
    docsUrl:
      "https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow",
    refreshMarginMs: 7 * DAY_MS,
    minTokenAgeForRefreshMs: 0,
    setupNote:
      "In your Meta app, add Facebook Login and use the App ID and App secret from App settings → Basic. You pick the Page after logging in.",
  },
};

export function oauthPlatformSpec(platform: OAuthPlatform): OAuthPlatformSpec {
  return OAUTH_PLATFORM_SPECS[platform];
}
