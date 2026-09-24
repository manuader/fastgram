import type { CalendarItem } from "@fastgram/contracts";
import type { CopyKey } from "@/lib/i18n/t";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

/**
 * El estado de un ítem del timeline en las cinco palabras que importan hoy.
 * Más grueso que `POST_STATUS_COPY` a propósito: `BUILDING`, `CREATED` y
 * `SCHEDULED` son, para quien mira qué sale hoy, lo mismo —"va a salir"—.
 *
 * `IN_USER_INBOX` es `warning`, no `danger` (PRD:1414): TikTok lo aceptó y
 * espera al usuario. Pintarlo de error invita a republicarlo, y eso duplica.
 */
export function statusOf(status: CalendarItem["status"]): {
  readonly key: CopyKey;
  readonly tone: StatusTone;
} {
  switch (status) {
    case "PLANNED":
      return { key: "today.status.planned", tone: "neutral" };
    case "BUILDING":
    case "CREATED":
    case "SCHEDULED":
      return { key: "today.status.scheduled", tone: "info" };
    case "UPLOADING_TO_TIKTOK":
      return { key: "today.status.publishing", tone: "info" };
    case "POSTED":
      return { key: "today.status.posted", tone: "success" };
    case "FAILED":
      return { key: "today.status.failed", tone: "danger" };
    case "IN_USER_INBOX":
      return { key: "today.status.draft", tone: "warning" };
    case "AWAITING_RECONNECT":
      return { key: "today.status.reconnect", tone: "warning" };
    case "CANCELLED":
      return { key: "posts.status.cancelled", tone: "neutral" };
    case "DELETED":
      return { key: "posts.status.deleted", tone: "neutral" };
  }
}
