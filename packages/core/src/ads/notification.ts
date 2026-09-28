/**
 * El aviso del corte automático — sprint 9 (R), `D-21`. Va por el sistema de
 * avisos existente (campana + ntfy/Telegram, `P5-NOTIF`) con la categoría
 * `ad_spend_cap`, que sale por push por defecto: es plata.
 */
import type { NotificationDraft } from "../notifications/messages.js";
import type { GuardEvent } from "./guard.js";
import { minorToMajor } from "./money.js";

export function formatAdMoney(minor: number, currency: string): string {
  const major = minorToMajor(minor, currency);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

export function describeAdCapEvent(
  brand: string,
  event: GuardEvent,
  currency: string,
): NotificationDraft {
  const cap = event.breach === "total_cap" ? "total" : "daily";
  const spent = formatAdMoney(event.spentMinor, currency);
  const limit = formatAdMoney(event.capMinor, currency);
  const prefix = brand.trim() === "" ? "" : `${brand}: `;
  const title = event.paused
    ? `${prefix}ad campaign paused at its ${cap} cap`
    : `${prefix}ad campaign hit its ${cap} cap and could NOT be paused`;
  const body = event.paused
    ? `"${event.campaignName}" spent ${spent} of its ${cap} cap of ${limit}. FastGram paused it; resuming needs your confirmation.`
    : `"${event.campaignName}" spent ${spent} of its ${cap} cap of ${limit}, and Meta rejected the pause. Pause it in Ads Manager now.`;
  return {
    category: "ad_spend_cap",
    severity: event.paused ? "warning" : "error",
    title: title.slice(0, 200),
    body: body.slice(0, 2000),
    link: `/ads/${event.campaignId}`,
    dedupeKey: `ad_cap:${event.campaignId}:${event.breach}:${event.day}:${event.paused ? "paused" : "failed"}`,
  };
}
