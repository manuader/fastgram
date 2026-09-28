/**
 * El planificador semanal de reels — la parte de calendario y cupo
 * (sprint 9, U, `PU-S9-014`). Puro: fechas en texto `YYYY-MM-DD` (día local
 * de la marca), la zona la resuelve `Intl` (está en el runtime, no es npm).
 *
 * ## La semana
 *
 * Un plan por marca y **semana ISO** (lunes a domingo, en la zona de la
 * marca): es la clave de idempotencia `(marca, semana)`. Planificar un
 * miércoles reparte el cupo entre miércoles y domingo — «los próximos días
 * de esta semana» — y el lunes siguiente arranca un plan nuevo. Un plan móvil
 * de 7 días desde hoy se superpondría con el de ayer y no tendría una clave
 * natural.
 *
 * ## El cupo
 *
 * `formatMix` de la estrategia (`brand_strategies.format_mix`) es un mapa de
 * **pesos relativos** por tipo que ya admitía `reel` (el enum de contenido lo
 * tiene desde 0038) y que nadie más lee. La parte de reels es
 * `reel / (reel + resto)`; si el mapa no pesa ningún otro formato, el resto es
 * 100 (el content mix de Blitz suma 100 por contrato). Reels por semana =
 * `round(7 × piezas por día × parte)`, entre 0 y {@link REEL_WEEKLY_MAX}.
 *
 * Piezas por día = el **máximo** de las redes activas (una pieza aprobada va a
 * todas, `autopilotAcceptCapacity`), con el `dailyCap` como techo.
 */

export const REEL_PLANNER_HORIZON_DAYS = 7;
/** Tope nuestro: dos reels por día. Un render por reel en esta Mac es 1–2 min. */
export const REEL_WEEKLY_MAX = 14;
/** El resto del mix cuando la estrategia sólo pesa `reel` (el mix de Blitz suma 100). */
export const REEL_MIX_REST_DEFAULT = 100;

export interface ReelQuotaNetwork {
  readonly enabled: boolean;
  readonly perDay: number;
  readonly dailyCap: number;
}

export interface ReelQuotaStrategy {
  readonly networks: readonly ReelQuotaNetwork[];
  readonly formatMix: Readonly<Record<string, number>>;
}

/** Piezas por día de la marca: el máximo entre sus redes activas. */
export function reelPiecesPerDay(networks: readonly ReelQuotaNetwork[]): number {
  let best = 0;
  for (const n of networks) {
    if (!n.enabled) continue;
    best = Math.max(best, Math.max(0, Math.min(n.perDay, n.dailyCap)));
  }
  return best;
}

/** La parte de reels del mix, en [0, 1]. */
export function reelMixShare(formatMix: Readonly<Record<string, number>>): number {
  const reel = Math.max(0, formatMix["reel"] ?? 0);
  if (reel === 0) return 0;
  let rest = 0;
  for (const [type, weight] of Object.entries(formatMix)) {
    if (type !== "reel") rest += Math.max(0, weight);
  }
  if (rest === 0) rest = REEL_MIX_REST_DEFAULT;
  return reel / (reel + rest);
}

/** Reels por semana según la estrategia. */
export function reelWeeklyQuota(strategy: ReelQuotaStrategy): number {
  const raw =
    REEL_PLANNER_HORIZON_DAYS *
    reelPiecesPerDay(strategy.networks) *
    reelMixShare(strategy.formatMix);
  return Math.min(REEL_WEEKLY_MAX, Math.max(0, Math.round(raw)));
}

// ── fechas locales ───────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** El día local (`YYYY-MM-DD`) de `ms` en `timeZone`. Zona inválida → UTC. */
export function reelLocalDateOf(ms: number, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function toUtcMs(date: string): number {
  const m = DATE_RE.exec(date);
  if (m === null) throw new Error(`fecha inválida: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function reelAddDays(date: string, days: number): string {
  return new Date(toUtcMs(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** El lunes de la semana ISO de `date`. */
export function reelWeekStartOf(date: string): string {
  const dow = new Date(toUtcMs(date)).getUTCDay(); // 0 domingo … 6 sábado
  return reelAddDays(date, -((dow + 6) % 7));
}

/** Días entre dos fechas (`b − a`). */
export function reelDaysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

/**
 * Los días de los `quota` reels de la semana que empieza en `weekStart`,
 * repartidos parejo entre `today` y el domingo (ambos incluidos). Con más
 * reels que días, algunos días llevan dos. Orden ascendente.
 */
export function reelDaysForWeek(quota: number, weekStart: string, today: string): string[] {
  if (quota <= 0) return [];
  const offset = Math.min(
    REEL_PLANNER_HORIZON_DAYS - 1,
    Math.max(0, reelDaysBetween(weekStart, today)),
  );
  const days = REEL_PLANNER_HORIZON_DAYS - offset;
  const out: string[] = [];
  for (let k = 0; k < quota; k += 1) {
    // Centro de cada tramo: 1 reel en 7 días cae el día 3, 2 caen el 1 y el 5.
    const i = Math.min(days - 1, Math.floor(((k + 0.5) * days) / quota));
    out.push(reelAddDays(weekStart, offset + i));
  }
  return out;
}
