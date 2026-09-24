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
   * Los de {@link scopes} que sólo sirven para **leer métricas** (sprint 5,
   * `PU-AUTO-004`). Un subconjunto: se piden igual, pero una cuenta que no
   * los concede **puede publicar** — sólo se queda sin métricas. Quien decide
   * `publishable` los tiene que excluir (ver {@link publishScopesOf}).
   */
  readonly insightsScopes: readonly string[];
  /**
   * Scopes que se suman a {@link scopes} sólo si la app de la instalación lo
   * pide (`IntegrationAppConfig.optionalScopes`). Existen porque LinkedIn
   * rechaza el login entero si se pide un scope de un producto que la app no
   * tiene aprobado (*"Invalid scope"*, 401 —
   * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow ).
   * Vacío en el resto.
   */
  readonly optionalScopes: readonly string[];
  /** Qué habilitan los {@link optionalScopes}, para la pantalla. `null` si no hay. */
  readonly optionalScopesNote: string | null;
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
   *
   * `instagram_business_manage_insights` (sprint 5, `PU-AUTO-004`): lo exige
   * `GET /<IG_MEDIA_ID>/insights` —
   * https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
   * y https://developers.facebook.com/blog/post/2025/03/24/user-and-media-insights-on-instagram-api-with-instagram-login/
   * **Las conexiones anteriores no lo tienen: hay que reconectarlas** para que
   * vuelvan métricas (el sync responde `forbidden` y la pantalla lo dice).
   */
  instagram: {
    platform: "instagram",
    label: "Instagram",
    scopes: [
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_business_manage_insights",
    ],
    insightsScopes: ["instagram_business_manage_insights"],
    optionalScopes: [],
    optionalScopesNote: null,
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
    // Sin métricas: pedirían `video.list` y el id del video, que el Upload a
    // borrador no da (ver `packages/adapters/src/metrics/index.ts`).
    insightsScopes: [],
    optionalScopes: [],
    optionalScopesNote: null,
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
    // `GET /2/tweets` con `public_metrics` pide `tweet.read` + `users.read`,
    // que ya se piden para publicar: no hay scope sólo de métricas.
    insightsScopes: [],
    optionalScopes: [],
    optionalScopesNote: null,
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
   *
   * `threads_manage_insights` (sprint 5, `PU-AUTO-004`): lo exige
   * `GET /<THREADS_MEDIA_ID>/insights` — https://developers.facebook.com/docs/threads/insights
   * Las conexiones anteriores hay que reconectarlas.
   */
  threads: {
    platform: "threads",
    label: "Threads",
    scopes: ["threads_basic", "threads_content_publish", "threads_manage_insights"],
    insightsScopes: ["threads_manage_insights"],
    optionalScopes: [],
    optionalScopesNote: null,
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
   *
   * `read_insights` y `pages_manage_engagement` (sprint 5, `PU-AUTO-004`): los
   * dos figuran como requeridos para `GET /<VIDEO_ID>/video_insights` (métricas
   * de Reels) — https://developers.facebook.com/docs/graph-api/reference/video/video_insights
   * Las conexiones anteriores hay que reconectarlas.
   */
  facebook: {
    platform: "facebook",
    label: "Facebook Page",
    scopes: [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "pages_manage_metadata",
      "read_insights",
      "pages_manage_engagement",
    ],
    insightsScopes: ["read_insights", "pages_manage_engagement"],
    optionalScopes: [],
    optionalScopesNote: null,
    https: "recommended",
    consoleUrl: "https://developers.facebook.com/apps/",
    docsUrl:
      "https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow",
    refreshMarginMs: 7 * DAY_MS,
    minTokenAgeForRefreshMs: 0,
    setupNote:
      "In your Meta app, add Facebook Login and use the App ID and App secret from App settings → Basic. You pick the Page after logging in.",
  },
  /**
   * YouTube (`PU-LATER-001`) — OAuth 2.0 de Google para apps de servidor.
   * `youtube.upload` lo pide `videos.insert` —
   * https://developers.google.com/youtube/v3/docs/videos/insert
   * `youtube.readonly` (*"View your YouTube account"*) para leer el canal
   * propio (`channels.list?mine=true`) y las estadísticas de los videos
   * (`videos.list`), incluso los que quedan privados sin auditoría —
   * https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps
   * No va en `insightsScopes`: sin él no se sabe qué canal se conectó.
   *
   * https: *"HTTPS required (localhost exempt)"* —
   * https://developers.google.com/identity/protocols/oauth2/web-server
   * Como localhost está exento y el túnel ya es https, queda en `no`.
   * Vida: el `expires_in` de la respuesta; el refresh token dura mientras no
   * se revoque, **salvo** con la pantalla de consentimiento en «Testing»:
   * vence a los 7 días — https://developers.google.com/identity/protocols/oauth2
   *
   * Sin la auditoría del proyecto, *"All videos uploaded via the
   * `videos.insert` endpoint from unverified API projects created after 28
   * July 2020 will be restricted to private viewing mode"* (videos/insert).
   */
  youtube: {
    platform: "youtube",
    label: "YouTube",
    scopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ],
    insightsScopes: [],
    optionalScopes: [],
    optionalScopesNote: null,
    https: "no",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    docsUrl: "https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps",
    refreshMarginMs: 5 * 60 * 1000,
    minTokenAgeForRefreshMs: 0,
    setupNote:
      "In Google Cloud, enable the YouTube Data API v3 and create an OAuth client of type “Web application”. Until Google audits your project, every video you upload stays private — request the audit early, it takes a while. While the consent screen is in “Testing”, you must reconnect every 7 days.",
  },
  /**
   * LinkedIn (`PU-LATER-002`) — 3-legged OAuth.
   * `w_member_social` (producto «Share on LinkedIn») y `openid` + `profile`
   * (producto «Sign In with LinkedIn using OpenID Connect») son permisos
   * abiertos, sin aprobación —
   * https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access
   * `sub` de `/v2/userinfo` arma el Person URN —
   * https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
   *
   * Opcionales, para publicar como Página: `w_organization_social` (Posts
   * API) y `r_organization_admin` (listar las Páginas que administra, con
   * `organizationAcls`) —
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role
   * Son del producto Community Management API, que **requiere aprobación**.
   *
   * https: *"Add the redirect (callback) URL via HTTPS"* —
   * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
   * Vida: *"all access tokens are issued with a 60-day lifespan"*; el refresh
   * token programático sólo existe para socios aprobados (misma página y
   * https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens ).
   * Sin refresh token, a los 60 días hay que reconectar.
   */
  linkedin: {
    platform: "linkedin",
    label: "LinkedIn",
    scopes: ["openid", "profile", "w_member_social"],
    insightsScopes: [],
    optionalScopes: ["w_organization_social", "r_organization_admin"],
    optionalScopesNote:
      "My LinkedIn app has the Community Management API approved — also let me post as a Page I manage.",
    https: "verified",
    consoleUrl: "https://www.linkedin.com/developers/apps",
    docsUrl:
      "https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow",
    // Una semana antes de los 60 días, como Meta.
    refreshMarginMs: 7 * DAY_MS,
    minTokenAgeForRefreshMs: 0,
    setupNote:
      "In your LinkedIn app, add the “Share on LinkedIn” and “Sign In with LinkedIn using OpenID Connect” products. LinkedIn only accepts https redirect URLs, so set FASTGRAM_PUBLIC_URL to your tunnel first. Without programmatic refresh tokens (partners only), reconnect every 60 days.",
  },
};

