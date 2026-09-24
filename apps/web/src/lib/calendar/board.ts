/**
 * La aritmética del tablero del calendario — `PU-CAL-002`: vistas semana y
 * mes, el rango que se le pide a `GET /calendar`, y a qué hora cae un ítem
 * soltado en otro día.
 *
 * Puro, como `calendar.ts`: sin React, sin red, sin `Date.now()`. Toda función
 * que depende de la zona la **recibe**.
 *
 * ## Hora local → instante, con horario de verano
 *
 * `wallTimeToUtc` es la misma regla que `zonedWallTimeToUtc` de `packages/core`
 * (que decide los horarios del auto-slot), copiada porque `apps/web` no depende
 * de `core`. Si divergen, lo que el calendario dibuja a las 09:00 no es lo que
 * el auto-slot programó a las 09:00; `board.test.ts` fija los mismos casos de
 * DST que el test de `core`.
 */
import type { CalendarItem, CalendarNetwork } from "@fastgram/contracts";
import { dayKey, dayKeyOf, daysInMonth, type YearMonth } from "./calendar";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type CalendarViewMode = "week" | "month";
export type BrandScope = "current" | "all";

// ---------------------------------------------------------------------------
// Zona horaria
// ---------------------------------------------------------------------------

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    wallFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function offsetMs(msEpoch: number, timeZone: string): number {
  const parts = wallFormatter(timeZone).formatToParts(new Date(msEpoch));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const hour = get("hour");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour === 24 ? 0 : hour,
    get("minute"),
    get("second"),
  );
  return asUtc - (msEpoch - (((msEpoch % 1000) + 1000) % 1000));
}

function parseKey(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split("-").map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

/**
 * El instante de una hora de pared en un día (`YYYY-MM-DD`) y una zona. La
 * hora que no existe (adelanto) se corre hacia adelante; la que existe dos
 * veces (atraso) es la primera. Ver la cabecera.
 */
export function wallTimeToUtc(
  key: string,
  minutesOfDay: number,
  timeZone: string,
): number {
  const { year, month, day } = parseKey(key);
  const wall = Date.UTC(year, month - 1, day) + minutesOfDay * MINUTE_MS;
  const before = offsetMs(wall - DAY_MS, timeZone);
  const valid = [before, offsetMs(wall, timeZone), offsetMs(wall + DAY_MS, timeZone)]
    .map((offset) => wall - offset)
    .filter((candidate) => candidate + offsetMs(candidate, timeZone) === wall);
  if (valid.length > 0) return Math.min(...valid);
  return wall - before;
}

/** Minutos desde la medianoche local de un instante. */
export function minutesOfDayOf(msEpoch: number, timeZone: string): number {
  const parts = wallFormatter(timeZone).formatToParts(new Date(msEpoch));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const hour = get("hour");
  return (hour === 24 ? 0 : hour) * 60 + get("minute");
}

/**
 * Soltar un ítem en otro día **conserva su hora local**: arrastrar el post de
 * las 09:07 del martes al jueves lo deja a las 09:07 del jueves. El jitter que
 * puso el auto-slot sobrevive, y la hora sigue siendo una de las ventanas.
 */
export function movedInstant(
  itemAt: number,
  targetDay: string,
  timeZone: string,
): number {
  return wallTimeToUtc(targetDay, minutesOfDayOf(itemAt, timeZone), timeZone);
}

// ---------------------------------------------------------------------------
// Días
// ---------------------------------------------------------------------------

export function shiftDay(key: string, days: number): string {
  const { year, month, day } = parseKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return dayKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** El domingo de la semana de ese día (la grilla empieza en domingo, PRD:1657). */
export function weekStartOf(key: string): string {
  const { year, month, day } = parseKey(key);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return shiftDay(key, -weekday);
}

export function weekDays(start: string): readonly string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDay(start, i));
}

export interface DayRange {
  /** Primer día, inclusivo. */
  readonly first: string;
  /** Último día, inclusivo. */
  readonly last: string;
}

