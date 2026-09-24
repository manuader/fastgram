/**
 * Copy de Settings → Connections (`PU-PUB-002`, `P3-OAUTH-008`). Local por la
 * misma razón que `lib/models/copy.ts`. Los textos de error son los de PRD
 * §19.5 donde el PRD los da (ERR-D01, D03, D04, D11, D12).
 */
import type { OAuthPlatformId } from "./callback";

export const PLATFORM_LABEL: Readonly<Record<OAuthPlatformId, string>> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  x: "X",
  threads: "Threads",
  facebook: "Facebook Page",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

/** Una línea bajo el botón: qué se conecta y qué hace FastGram con eso. */
export const PLATFORM_HINT: Readonly<Record<OAuthPlatformId, string>> = {
  instagram: "Business or Creator account. Reels, carousels and images.",
  tiktok: "Posts arrive as drafts in your TikTok inbox — you finish them in the app.",
  x: "Posts and media. Pay-per-use on X's side.",
  threads: "Text, images, video and carousels.",
  facebook: "Reels on a Page you manage. You pick the Page after logging in.",
  youtube:
    "Shorts: vertical videos up to 3 minutes. Until Google audits your project, uploads stay private.",
  linkedin: "Your profile, or a Page you manage. Videos, images and multi-image posts.",
};

/** Redes donde la cuenta se elige después del login (una de varias). */
export const PICKER_COPY: Readonly<
  Partial<Record<OAuthPlatformId, { title: string; body: string; choose: string }>>
> = {
  facebook: {
    title: "Choose the Facebook Page",
    body: "Your Facebook account manages more than one Page. Pick the one this brand publishes to.",
    choose: "Use this Page",
  },
  linkedin: {
    title: "Choose where this brand posts on LinkedIn",
    body: "Your LinkedIn account can post as yourself or as a Page you manage. Pick one for this brand.",
    choose: "Use this account",
  },
};

/**
 * YouTube sin auditoría: *"All videos uploaded via the videos.insert endpoint
 * from unverified API projects created after 28 July 2020 will be restricted
 * to private viewing mode"* — developers.google.com/youtube/v3/docs/videos/insert
 */
export const YOUTUBE_AUDIT_WARNING =
  "Until Google audits your Google Cloud project, every video FastGram uploads stays private on YouTube. Request the audit in the YouTube API Services form — it can take weeks.";

export const CONNECTIONS_COPY = {
  pageTitle: "Connections",
  pageDescription: (brand: string | null) =>
    brand === null
      ? "Social accounts this brand publishes to."
      : `Social accounts ${brand} publishes to. Each brand connects its own.`,
  connectSection: "Connect an account",
  connectedSection: "Connected accounts",
  connect: (label: string) => `Connect ${label}`,
  connecting: "Opening…",
  setupFirst: "Set up the app first",
  setupLink: "Settings → Integrations",
  emptyTitle: "No accounts connected yet",
  emptyBody:
    "Connect Instagram, TikTok, X, Threads, a Facebook Page, YouTube or LinkedIn to publish from FastGram.",
  reconnect: "Reconnect",
  disconnect: "Disconnect",
  disconnectConfirm: (handle: string) =>
    `Disconnect ${handle}? Scheduled posts for this account will wait until you reconnect it.`,
  refresh: "Check connection",
  refreshed: "Connection is working",
  disconnected: "Account disconnected",
  expiresOn: (date: string) => `Token renews automatically · expires ${date}`,
  noExpiry: "Token does not expire",
  permissionsMissing:
    "Permissions Missing — reconnect and approve all requested permissions.",
  connectedBanner: (label: string) => `${label} connected.`,
  choosePageTitle: "Choose the Facebook Page",
  choosePageBody:
    "Your Facebook account manages more than one Page. Pick the one this brand publishes to.",
  choosePage: "Use this Page",
  cancel: "Cancel",
} as const;

export const STATUS_COPY = {
  active: { label: "Connected", tone: "success" },
  expired: { label: "Connection Expired", tone: "danger" },
  paused: { label: "Paused: reconnect needed", tone: "warning" },
  revoked: { label: "Disconnected", tone: "neutral" },
} as const;

/** `details.reason` (o `?error=` del callback) → texto. */
export const REASON_COPY: Readonly<Record<string, string>> = {
  integration_not_configured:
    "Add this network's app credentials in Settings → Integrations first.",
  https_redirect_required:
    "This network only accepts https redirects. Start FastGram with the tunnel and add the https redirect URI in its developer console.",
  oauth_state_invalid:
    "That login link expired or was already used. Try connecting again.",
  oauth_state_wrong_brand:
    "This login was started from another brand. Switch back to it and connect again.",
  oauth_denied:
    "You declined a permission FastGram needs. Please try again and approve all requested permissions.",
  oauth_exchange_failed:
    "We could not confirm the connection yet. Check the redirect URI in the developer console and try again.",
  oauth_provider_unavailable:
    "Connecting isn't available right now. Try again in a moment.",
  no_pages:
    "This account has nothing to publish to (no Facebook Page, or no YouTube channel).",
  selection_expired: "The account selection expired. Connect again.",
  connection_expired: "Connection Expired. Reconnect to keep posting.",
  connection_inactive: "Paused: reconnect needed.",
  service_unavailable: "Connecting isn't available right now.",
};

export function reasonCopy(reason: string | null | undefined): string {
  return (
    (reason !== null && reason !== undefined && REASON_COPY[reason]) ||
    "Something went wrong while connecting. Try again."
  );
}