export function oauthPlatformSpec(platform: OAuthPlatform): OAuthPlatformSpec {
  return OAUTH_PLATFORM_SPECS[platform];
}

/**
 * Los scopes sin los que **no se puede publicar**: {@link OAuthPlatformSpec.scopes}
 * menos los de métricas. Es contra esto que se tiene que calcular
 * `publishable`; contra la lista entera, una cuenta que rechazó el permiso de
 * insights quedaría sin poder publicar por algo que publicar no usa.
 */
export function publishScopesOf(platform: OAuthPlatform): readonly string[] {
  const spec = OAUTH_PLATFORM_SPECS[platform];
  return spec.scopes.filter((s) => !spec.insightsScopes.includes(s));
}

/**
 * Lo que se pide en la autorización: {@link OAuthPlatformSpec.scopes} más los
 * opcionales si la app de la instalación los habilitó. Los opcionales nunca
 * entran en {@link publishScopesOf}: una cuenta sin ellos publica igual (en
 * LinkedIn, como perfil).
 */
export function requestedScopesOf(
  platform: OAuthPlatform,
  config: { readonly optionalScopes?: boolean } | undefined,
): readonly string[] {
  const spec = OAUTH_PLATFORM_SPECS[platform];
  return config?.optionalScopes === true
    ? [...spec.scopes, ...spec.optionalScopes]
    : spec.scopes;
}