export function monthRange(ym: YearMonth): DayRange {
  return {
    first: dayKey(ym.year, ym.month, 1),
    last: dayKey(ym.year, ym.month, daysInMonth(ym)),
  };
}

export function weekRange(start: string): DayRange {
  return { first: start, last: shiftDay(start, 6) };
}

/**
 * El `[from, to)` que se le pide a la API: los días visibles **más un día de
 * cada lado**. El margen no es decorativo: la vista "todas las marcas" dibuja
 * en la zona del navegador y cada marca tiene la suya, así que un post del
 * borde puede caer en un día visible aunque en UTC sea del día de al lado.
 */
export function queryRange(
  range: DayRange,
  timeZone: string,
): { from: number; to: number } {
  return {
    from: wallTimeToUtc(shiftDay(range.first, -1), 0, timeZone),
    to: wallTimeToUtc(shiftDay(range.last, 2), 0, timeZone),
  };
}

/** Los ítems repartidos por día local y ordenados por hora (FR-110, criterio 2). */
export function itemsByDay(
  items: readonly CalendarItem[],
  timeZone: string,
): ReadonlyMap<string, readonly CalendarItem[]> {
  const byDay = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const key = dayKeyOf(item.at, timeZone);
    const bucket = byDay.get(key);
    if (bucket === undefined) byDay.set(key, [item]);
    else bucket.push(item);
  }
  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return byDay;
}

// ---------------------------------------------------------------------------
// Arrastre
// ---------------------------------------------------------------------------

/** El id de un chip arrastrable: `post:<uuid>` o `slot:<uuid>`. */
export function dragIdOf(item: Pick<CalendarItem, "kind" | "id">): string {
  return `${item.kind}:${item.id}`;
}

/** El id de una celda de día: `day:YYYY-MM-DD`. */
export function dropIdOf(key: string): string {
  return `day:${key}`;
}

export function dayOfDropId(id: string): string | null {
  const match = /^day:(\d{4}-\d{2}-\d{2})$/.exec(id);
  return match?.[1] ?? null;
}

export interface MoveRequest {
  readonly item: CalendarItem;
  readonly scheduledAtUtc: number;
}

/**
 * Lo que hay que pedirle a la API al soltar. `null` = no se mueve nada: soltó
 * fuera de un día, en el mismo día, sobre algo que no se mueve, o a una hora
 * que ya pasó (la API respondería 400; mejor no mandarlo).
 */
export function resolveDrop(params: {
  readonly item: CalendarItem | undefined;
  readonly overId: string | null;
  readonly timeZone: string;
  readonly now: number;
}): MoveRequest | null {
  const { item, overId, timeZone, now } = params;
  if (item === undefined || overId === null || !item.movable) return null;
  const day = dayOfDropId(overId);
  if (day === null) return null;
  if (day === dayKeyOf(item.at, timeZone)) return null;
  const scheduledAtUtc = movedInstant(item.at, day, timeZone);
  if (scheduledAtUtc <= now) return null;
  return { item, scheduledAtUtc };
}

// ---------------------------------------------------------------------------
// Redes
// ---------------------------------------------------------------------------

/**
 * Color por red. Las cinco que ya tenían tono en `@fastgram/ui` usan su token
 * (`--fg-platform-*`); X, Threads y Facebook no lo tienen todavía y van con un
 * valor propio. X y Threads son negras en su marca: se usa el color de texto
 * para que se lean en claro y en oscuro.
 */
export const NETWORK_CHIP_COLOR: Readonly<Record<CalendarNetwork, string>> = {
  instagram: "var(--fg-platform-instagram)",
  tiktok: "var(--fg-platform-tiktok)",
  youtube: "var(--fg-platform-youtube)",
  linkedin: "var(--fg-platform-linkedin)",
  reddit: "var(--fg-platform-reddit)",
  x: "var(--fg-color-text)",
  threads: "var(--fg-color-text-muted)",
  facebook: "#1877F2",
};

export const NETWORK_LABEL: Readonly<Record<CalendarNetwork, string>> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  x: "X",
  threads: "Threads",
  facebook: "Facebook",
};
