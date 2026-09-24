/**
 * Cuándo sale cada slot y de qué tipo es — `F-211`, `F-213`, `AI-012`.
 *
 * Puro: ni base ni reloj. Quien llama pasa la configuración, las ventanas de
 * la estrategia de la marca y "ahora".
 *
 * ## Los horarios
 *
 * Por defecto los de la estrategia de la marca (`brand_strategies.windows`):
 * cada día toma las primeras `perAccountPerDay` ventanas de ese día de la
 * semana. Si la marca tiene menos ventanas que las que pide la campaña, se
 * completan con {@link DEFAULT_POSTING_TIMES}. Si el wizard fijó horarios
 * (`postingTimes`), valen para todos los días.
 *
 * A cada hora se le suma el **jitter determinista** de la estrategia
 * (`jitterOffsetMs`, §5.3): mismo slot, mismo corrimiento, así que regenerar
 * no mueve la grilla y el test la puede fijar.
 *
 * Los horarios que ya pasaron (o están a menos de {@link SCHEDULE_MIN_LEAD_MS})
 * no se generan: una campaña que arranca hoy a la tarde no nace con slots
 * vencidos que habría que borrar a mano.
 *
 * ## Los tipos: reparto exacto, no una tirada por slot
 *
 * `FR-055` pide para el mix *"muestreo ponderado determinístico que el usuario
 * controla con sliders y espera exacto"*. En Blitz eso es una tirada por
 * sugerencia; en una campaña de 14 slots con 50/50 una tirada por slot puede
 * dar 10/4, y el usuario ve una campaña que no es la que configuró. Así que el
 * reparto es por **mayor resto** (14 × 50 % = 7 y 7) y después se intercalan
 * para que no salgan todos los de un tipo juntos. Un tipo con peso 0 recibe 0
 * slots: nunca es fallback (`AI-012`).
 */
import type { BlitzContentType } from "../content/content.js";
import { BLITZ_CONTENT_TYPES } from "../content/content.js";
import {
  JITTER_MINUTES_DEFAULT,
  WEEKDAY_KEYS,
  jitterOffsetMs,
  type WeekdayKey,
} from "../scheduling/auto-slot.js";
import {
  addCivilDays,
  civilKey,
  parseTimeOfDay,
  weekdayOf,
  zonedWallTimeToUtc,
  type CivilDate,
} from "../scheduling/zoned-time.js";

const MINUTE_MS = 60_000;

/** Horarios de relleno cuando la estrategia no alcanza. Nuestros, no del PRD. */
export const DEFAULT_POSTING_TIMES = ["09:00", "13:00", "18:00"] as const;

/** Un slot a menos de esto de "ahora" no se genera. */
export const SCHEDULE_MIN_LEAD_MS = 60 * MINUTE_MS;

export interface CampaignScheduleInput {
  /** Semilla del jitter: el id de la campaña. */
  readonly seed: string;
  /** Primer día de la campaña, en la zona de la campaña. */
  readonly startDate: CivilDate;
  readonly timezone: string;
  readonly durationWeeks: number;
  readonly perAccountPerDay: number;
  /** `null` = las ventanas de la estrategia. */
  readonly postingTimes: readonly string[] | null;
  /** `brand_strategies.windows`; vacío = sin estrategia. */
  readonly strategyWindows: Readonly<Partial<Record<WeekdayKey, readonly string[]>>>;
  readonly jitterMinutes?: number;
  readonly nowMs: number;
}

export interface PlannedCampaignSlot {
  /** Posición en la grilla completa (día × turno), estable aunque se salteen. */
  readonly index: number;
  readonly atMs: number;
  /** `YYYY-MM-DD` local de la campaña. */
  readonly localDay: string;
}

function minutesList(times: readonly string[]): number[] {
  const out = new Set<number>();
  for (const t of times) {
    const m = parseTimeOfDay(t);
    if (m !== null) out.add(m);
  }
  return [...out].sort((a, b) => a - b);
}

/** Los `perDay` horarios (en minutos locales) de un día. */
export function timesForDay(
  date: CivilDate,
  perDay: number,
  postingTimes: readonly string[] | null,
  strategyWindows: Readonly<Partial<Record<WeekdayKey, readonly string[]>>>,
): number[] {
  const base =
    postingTimes !== null && postingTimes.length > 0
      ? minutesList(postingTimes)
      : minutesList(strategyWindows[WEEKDAY_KEYS[weekdayOf(date)] ?? "sun"] ?? []);
  const chosen = base.slice(0, perDay);
  for (const fallback of minutesList(DEFAULT_POSTING_TIMES)) {
    if (chosen.length >= perDay) break;
    if (!chosen.includes(fallback)) chosen.push(fallback);
  }
  return chosen.sort((a, b) => a - b);
}

