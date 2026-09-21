/**
 * Cálculo de resets de cuota — PRD §16.2.
 *
 * Tres relojes distintos, y confundirlos es un bug de facturación:
 *
 * | Cuota                   | Reset                                  |
 * |-------------------------|----------------------------------------|
 * | Content saves           | día ancla de facturación, 00:00 UTC    |
 * | Daily Blitz swipes      | diario 00:00 UTC                       |
 * | Trial content allowance | **nunca** — de por vida, por cuenta    |
 *
 * El trial es el que más se equivoca: es tentador tratarlo como una cuota
 * mensual con un número chico. No lo es. El PRD dice que su error va **sin
 * `resetAt`**, porque no hay ninguno que informar, y que se comparte entre los
 * workspaces personales de la misma cuenta.
 */

const DAY_MS = 86_400_000;

/** Siguiente 00:00 UTC estrictamente posterior a `now`. */
export function nextDailyResetUtc(now: Date): Date {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  next.setTime(next.getTime() + DAY_MS);
  return next;
}

/**
 * Siguiente reset del período de facturación: el `anchorDay` del mes, a las
 * 00:00 UTC, estrictamente posterior a `now`.
 *
 * El caso que rompe una implementación ingenua es el día 31. Un ancla en 31
 * tiene que caer en el 28 de febrero (o el 29 en bisiesto), no desbordar al 3
 * de marzo — que es lo que hace `new Date(año, mes, 31)` cuando el mes no
 * tiene 31 días. Un desborde así le regala al cliente un período más corto un
 * mes y más largo al siguiente, y el error se descubre en la factura.
 */
export function nextBillingResetUtc(now: Date, anchorDay: number): Date {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new Error(`anchorDay fuera de rango: ${anchorDay}`);
  }

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const thisMonth = clampToMonth(year, month, anchorDay);
  if (thisMonth.getTime() > now.getTime()) return thisMonth;

  return clampToMonth(year, month + 1, anchorDay);
}

/** El ancla del mes, recortada al último día si el mes es más corto. */
function clampToMonth(year: number, month: number, anchorDay: number): Date {
  // Día 0 del mes siguiente = último día de este mes.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay)));
}

/**
 * ¿Hay que reiniciar el contador antes de evaluar esta petición?
 *
 * Se calcula en lectura en vez de con un job que recorra todas las cuentas a
 * medianoche. Con un job, la cuota de un cliente depende de que ese job haya
 * corrido; acá depende del reloj, que es lo que el usuario ve.
 */
export function isExpired(lastResetAt: Date, nextResetAt: Date, now: Date): boolean {
  if (nextResetAt.getTime() <= lastResetAt.getTime()) {
    throw new Error("nextResetAt tiene que ser posterior a lastResetAt");
  }
  return now.getTime() >= nextResetAt.getTime();
}
