/**
 * Copy de Settings → Integrations (`PU-PUB-002`). Local, como
 * `lib/models/copy.ts`, por la misma razón: el catálogo lo tocan otros
 * agentes este sprint. Son claves planas en inglés; mudarlas es mecánico.
 */
export const INTEGRATIONS_COPY = {
  pageTitle: "Integrations",
  pageDescription:
    "Your developer apps on each network. Credentials stay on this machine (~/.fastgram) and are never shown again.",
  metaGroupTitle: "Meta app",
  metaGroupHint:
    "One Meta app covers Instagram, Threads and Facebook, but each product has its own ID and secret in the app dashboard.",
  otherGroupTitle: "Other networks",
  clientId: "Client ID",
  clientIdTiktok: "Client key",
  clientSecret: "Client secret",
  secretPlaceholder: "Paste the secret",
  secretSaved: (last4: string | null) =>
    last4 === null
      ? "Saved secret — type to replace"
      : `Saved secret ending in ${last4} — type to replace`,
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  remove: "Remove",
  removeConfirm:
    "Remove these credentials? Connected accounts keep working until their token needs a refresh.",
  configured: "Ready",
  notConfigured: "Not set up",
  redirectLabel: "Redirect URI to add in the developer console",
  copy: "Copy",
  copied: "Copied",
  scopesLabel: "Permissions requested",
  openConsole: "Open developer console",
  openDocs: "Setup docs",
  httpsRequired:
    "This network only accepts https redirect URIs. Start FastGram with the tunnel (FASTGRAM_PUBLIC_URL) and add the https URI above.",
  httpsRecommended:
    "Meta apps enforce https redirects by default. If localhost is rejected, start FastGram with the tunnel and use the https URI.",
  redirectFromTunnel: (origin: string) => `Redirect URIs use your public URL ${origin}.`,
  redirectLocal:
    "Redirect URIs use http://localhost:3000. Set FASTGRAM_PUBLIC_URL to use your tunnel instead.",
  publicUrlInvalid:
    "FASTGRAM_PUBLIC_URL is set but is not a bare http(s) origin, so it is ignored.",
  errorClientId: "Client ID is required.",
  youtubeAudit:
    "Until Google audits this project, every video uploaded through the API stays private — whatever privacy FastGram asks for. Request the audit early: it takes a while.",
  optionalScopesFallback: "Also request the optional permissions",
  optionalScopesHint: (scopes: string) =>
    `Adds ${scopes}. Only tick it if your app has them approved: otherwise the platform rejects the whole login.`,
} as const;
