/**
 * Presentación de Engagement: motivo → copy, nivel del medidor → tono y
 * textos, tier → etiqueta. Puro (sin React) para poder testearlo.
 *
 * Nada de acá **decide** un nivel ni un ratio: los recibe de la API, que los
 * calcula en código (`DP-003`). Sólo los formatea.
 */
import type {
  BanMeter,
  EngagementErrorReason,
  Lead,
  LeadDetail,
} from "@fastgram/contracts";
import type { CopyKey } from "@/lib/i18n/t";
import { isApiRequestError } from "@/lib/api/errors";

export type BanLevel = BanMeter["level"];

export const BAN_LEVEL_TONE: Readonly<
  Record<BanLevel, "success" | "info" | "warning" | "danger">
> = {
  safe: "success",
  caution: "info",
  warning: "warning",
  danger: "danger",
};

export function banLevelKey(level: BanLevel): CopyKey {
  return `engagement.banMeter.level.${level}`;
}

export function banRecommendationKey(level: BanLevel): CopyKey {
  return `engagement.banMeter.recommendation.${level}`;
}

/** `0.3` → `"30"`. `null` → `null`. */
export function percent(ratio: number | null): string | null {
  return ratio === null ? null : String(Math.round(ratio * 100));
}

/** El motivo estable de un rechazo de la API (`error.details.reason`). */
export function reasonOf(error: unknown): string | null {
  if (!isApiRequestError(error)) return null;
  const r = error.details?.["reason"];
  return typeof r === "string" ? r : null;
}

const ERROR_KEYS: Readonly<Partial<Record<EngagementErrorReason, CopyKey>>> = {
  reddit_rejected: "engagement.error.reddit_rejected",
  reddit_unavailable: "engagement.error.reddit_unavailable",
  reddit_rate_limited: "engagement.error.reddit_rate_limited",
  lead_locked: "engagement.error.lead_locked",
  oauth_state_wrong_brand: "engagement.error.oauth_state_wrong_brand",
  oauth_state_invalid: "engagement.error.oauth_state_invalid",
  oauth_denied: "engagement.error.oauth_denied",
  invalid_reddit_url: "engagement.addManual.invalidUrl",
  reddit_app_not_configured: "engagement.blocked.reddit_app_not_configured",
  reddit_not_connected: "engagement.blocked.reddit_not_connected",
  reddit_reconnect_required: "engagement.blocked.reddit_reconnect_required",
  ban_meter_danger: "engagement.blocked.ban_meter_danger",
  reply_blocked: "engagement.blocked.reply_blocked",
};

/** Copy de un motivo; el genérico si no se conoce. */
export function reasonKey(reason: string | null): CopyKey {
  if (reason === null) return "engagement.error.generic";
  return ERROR_KEYS[reason as EngagementErrorReason] ?? "engagement.error.generic";
}

export function blockedKey(reason: LeadDetail["sendBlockedReason"]): CopyKey | null {
  return reason === null ? null : reasonKey(reason);
}

export function issueKey(issue: LeadDetail["draftIssues"][number]): CopyKey {
  return `engagement.reply.issue.${issue}`;
}

/** La etiqueta de la tarjeta del lead. */
export function tierLabelKey(
  lead: Pick<Lead, "tier" | "scoreStatus" | "source">,
): CopyKey {
  if (lead.scoreStatus === "pending") return "engagement.tier.pending";
  if (lead.scoreStatus !== "scored") {
    return lead.source === "manual"
      ? "engagement.tier.manual"
      : "engagement.tier.unscored";
  }
  if (lead.tier === "top") return "engagement.tier.top";
  return lead.source === "manual" ? "engagement.tier.manual" : "engagement.tier.general";
}

/** Subreddits o palabras clave de un textarea: una por línea o separadas por coma. */
export function splitList(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Los componentes del score que explican el lead, de mayor a menor. */
export function strongSignals(
  components: NonNullable<Lead["scoreComponents"]>,
): Array<{ key: CopyKey; value: number }> {
  const order = ["buyingSignal", "fitToAudience", "hasProblem", "replyWelcome"] as const;
  return order
    .map((k) => ({ key: `engagement.why.${k}` as CopyKey, value: components[k] }))
    .sort((a, b) => b.value - a.value);
}