/** La grilla de la campaña, sin los horarios vencidos. Orden cronológico. */
export function planCampaignSchedule(
  input: CampaignScheduleInput,
): PlannedCampaignSlot[] {
  const jitter = Math.max(0, input.jitterMinutes ?? JITTER_MINUTES_DEFAULT);
  const earliest = input.nowMs + SCHEDULE_MIN_LEAD_MS;
  const out: PlannedCampaignSlot[] = [];
  const days = input.durationWeeks * 7;
  for (let d = 0; d < days; d += 1) {
    const date = addCivilDays(input.startDate, d);
    const times = timesForDay(
      date,
      input.perAccountPerDay,
      input.postingTimes,
      input.strategyWindows,
    );
    times.forEach((minutes, turn) => {
      const index = d * input.perAccountPerDay + turn;
      const atMs =
        zonedWallTimeToUtc(date, minutes, input.timezone) +
        jitterOffsetMs(`${input.seed}:${String(index)}`, jitter);
      if (atMs < earliest) return;
      out.push({ index, atMs, localDay: civilKey(date) });
    });
  }
  return out.sort((a, b) => a.atMs - b.atMs || a.index - b.index);
}

/**
 * Cuántos slots de cada tipo: mayor resto sobre los pesos > 0. Empates del
 * resto se resuelven por el orden canónico de los tipos, así que es
 * determinista. Suma exactamente `n`. Tipos con peso 0 → 0.
 */
export function apportionContentTypes(
  n: number,
  mix: Readonly<Record<BlitzContentType, number>>,
): Readonly<Record<BlitzContentType, number>> {
  const out: Record<BlitzContentType, number> = {
    slideshow: 0,
    "wall-of-text": 0,
    "green-screen": 0,
    "video-hook": 0,
  };
  const types = BLITZ_CONTENT_TYPES.filter((t) => mix[t] > 0);
  const total = types.reduce((sum, t) => sum + mix[t], 0);
  if (n <= 0 || total <= 0) return out;
  const remainders: { type: BlitzContentType; rest: number }[] = [];
  let assigned = 0;
  for (const t of types) {
    const exact = (n * mix[t]) / total;
    const whole = Math.floor(exact);
    out[t] = whole;
    assigned += whole;
    remainders.push({ type: t, rest: exact - whole });
  }
  remainders.sort(
    (a, b) =>
      b.rest - a.rest ||
      BLITZ_CONTENT_TYPES.indexOf(a.type) - BLITZ_CONTENT_TYPES.indexOf(b.type),
  );
  for (let i = 0; assigned < n; i += 1, assigned += 1) {
    const pick = remainders[i % remainders.length];
    if (pick === undefined) break;
    out[pick.type] += 1;
  }
  return out;
}

/**
 * El tipo de cada uno de `n` slots, intercalados: cada tipo ocupa posiciones
 * ideales `(k + ½)·n/c` y se ordena por ahí. Con 50/50 queda A B A B…
 */
export function assignContentTypes(
  n: number,
  mix: Readonly<Record<BlitzContentType, number>>,
): BlitzContentType[] {
  const counts = apportionContentTypes(n, mix);
  const placed: { type: BlitzContentType; at: number; order: number }[] = [];
  for (const t of BLITZ_CONTENT_TYPES) {
    const c = counts[t];
    for (let k = 0; k < c; k += 1) {
      placed.push({
        type: t,
        at: ((k + 0.5) * n) / c,
        order: BLITZ_CONTENT_TYPES.indexOf(t),
      });
    }
  }
  placed.sort((a, b) => a.at - b.at || a.order - b.order);
  return placed.map((p) => p.type);
}

/** `YYYY-MM-DD` → fecha civil. `null` si no es un día real. */
export function parseCivilDate(value: string): CivilDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (m === null) return null;
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    probe.getUTCFullYear() !== date.year ||
    probe.getUTCMonth() !== date.month - 1 ||
    probe.getUTCDate() !== date.day
  )
    return null;
  return date;
}
