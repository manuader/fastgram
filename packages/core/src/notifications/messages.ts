/**
 * Qué dice cada aviso — `P5-NOTIF-004`, PRD §13.2.
 *
 * Un evento del dominio entra, un borrador de notificación sale: categoría,
 * severidad, título, cuerpo, link a la web y **clave de deduplicación**. La
 * clave es lo que hace idempotentes a los detectores del worker (miran
 * ventanas solapadas; la base descarta la repetida, `0028`).
 *
 * Los textos citan el PRD donde existe (N-09 `Connection Expired`, N-10 el de
 * LinkedIn). El resto es copy nueva, en inglés como toda la UI.
 *
 * **Nunca** va acá un mensaje crudo de proveedor: el `errorMessage` de un
 * post ya es el seguro de mostrar (lo escribe el publicador, PRD §10).
 */
import type { NotificationCategory, NotificationSeverityLevel } from "./categories.js";

export interface NotificationDraft {
  readonly category: NotificationCategory;
  readonly severity: NotificationSeverityLevel;
  readonly title: string;
  readonly body: string;
  /** Ruta de la web, relativa. */
  readonly link: string | null;
  readonly dedupeKey: string;
}

export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_BODY_MAX = 2000;

const PLATFORM_LABEL: Readonly<Record<string, string>> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  x: "X",
  threads: "Threads",
  facebook: "Facebook",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform;
}

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

function draft(d: NotificationDraft): NotificationDraft {
  return {
    ...d,
    title: clip(d.title.trim() === "" ? "FastGram" : d.title, NOTIFICATION_TITLE_MAX),
    body: clip(d.body, NOTIFICATION_BODY_MAX),
  };
}

const account = (username: string | null): string =>
  username === null || username === "" ? "" : ` (@${username.replace(/^@/u, "")})`;

/** `YYYY-MM-DD` UTC: para claves y para fechas en el cuerpo. */
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export type NotificationEvent =
  | {
      readonly kind: "post";
      readonly brand: string;
      readonly postId: string;
      readonly status: "POSTED" | "FAILED" | "IN_USER_INBOX";
      readonly platform: string;
      readonly username: string | null;
      readonly errorMessage: string | null;
    }
  | {
      readonly kind: "connection_expired";
      readonly brand: string;
      readonly connectionId: string;
      readonly platform: string;
      readonly username: string;
      /** El motivo (`expired`, `revoked`, `paused`, `token_expired`). */
      readonly reason: string;
      /** Para la clave: un aviso por vez que vence, no uno por barrido. */
      readonly sinceDay: string;
    }
  | {
      readonly kind: "connection_expiring";
      readonly brand: string;
      readonly connectionId: string;
      readonly platform: string;
      readonly username: string;
      readonly deadline: Date;
    }
  | {
      readonly kind: "autopilot_rejected";
      readonly brand: string;
      readonly rejected: number;
      readonly runAt: Date;
    }
  | {
      readonly kind: "campaign";
      readonly brand: string;
      readonly automationId: string;
      readonly name: string;
      readonly status: "REVIEW" | "FAILED";
    }
  | {
      readonly kind: "daily_summary";
      readonly brand: string;
      /** Día local de la marca, `YYYY-MM-DD`. */
      readonly day: string;
      readonly posted: number;
      readonly failed: number;
      readonly draftsWaiting: number;
      readonly scheduledNext24h: number;
      readonly queuedSuggestions: number;
    }
  | {
      readonly kind: "queue";
      readonly queue: string;
      readonly problem: "waiting" | "active" | "failed";
      readonly count: number;
      readonly oldest: Date;
      /** Cubo de tiempo para la clave (ver `queue-health.ts`). */
      readonly bucket: string;
    };

