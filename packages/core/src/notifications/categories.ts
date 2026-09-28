/**
 * Categorías de notificación — `P5-NOTIF-002/004`, PRD §13.2 y §13.4.
 *
 * El PRD pide preferencias "por categoría (publicación, fallos, cuota/billing,
 * leads, automations) y por canal". En el modo personal no hay billing ni
 * cuota (D-06) y los leads de Reddit ya tienen su badge (N-21); lo que el
 * piloto 24/7 necesita avisar es esto. Los códigos son estables: viajan en la
 * base (CHECK de `0028`), en el contrato y en el archivo de preferencias.
 */

export const NOTIFICATION_CATEGORIES = [
  "post_published",
  "post_failed",
  "tiktok_draft_ready",
  "connection_expired",
  "connection_expiring",
  "autopilot_rejected",
  "campaign_ready",
  "daily_summary",
  "queue_stuck",
  "queue_dead_letter",
  // Sprint 9 (R): la guardia de topes pausó (o no pudo pausar) una campaña paga.
  "ad_spend_cap",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export function isNotificationCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export type NotificationSeverityLevel = "info" | "success" | "warning" | "error";

export interface CategoryPreference {
  /** Si aparece en la campana. */
  readonly inApp: boolean;
  /** Si sale por los canales externos habilitados (ntfy, Telegram). */
  readonly push: boolean;
}

/**
 * Los defaults son **una elección nuestra**, no un dato del PRD (§13.4:
 * contenido exacto UNKNOWN). Criterio: afuera de la app sólo lo que pide que
 * hagas algo o que te enteres de que algo se rompió. Un post publicado o un
 * rechazo del piloto no te tienen que sonar el teléfono.
 */
export const DEFAULT_CATEGORY_PREFERENCES: Readonly<
  Record<NotificationCategory, CategoryPreference>
> = {
  post_published: { inApp: true, push: false },
  post_failed: { inApp: true, push: true },
  tiktok_draft_ready: { inApp: true, push: true },
  connection_expired: { inApp: true, push: true },
  connection_expiring: { inApp: true, push: true },
  autopilot_rejected: { inApp: true, push: false },
  campaign_ready: { inApp: true, push: true },
  daily_summary: { inApp: true, push: true },
  queue_stuck: { inApp: true, push: true },
  queue_dead_letter: { inApp: true, push: true },
  ad_spend_cap: { inApp: true, push: true },
};
