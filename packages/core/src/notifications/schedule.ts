/**
 * Cuándo corren los barridos de notificaciones y cuándo se considera
 * atascada una cola — `P1-OBS-005`, `P5-NOTIF-004`.
 *
 * Todos los números son **nuestros** (ninguno sale del PRD) y están acá, con
 * su razón, para que el worker no tenga literales.
 */
import { localDateOf, localDayRange, parseLocalDate } from "../autopilot/policy.js";

/** `YYYY-MM-DD` menos un día, en el calendario civil. */
function previousDay(key: string): string | null {
  const civil = parseLocalDate(key);
  if (civil === null) return null;
  return new Date(Date.UTC(civil.year, civil.month - 1, civil.day - 1))
    .toISOString()
    .slice(0, 10);
}

/** Cada cuánto se miran los hechos (posts, piloto, campañas) y se despacha el push. */
export const NOTIFICATION_EVENTS_EVERY_MS = 30_000;
/**
 * Hasta dónde hacia atrás mira el detector de eventos. Más largo que la vuelta
 * a propósito: si el worker estuvo caído un rato, al volver avisa lo que pasó
 * mientras tanto. La repetición la descarta la clave de deduplicación.
 */
export const NOTIFICATION_EVENTS_LOOKBACK_MS = 6 * 60 * 60_000;
/** Conexiones y resumen diario: no cambian de un minuto a otro. */
export const NOTIFICATION_SLOW_SWEEP_EVERY_MS = 15 * 60_000;
/** Salud de la cola. */
export const QUEUE_HEALTH_EVERY_MS = 5 * 60_000;

/**
 * **N de la cola atascada**: un job que puede correr (`start_after` ya pasó)
 * y nadie tomó en 15 minutos. El más lento de los recurrentes corre cada 15
 * (`automation-generation`), y un build dura 30 s – 2 min: 15 minutos
 * esperando no es carga, es que nadie consume esa cola.
 */
export const QUEUE_WAITING_ALERT_MINUTES = 15;
/**
 * Un job `active` más allá de su propio `expire_in` + este margen: pg-boss lo
 * expira solo cuando el mantenimiento corre, así que si sigue ahí, el worker
 * que lo tomó está colgado o el mantenimiento murió.
 */
export const QUEUE_ACTIVE_MARGIN_MINUTES = 10;
/**
 * Un aviso por cola y problema cada 6 horas como mucho (atascos) y cada hora
 * (fallos definitivos). Sin cubo, una cola atascada avisaría cada 5 minutos.
 */
export const QUEUE_STUCK_REPEAT_MS = 6 * 60 * 60_000;
export const QUEUE_FAILED_REPEAT_MS = 60 * 60_000;

/** Reintentos de un push antes de darlo por `failed`. */
export const PUSH_MAX_ATTEMPTS = 5;
/** Un push más viejo que esto ya no se manda: avisaría tarde algo resuelto. */
export const PUSH_MAX_AGE_MS = 24 * 60 * 60_000;

export function queueAlertBucket(
  problem: "waiting" | "active" | "failed",
  nowMs: number,
): string {
  const size = problem === "failed" ? QUEUE_FAILED_REPEAT_MS : QUEUE_STUCK_REPEAT_MS;
  return String(Math.floor(nowMs / size));
}

/** La hora local (0–23) en la zona. */
export function localHourOf(nowMs: number, timeZone: string): number {
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(nowMs));
  const hour = Number(text);
  return Number.isInteger(hour) ? hour % 24 : 0;
}

export interface DailySummaryWindow {
  /** El día que se resume (ayer, local), `YYYY-MM-DD`. Es también la clave. */
  readonly day: string;
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * Si ya toca el resumen de hoy: a partir de `hour` local, se resume **ayer**
 * (el día completo). Antes de esa hora, `null`. La clave es el día resumido,
 * así que sale una sola vez aunque el barrido pase cada 15 minutos.
 */
export function dailySummaryWindow(
  nowMs: number,
  timeZone: string,
  hour: number,
): DailySummaryWindow | null {
  let zone = timeZone;
  try {
    localHourOf(nowMs, zone);
  } catch {
    zone = "UTC";
  }
  if (localHourOf(nowMs, zone) < hour) return null;
  const today = localDateOf(nowMs, zone);
  const day = previousDay(today);
  const civil = day === null ? null : parseLocalDate(day);
  if (day === null || civil === null) return null;
  const range = localDayRange(civil, zone);
  return { day, fromMs: range.fromMs, toMs: range.toMs };
}