export function describeNotification(event: NotificationEvent): NotificationDraft {
  switch (event.kind) {
    case "post": {
      const where = `${platformLabel(event.platform)}${account(event.username)}`;
      if (event.status === "POSTED") {
        return draft({
          category: "post_published",
          severity: "success",
          title: `Posted on ${where}`,
          body: `${event.brand}: your post is live.`,
          link: "/calendar",
          dedupeKey: `post:POSTED:${event.postId}`,
        });
      }
      if (event.status === "IN_USER_INBOX") {
        return draft({
          category: "tiktok_draft_ready",
          severity: "info",
          title: `TikTok draft ready to finish${account(event.username)}`,
          body: `${event.brand}: open TikTok, add a sound if you want and post it.`,
          link: "/home",
          dedupeKey: `post:IN_USER_INBOX:${event.postId}`,
        });
      }
      return draft({
        category: "post_failed",
        severity: "error",
        title: `Post failed on ${where}`,
        body: `${event.brand}: ${event.errorMessage ?? "The post could not be published."}`,
        link: "/home",
        dedupeKey: `post:FAILED:${event.postId}`,
      });
    }
    case "connection_expired": {
      const label = platformLabel(event.platform);
      return draft({
        category: "connection_expired",
        severity: "error",
        // N-09 `Connection Expired` / `Paused: reconnect needed`.
        title:
          event.reason === "paused"
            ? `${label}: Paused: reconnect needed`
            : `${label}: Connection Expired`,
        body: `${event.brand}${account(event.username)}: reconnect to keep posting. Scheduled posts wait until you do.`,
        link: "/settings/connections",
        dedupeKey: `conn:expired:${event.connectionId}:${event.sinceDay}`,
      });
    }
    case "connection_expiring": {
      const label = platformLabel(event.platform);
      const day = isoDay(event.deadline);
      return draft({
        category: "connection_expiring",
        severity: "warning",
        title: `${label} connection expires on ${day}`,
        body:
          event.platform === "linkedin"
            ? // N-10, literal.
              `${event.brand}: LinkedIn connections last 60 days. Reconnect to keep posting without interruption.`
            : `${event.brand}${account(event.username)}: reconnect before ${day} to keep posting without interruption.`,
        link: "/settings/connections",
        dedupeKey: `conn:expiring:${event.connectionId}:${day}`,
      });
    }
    case "autopilot_rejected":
      return draft({
        category: "autopilot_rejected",
        severity: "info",
        title: `Autopilot rejected ${String(event.rejected)} piece${event.rejected === 1 ? "" : "s"}`,
        body: `${event.brand}: they didn't pass the pre-check. See why in Today.`,
        link: "/home",
        dedupeKey: `autopilot:${event.runAt.toISOString()}`,
      });
    case "campaign":
      return event.status === "REVIEW"
        ? draft({
            category: "campaign_ready",
            severity: "info",
            title: `Campaign ready to review: ${event.name}`,
            body: `${event.brand}: the pieces are generated. Review them and launch.`,
            link: `/automations/${event.automationId}`,
            dedupeKey: `campaign:REVIEW:${event.automationId}`,
          })
        : draft({
            category: "campaign_ready",
            severity: "error",
            title: `Campaign failed: ${event.name}`,
            body: `${event.brand}: the campaign stopped. Open it to see what happened.`,
            link: `/automations/${event.automationId}`,
            dedupeKey: `campaign:FAILED:${event.automationId}`,
          });
    case "daily_summary": {
      const parts = [
        `${String(event.posted)} posted`,
        `${String(event.failed)} failed`,
        `${String(event.scheduledNext24h)} scheduled next 24 h`,
      ];
      if (event.draftsWaiting > 0) {
        parts.push(`${String(event.draftsWaiting)} TikTok draft(s) to finish`);
      }
      if (event.queuedSuggestions > 0) {
        parts.push(`${String(event.queuedSuggestions)} waiting in Blitz`);
      }
      return draft({
        category: "daily_summary",
        severity: event.failed > 0 ? "warning" : "info",
        title: `${event.brand}: daily summary`,
        body: `Yesterday: ${parts.join(" · ")}.`,
        link: "/home",
        dedupeKey: `daily:${event.day}`,
      });
    }
    case "queue": {
      const n = String(event.count);
      const since = event.oldest.toISOString().slice(0, 16).replace("T", " ");
      if (event.problem === "failed") {
        return draft({
          category: "queue_dead_letter",
          severity: "error",
          title: `${n} job(s) failed for good in ${event.queue}`,
          body: `They ran out of retries (first at ${since} UTC). Check the worker log.`,
          link: null,
          dedupeKey: `queue:failed:${event.queue}:${event.bucket}`,
        });
      }
      return draft({
        category: "queue_stuck",
        severity: "warning",
        title:
          event.problem === "waiting"
            ? `${n} job(s) waiting in ${event.queue}`
            : `${n} job(s) stuck running in ${event.queue}`,
        body:
          event.problem === "waiting"
            ? `Nothing has picked them up since ${since} UTC. Is the worker running, and is that queue mounted?`
            : `Running since ${since} UTC, past their timeout. The worker may be hung — restart it.`,
        link: null,
        dedupeKey: `queue:${event.problem}:${event.queue}:${event.bucket}`,
      });
    }
  }
}
