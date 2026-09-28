/**
 * Copy de notificaciones (sprint 7). Local, como `lib/connections/copy.ts`:
 * la pantalla es de un solo agente y el catálogo compartido lo editan otros
 * seis a la vez. Inglés, como toda la UI.
 */
import type { NotificationCategoryId, NotificationTestError } from "@fastgram/contracts";

export const NOTIFICATIONS_COPY = {
  bellLabel: "Notifications",
  bellLabelUnread: (n: number) => `Notifications, ${String(n)} unread`,
  panelTitle: "Notifications",
  markAll: "Mark all as read",
  emptyTitle: "You're all caught up",
  emptyBody:
    "Published and failed posts, TikTok drafts, expiring connections and queue problems show up here.",
  loadError: "Couldn't load notifications.",
  retry: "Retry",
  settingsLink: "Notification settings",
  unreadDot: "Unread",
  justNow: "just now",

  bannerExpired: (platform: string, account: string, brand: string) =>
    `${platform} (${account}) disconnected for ${brand}. Scheduled posts wait until you reconnect.`,
  bannerExpiring: (platform: string, account: string, brand: string, date: string) =>
    `${platform} (${account}) for ${brand} expires on ${date}. Reconnect to keep posting without interruption.`,
  bannerMore: (n: number) => `+${String(n)} more`,
  reconnect: "Reconnect",
  dismiss: "Dismiss",

  pageTitle: "Notifications",
  pageDescription:
    "What the autopilot tells you, and where. In-app shows in the bell; push goes to your phone through ntfy or Telegram.",
  categoriesTitle: "Categories",
  columnInApp: "In-app",
  columnPush: "Push",
  channelsTitle: "Push channels",
  channelsHint:
    "Nothing is sent outside the app until you set up a channel. Tokens are stored on this machine (~/.fastgram/notifications.json) and never shown again.",
  ntfyTitle: "ntfy",
  ntfyHint:
    "Install the ntfy app, subscribe to a long random topic and paste its URL (https://ntfy.sh/your-topic). Anyone who knows a topic on ntfy.sh can read it — keep it secret.",
  ntfyUrl: "Topic URL",
  ntfyToken: "Access token (optional, for your own server)",
  telegramTitle: "Telegram",
  telegramHint:
    "Create a bot with @BotFather, send it any message, then paste the bot token and your chat id.",
  telegramToken: "Bot token",
  telegramChat: "Chat id",
  enabled: "Enabled",
  save: "Save",
  saved: "Saved",
  remove: "Remove",
  sendTest: "Send test",
  keepSecret: "Leave empty to keep the saved one",
  dailyHour: "Daily summary after (brand's local hour)",
  testOk: "Test sent. Check your phone.",
  saveError: "Couldn't save. Check the fields and try again.",
} as const;

export const CATEGORY_LABEL: Readonly<Record<NotificationCategoryId, string>> = {
  post_published: "Post published",
  post_failed: "Post failed",
  tiktok_draft_ready: "TikTok draft ready to finish",
  connection_expired: "Connection expired",
  connection_expiring: "Connection about to expire",
  autopilot_rejected: "Autopilot rejected pieces",
  campaign_ready: "Campaign ready to review",
  daily_summary: "Daily summary",
  queue_stuck: "Queue stuck",
  queue_dead_letter: "Jobs failed for good",
  ad_spend_cap: "Ad campaign hit its spend cap",
};

export const TEST_ERROR_COPY: Readonly<Record<NotificationTestError, string>> = {
  not_configured: "Save this channel first.",
  unauthorized: "The token was rejected. Check it, or that the bot can message you.",
  not_found: "Topic or chat not found. Check the URL or chat id.",
  rate_limited: "Too many messages right now. Try again in a minute.",
  bad_request:
    "The service rejected the message. Check the chat id — send your bot a message first.",
  unavailable: "Couldn't reach the service. Check your connection.",
  timeout: "The service didn't answer in time.",
};

export const PLATFORM_NAME: Readonly<Record<string, string>> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  x: "X",
  threads: "Threads",
  facebook: "Facebook",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

/** "3 min ago", "2 h ago", "Sep 21". Relativo a `nowMs`. */
export function relativeTime(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return NOTIFICATIONS_COPY.justNow;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${String(min)} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${String(h)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
