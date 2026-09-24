/**
 * Rutas de la aplicación · PRD §3.1 (PRD:214-293).
 *
 * Una constante por ruta, y no strings sueltos en el JSX, porque las guards
 * (`lib/auth/route-policy.ts`) y el sidebar tienen que estar hablando de las
 * **mismas** rutas: si una lista se desincroniza de la otra aparece un enlace
 * que redirige solo, y eso no lo detecta ningún test de la pantalla.
 */

export const ROUTES = {
  root: "/",
  login: "/login",
  signup: "/signup",
  logout: "/logout",
  ssoCallback: "/auth/sso-callback",
  onboarding: "/onboarding",

  home: "/home",
  engagement: "/engagement",
  engagementActions: "/engagement/actions",
  engagementInsights: "/engagement/insights",
  blitz: "/blitz",
  blitzSettings: "/blitz/settings",
  aiStudio: "/ai-studio",
  influencers: "/influencers",
  content: "/content",
  library: "/library",
  calendar: "/calendar",
  analytics: "/analytics",
  warmedAccounts: "/warmed-accounts",
  automations: "/automations",
  automationsNew: "/automations/new",
  brand: "/brand",
  inspiration: "/inspiration",
  guide: "/guide",
  roadmap: "/roadmap",
  changelog: "/changelog",
  feedback: "/feedback",
  referAndEarn: "/refer-and-earn",
  upgrade: "/upgrade",
  settings: "/settings",
  /** `PU-BRAND-001` — gestionar marcas (workspaces) en modo personal. */
  settingsBrands: "/settings/brands",
  /** `PU-MODELS-*` — proveedor por tarea (la página la construye otro agente). */
  settingsModels: "/settings/models",
  developers: "/developers",
  developer: "/developer",
  status: "/status",
} as const;

export type Route = (typeof ROUTES)[keyof typeof ROUTES];

/** PRD:334 — el enlace de Discord del bloque secundario del sidebar. */
export const DISCORD_INVITE_URL = "https://discord.gg/aaAQ9VzQ6j";

/** PRD:287-291 — las 5 plataformas con callback OAuth propio. */
export const OAUTH_CALLBACK_PLATFORMS = [
  "tiktok",
  "instagram",
  "youtube",
  "linkedin",
  "reddit",
] as const;
export type OAuthCallbackPlatform = (typeof OAUTH_CALLBACK_PLATFORMS)[number];

export function isOAuthCallbackPlatform(value: string): value is OAuthCallbackPlatform {
  return (OAUTH_CALLBACK_PLATFORMS as readonly string[]).includes(value);
}

/**
 * PRD:292 — las secciones de `/settings`. El sitemap las enumera como
 * secciones de una sola ruta, no como rutas propias: se navegan dentro de
 * `/settings`, por eso son ids y no paths.
 */
export const SETTINGS_SECTIONS = [
  "account",
  "workspaces",
  "integrations",
  "warmed-accounts",
  "notifications",
  "preferences",
  "billing",
  "api",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
