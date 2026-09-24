/**
 * "Today" · `PU-UI-002` (`docs/PLAN-USO-PERSONAL.md` §7): qué sale hoy en todas
 * las marcas, qué falló, qué espera al usuario. Esto es la aritmética pura; los
 * datos están en `data.ts` y el dibujo en `components/today`.
 *
 * ## Una sola lectura de `GET /calendar?brands=all`
 *
 * El proxy de la web sólo reenvía la marca de su cookie, así que "todas las
 * marcas" lo tiene que resolver la API: el calendario es el único endpoint que
 * lo hace. Se pide **una** ventana, `[hoy − 30 días, mañana)` en la zona del
 * navegador, y de ahí salen las tres listas:
 *
 * - **el timeline**: lo de hoy;
 * - **los fallidos**: `FAILED` de los últimos 7 días (contados desde ahora, no
 *   desde la medianoche: "la última semana" es una ventana móvil);
 * - **los borradores de TikTok**: todo `IN_USER_INBOX` de la ventana. Un
 *   borrador de hace 20 días sigue pendiente: por eso la ventana es de 30 y no
 *   de 7. Lo que haya más atrás lo delata `counts.inbox`, que es global (ver
 *   {@link olderDrafts}).
 *
 * 31 días entran de sobra en el techo de 62 (`CALENDAR_RANGE_MAX_DAYS`).
 *
 * ## "Hoy" es el de la zona del navegador
 *
 * Como en el Calendar (`lib/calendar/calendar.ts`, `browserTimeZone`): es una
 * aproximación a la del usuario. Cada marca tiene su zona, pero "hoy" es del
 * que mira la pantalla, no de la marca.
 */
import type { CalendarItem } from "@fastgram/contracts";
import { dayKeyOf } from "../calendar/calendar";
import { shiftDay, wallTimeToUtc } from "../calendar/board";

const DAY_MS = 86_400_000;

/** Días hacia atrás que se miran para encontrar borradores de TikTok pendientes. */
export const DRAFTS_LOOKBACK_DAYS = 30;
/** "Fallidos recientes": ventana móvil desde ahora. */
export const FAILED_LOOKBACK_DAYS = 7;
/** Cadencia de refresco de toda la pantalla (brief de `PU-UI-002`). */
export const TODAY_REFRESH_MS = 30_000;

export interface TodayWindow {
  /** `YYYY-MM-DD` de hoy en la zona. */
  readonly todayKey: string;
  /** Medianoche de hoy, inclusiva. */
  readonly dayStart: number;
  /** Medianoche de mañana, exclusiva. Es también el `to` de la consulta. */
  readonly dayEnd: number;
  /** El `from` de la consulta: medianoche de hace {@link DRAFTS_LOOKBACK_DAYS} días. */
  readonly queryFrom: number;
}

export function todayWindow(nowMs: number, timeZone: string): TodayWindow {
  const todayKey = dayKeyOf(nowMs, timeZone);
  return {
    todayKey,
    dayStart: wallTimeToUtc(todayKey, 0, timeZone),
    dayEnd: wallTimeToUtc(shiftDay(todayKey, 1), 0, timeZone),
    queryFrom: wallTimeToUtc(shiftDay(todayKey, -DRAFTS_LOOKBACK_DAYS), 0, timeZone),
  };
}

type ItemStatus = CalendarItem["status"];

/**
 * Lo que "todavía va a salir hoy". `AWAITING_RECONNECT` no entra: parado hasta
 * que el usuario reconecte, no va a salir solo, y contarlo como programado
 * sería prometer una publicación que no ocurre.
 */
const UPCOMING: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  "PLANNED",
  "BUILDING",
  "CREATED",
  "SCHEDULED",
  "UPLOADING_TO_TIKTOK",
]);

/** Lo que no se dibuja en el timeline: ya no va a salir ni salió. */
const HIDDEN_IN_TIMELINE: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  "CANCELLED",
  "DELETED",
]);

export function isUpcoming(status: ItemStatus): boolean {
  return UPCOMING.has(status);
}

/** Por hora; el id desempata para que dos a la misma hora no bailen entre refrescos. */
function byTime(a: CalendarItem, b: CalendarItem): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface TodayCounts {
  readonly postedToday: number;
  readonly scheduledToday: number;
  readonly failedRecent: number;
}

export interface TodayView {
  /** Hoy, por hora, sin cancelados ni borrados. */
  readonly timeline: readonly CalendarItem[];
  /** `IN_USER_INBOX` de toda la ventana, el más viejo primero (el que más espera). */
  readonly drafts: readonly CalendarItem[];
  /** `FAILED` de los últimos 7 días, el más nuevo primero. */
  readonly failed: readonly CalendarItem[];
  readonly counts: TodayCounts;
}

export function buildTodayView(
  items: readonly CalendarItem[],
  window: TodayWindow,
  nowMs: number,
): TodayView {
  const failedSince = nowMs - FAILED_LOOKBACK_DAYS * DAY_MS;
  const timeline: CalendarItem[] = [];
  const drafts: CalendarItem[] = [];
  const failed: CalendarItem[] = [];

  for (const item of items) {
    const isToday = item.at >= window.dayStart && item.at < window.dayEnd;
    if (isToday && !HIDDEN_IN_TIMELINE.has(item.status)) timeline.push(item);
    if (item.status === "IN_USER_INBOX") drafts.push(item);
    if (item.status === "FAILED" && item.at >= failedSince && item.at < window.dayEnd) {
      failed.push(item);
    }
  }

  timeline.sort(byTime);
  drafts.sort(byTime);
  failed.sort((a, b) => byTime(b, a));

  return {
    timeline,
    drafts,
    failed,
    counts: {
      postedToday: timeline.filter((i) => i.status === "POSTED").length,
      scheduledToday: timeline.filter((i) => isUpcoming(i.status)).length,
      failedRecent: failed.length,
    },
  };
}

/**
 * Borradores de TikTok pendientes que quedaron **fuera** de la ventana.
 * `counts.inbox` del calendario es global (no del rango), así que la resta es
 * lo que no se ve. Nunca negativo: si la API contó distinto, no se inventa.
 */
export function olderDrafts(inboxTotal: number, visible: number): number {
  return Math.max(0, inboxTotal - visible);
}

export type DayPart = "morning" | "afternoon" | "evening";

/** Para el saludo. 05–12 mañana, 12–19 tarde, el resto noche. */
export function dayPartOf(nowMs: number, timeZone: string): DayPart {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone,
    }).format(new Date(nowMs)),
  );
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 19) return "afternoon";
  return "evening";
}

/** "Thursday, September 24". */
export function formatTodayDate(nowMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone,
  }).format(new Date(nowMs));
}

/** "Sep 21", para lo que no es de hoy (fallidos, borradores viejos). */
export function formatShortDate(msEpoch: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(msEpoch));
}

/** La miniatura del calendario puede ser un video: no se mete en un `<img>`. */
export function isVideoUrl(url: string): boolean {
  try {
    return /\.(mp4|mov|webm|m4v)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
