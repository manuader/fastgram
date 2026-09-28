/**
 * Cómo se muestra cada estado y motivo de Ads. Las claves de copy viven en
 * `lib/i18n/messages.ts` (`ads.*`).
 */
import type { AdCampaignSummary } from "@fastgram/contracts";
import type { CopyKey } from "@/lib/i18n/t";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export function campaignStatusTone(
  c: Pick<AdCampaignSummary, "status" | "pausedReason">,
): Tone {
  if (c.status === "ACTIVE") return "success";
  if (c.status === "ARCHIVED") return "neutral";
  return c.pausedReason === "daily_cap" || c.pausedReason === "total_cap"
    ? "warning"
    : "neutral";
}

export function campaignStatusKey(
  c: Pick<AdCampaignSummary, "status" | "pausedReason">,
): CopyKey {
  if (c.status === "ACTIVE") return "ads.status.active";
  if (c.status === "ARCHIVED") return "ads.status.archived";
  switch (c.pausedReason) {
    case "daily_cap":
      return "ads.status.pausedDaily";
    case "total_cap":
      return "ads.status.pausedTotal";
    case "created":
      return "ads.status.draft";
    default:
      return "ads.status.paused";
  }
}

const REASON_KEYS: Readonly<Record<string, CopyKey>> = {
  ads_not_connected: "ads.reason.notConnected",
  integration_not_configured: "ads.reason.integration",
  public_media_unavailable: "ads.reason.publicMedia",
  preview_required: "ads.reason.previewRequired",
  preview_expired: "ads.reason.previewExpired",
  preview_used: "ads.reason.previewUsed",
  preview_mismatch: "ads.reason.previewMismatch",
  total_cap_reached: "ads.reason.totalCapReached",
  budget_change_limit: "ads.reason.budgetLimit",
  budget_too_low: "ads.reason.budgetTooLow",
  destination_required: "ads.reason.destinationRequired",
  ab_needs_two_pieces: "ads.reason.abTwoPieces",
  daily_exceeds_total: "ads.reason.dailyExceedsTotal",
  daily_too_small_for_variants: "ads.reason.dailyTooSmall",
  unauthorized: "ads.reason.unauthorized",
  permission_missing: "ads.reason.permissionMissing",
  account_disabled: "ads.reason.accountDisabled",
  rate_limited: "ads.reason.rateLimited",
  active_campaigns: "ads.reason.activeCampaigns",
  oauth_denied: "ads.reason.oauthDenied",
  oauth_state_invalid: "ads.reason.oauthState",
};

/** Copy de un motivo estable; `null` si no lo conocemos (se usa el genérico). */
export function reasonKey(reason: string | null): CopyKey | null {
  return reason === null ? null : (REASON_KEYS[reason] ?? null);
}

/** 0–1, tope en 1: para las barras de gasto contra tope. */
export function spendRatio(spent: number, cap: number): number {
  return cap <= 0 ? 0 : Math.min(1, spent / cap);
}
