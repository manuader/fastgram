/**
 * Cuándo se vuelven a pedir las métricas de un post — `PU-AUTO-004`
 * (`= P3-METRIC-001`), PRD §9.5 #10, `NFR-016`.
 *
 * ## Los números, y de dónde salen
 *
 * Ninguna plataforma publica «cada cuánto conviene leer». Son decisiones
 * nuestras, escritas acá una sola vez:
 *
 * - **Ventana de 30 días** desde `postedAt`. Pasado eso el post casi no se
 *   mueve y leerlo es gasto (en X, plata; en Meta, cuota de llamadas).
 * - **Cada 1 h durante las primeras 48 h**, porque es cuando el número cambia
 *   y cuando el usuario mira «¿cómo le fue a lo de hoy?». 48 h coincide con lo
 *   que dice Instagram: *«data used to calculate metrics can be delayed up to
 *   48 hours»* (Media Insights): antes de eso el número todavía se asienta.
 * - **Cada 24 h después**, hasta los 30 días.
 * - **Cada 24 h siempre** en una red que **cobra la lectura** (X: US$0,005 por
 *   post, ver `adapters/metrics/x.ts`). Leer X cada hora durante 48 h serían
 *   48 lecturas por post solo el primer par de días; así son ~30 en total.
 *
 * El cron del worker corre cada hora; un post es «debido» si pasó el
 * intervalo **menos {@link METRICS_SYNC_SLACK_MS}**. Sin esa holgura, un sync
 * que terminó a las 10:00:30 no estaría debido a las 11:00:05 y el intervalo
 * real sería de 2 h.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const METRICS_SYNC_WINDOW_DAYS = 30;
export const METRICS_RECENT_WINDOW_HOURS = 48;
export const METRICS_RECENT_INTERVAL_MS = HOUR_MS;
export const METRICS_SETTLED_INTERVAL_MS = DAY_MS;
/** Para las redes con `costPerPostReadUsd > 0`. */
export const METRICS_PAID_READ_INTERVAL_MS = DAY_MS;
export const METRICS_SYNC_SLACK_MS = 5 * 60_000;
/** Cron del job `metrics-sync` (UTC): cada hora, a los 7 minutos. */
export const METRICS_SYNC_CRON = "7 * * * *";

export interface MetricsSyncCandidate {
  readonly postedAtMs: number;
  /** `null` = nunca se sincronizó (pre-sync, `NFR-016`). */
  readonly syncedAtMs: number | null;
  /** US$ por lectura de la red (`SocialMetricsCapabilities.costPerPostReadUsd`). */
  readonly costPerPostReadUsd: number;
}

/** El inicio de la ventana de sync: los posts publicados desde acá entran. */
export function metricsWindowStartMs(nowMs: number): number {
  return nowMs - METRICS_SYNC_WINDOW_DAYS * DAY_MS;
}

/** Cada cuánto se lee un post de esta edad en una red de este costo. */
export function metricsSyncIntervalMs(ageMs: number, costPerPostReadUsd: number): number {
  if (costPerPostReadUsd > 0) return METRICS_PAID_READ_INTERVAL_MS;
  return ageMs < METRICS_RECENT_WINDOW_HOURS * HOUR_MS
    ? METRICS_RECENT_INTERVAL_MS
    : METRICS_SETTLED_INTERVAL_MS;
}

/**
 * ¿Toca leerlo ahora? Fuera de la ventana, nunca; nunca sincronizado, sí; si
 * no, según el intervalo de su edad. Un `postedAt` en el futuro (reloj
 * corrido de la plataforma) se trata como recién publicado.
 */
export function isMetricsSyncDue(c: MetricsSyncCandidate, nowMs: number): boolean {
  if (c.postedAtMs < metricsWindowStartMs(nowMs)) return false;
  if (c.syncedAtMs === null) return true;
  const ageMs = Math.max(0, nowMs - c.postedAtMs);
  const interval = metricsSyncIntervalMs(ageMs, c.costPerPostReadUsd);
  return nowMs - c.syncedAtMs >= interval - METRICS_SYNC_SLACK_MS;
}
