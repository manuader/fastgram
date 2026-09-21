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

/**
 * Comienzo del período de facturación en curso: el ancla **anterior o igual**
 * a `now`.
 *
 * Es el espejo de {@link nextBillingResetUtc} y comparte su recorte al último
 * día del mes, porque tienen que ser el mismo borde visto desde los dos lados:
 * si uno recortara y el otro no, habría instantes que no pertenecen a ningún
 * período o que pertenecen a dos.
 */
export function currentBillingPeriodStartUtc(now: Date, anchorDay: number): Date {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new Error(`anchorDay fuera de rango: ${anchorDay}`);
  }

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const thisMonth = clampToMonth(year, month, anchorDay);
  if (thisMonth.getTime() <= now.getTime()) return thisMonth;

  return clampToMonth(year, month - 1, anchorDay);
}

/**
 * La clave de `quota_ledgers.period` — `DATA-029`.
 *
 * ## Qué decide esto y con qué evidencia
 *
 * El schema dejaba el formato explícitamente pendiente: *"el PRD no fija su
 * formato … tiene que decidirlo la tarea de cuotas"*. Así que se decide acá, y
 * la decisión no es libre: §16.2 dice que los saves incluidos se reinician en
 * el **día ancla de facturación**, no el 1 de cada mes. Un período es entonces
 * el intervalo entre dos anclas, y lo que lo identifica sin ambigüedad es su
 * fecha de inicio.
 *
 * `YYYY-MM-DD` en UTC, que es el inicio del período:
 *
 *  - **`YYYY-MM` no sirve.** Con ancla el 15, el período que empieza el
 *    2026-09-15 termina el 2026-10-15 y cruza dos meses calendario. La clave
 *    tiene que decir *qué ciclo*, no *qué mes*.
 *  - **Ordena cronológicamente como texto**, así que el índice
 *    `(companyId, period)` sirve para "el período anterior" sin parsear.
 *  - **Se lee en un ticket de soporte.** Un id opaco obligaría a un join para
 *    contestar "¿de qué mes es este cargo?".
 *
 * El recorte del ancla 31 no genera colisiones: enero da `2026-01-31`, febrero
 * `2026-02-28` y marzo `2026-03-31`. Son meses distintos, así que las claves
 * son distintas aunque el día varíe.
 */
export function billingPeriodKey(now: Date, anchorDay: number): string {
  return currentBillingPeriodStartUtc(now, anchorDay).toISOString().slice(0, 10);
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
