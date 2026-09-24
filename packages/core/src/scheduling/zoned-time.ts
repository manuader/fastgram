/**
 * Hora civil ↔ instante UTC en una zona IANA, sin librerías.
 *
 * Existe porque la estrategia de una marca habla en **horas locales** ("a las
 * 09:00 de Buenos Aires") y la tabla `posts` guarda instantes UTC. La
 * conversión ingenua —restar el offset de "ahora"— se equivoca dos veces por
 * año en toda zona con horario de verano: el día del cambio, la mitad de las
 * ventanas cae una hora corrida.
 *
 * ## Las dos horas raras del año
 *
 * - **La que no existe** (adelanto: en Nueva York el 8-mar-2026 el reloj salta
 *   de 01:59 a 03:00). Una ventana de las 02:30 se corre **hacia adelante**
 *   lo que dura el salto: 03:30. Es lo que hace un reloj de pared, y la
 *   alternativa —descartar la ventana— haría que ese día tenga un cupo menos
 *   sin que nadie lo haya pedido.
 * - **La que existe dos veces** (atraso: el 1-nov-2026 las 01:30 pasan dos
 *   veces). Se elige **la primera**. Cualquiera de las dos sería defendible;
 *   la primera es la que no deja un hueco de una hora entre la ventana
 *   anterior y ésta.
 *
 * El truco para no depender de dónde cae la transición: se prueban los
 * offsets de la zona **un día antes, en el momento y un día después**, y se
 * queda con los candidatos que vuelven a dar la misma hora de pared. Supone a
 * lo sumo una transición por día, que es cierto para toda zona IANA vigente.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Un día civil. `month` va de 1 a 12, como se escribe. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
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
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface WallParts extends CivilDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallPartsOf(msEpoch: number, timeZone: string): WallParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(msEpoch));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // Algunos ICU viejos escriben la medianoche como "24" aun con `h23`.
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** ¿La zona existe para este runtime? */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset de la zona en ese instante, en ms (UTC−3 → −10 800 000). */
export function timeZoneOffsetMs(msEpoch: number, timeZone: string): number {
  const p = wallPartsOf(msEpoch, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Se compara contra el instante truncado al segundo: el formateador no da ms.
  return asUtc - (msEpoch - (((msEpoch % 1000) + 1000) % 1000));
}

/** El día civil de un instante en esa zona. */
export function civilDateOf(msEpoch: number, timeZone: string): CivilDate {
  const p = wallPartsOf(msEpoch, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/** `YYYY-MM-DD`. */
export function civilKey(date: CivilDate): string {
  const pad = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));
  return `${String(date.year)}-${pad(date.month)}-${pad(date.day)}`;
}

/** Suma días civiles (sin zona: es aritmética de calendario). */
export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = domingo … 6 = sábado. */
export function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * El instante UTC de una hora de pared (`minutesOfDay` desde la medianoche
 * local) en ese día civil y esa zona. Ver la cabecera para las dos horas raras.
 */
export function zonedWallTimeToUtc(
  date: CivilDate,
  minutesOfDay: number,
  timeZone: string,
): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day) + minutesOfDay * MINUTE_MS;
  const offsetBefore = timeZoneOffsetMs(wall - DAY_MS, timeZone);
  const offsets = [
    offsetBefore,
    timeZoneOffsetMs(wall, timeZone),
    timeZoneOffsetMs(wall + DAY_MS, timeZone),
  ];

  const valid = offsets
    .map((offset) => wall - offset)
    .filter((candidate) => candidate + timeZoneOffsetMs(candidate, timeZone) === wall);

  if (valid.length > 0) return Math.min(...valid);
  // La hora no existe: se corre hacia adelante con el offset de antes del salto.
  return wall - offsetBefore;
}

/** `"09:30"` → 570. `null` si no es una hora `HH:MM` de 00:00 a 23:59. */
export function parseTimeOfDay(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
