/**
 * Puerto Clock — IMPL §2.2.
 *
 * Es un puerto a propósito, no `Date.now()` suelto. El PRD tiene reglas con
 * fecha por todos lados: resets de cuota a 00:00 UTC, ventanas de rate limit,
 * lead times de scheduling, el `stale` a los 90 días de una fuente de marca.
 * Sin poder fijar el reloj, ninguna de esas reglas se puede testear sin
 * esperar, y un test que espera termina siendo un test que se borra.
 */
export interface Clock {
  /** Instante actual. */
  now(): Date;
  /** Milisegundos desde epoch. Atajo para aritmética. */
  nowMs(): number;
}
