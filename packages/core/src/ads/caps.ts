/**
 * Topes de gasto — sprint 9 (R), `D-21`: *"cada campaña tiene tope diario y
 * total"*.
 *
 * ## Qué hace Meta y qué hacemos nosotros
 *
 * - El **tope diario** se manda como `daily_budget` de los conjuntos (repartido
 *   entre las variantes de un A/B). Es un presupuesto, no un límite duro: la
 *   doc no nos dio, en las lecturas del 2026-09-28, cuánto puede pasarse Meta
 *   en un día. Por eso además lo vigila nuestra guardia (`guard.ts`).
 * - El **tope total** es sólo nuestro. El `spend_cap` de campaña de Meta tiene
 *   un mínimo (resumen de la referencia de Campaign: ~US$100, error 2446307
 *   *"spend cap below minimum"*) que mata el caso de uso principal —un reel de
 *   prueba de US$10—, así que no se manda. Lo corta la guardia.
 *
 * ## Mínimos de Meta
 *
 * La doc de Ad Set publica mínimos **en USD** según el evento de cobro
 * (US$0,50 impresiones, US$2,50 clics) y dice que el resto de las monedas se
 * convierte al crear. Sin tabla por moneda no se inventa una: acá se valida
 * `> 0` y el rechazo de Meta vuelve como `budget_too_low` (1885272).
 */

export interface SpendCaps {
  readonly dailyCapMinor: number;
  readonly totalCapMinor: number;
}

/** Cordura, no regla de Meta: 10^10 unidades mínimas (US$100 M). */
export const MAX_CAP_MINOR = 10_000_000_000;

export type CapsProblem =
  | "not_integer"
  | "daily_not_positive"
  | "total_not_positive"
  | "daily_exceeds_total"
  | "too_large";

export function validateCaps(
  caps: SpendCaps,
): { readonly ok: true } | { readonly ok: false; readonly problem: CapsProblem } {
  const { dailyCapMinor: d, totalCapMinor: t } = caps;
  if (!Number.isSafeInteger(d) || !Number.isSafeInteger(t))
    return { ok: false, problem: "not_integer" };
  if (d <= 0) return { ok: false, problem: "daily_not_positive" };
  if (t <= 0) return { ok: false, problem: "total_not_positive" };
  if (d > t) return { ok: false, problem: "daily_exceeds_total" };
  if (t > MAX_CAP_MINOR) return { ok: false, problem: "too_large" };
  return { ok: true };
}

/**
 * El diario repartido entre `n` conjuntos (las variantes de un A/B). Parte
 * entera; el resto va al primero, así la suma es exactamente el tope.
 * `null` si alguno quedaría en 0.
 */
export function splitDailyBudget(
  dailyCapMinor: number,
  adSetCount: number,
): number[] | null {
  if (!Number.isSafeInteger(adSetCount) || adSetCount < 1) return null;
  const base = Math.floor(dailyCapMinor / adSetCount);
  if (base <= 0) return null;
  const out = Array.from({ length: adSetCount }, () => base);
  out[0] = base + (dailyCapMinor - base * adSetCount);
  return out;
}

const DAY_MS = 86_400_000;

export interface MaxSpendInput {
  readonly caps: SpendCaps;
  /** Lo gastado en toda la campaña (último sync). */
  readonly spentTotalMinor: number;
  /** Lo gastado hoy en la zona de la cuenta (último sync). */
  readonly spentTodayMinor: number;
  readonly now: Date;
  /** Fin programado; sin fin, el techo es el total. */
  readonly endTime: Date | null;
}

export interface MaxSpend {
  /** Lo máximo que la campaña puede gastar desde ahora si se prende. */
  readonly maxMinor: number;
  readonly remainingTotalMinor: number;
  /** Días calendario que quedan (hoy incluido), si hay fin. */
  readonly daysLeft: number | null;
  /** Qué tope manda. */
  readonly bindingCap: "total" | "daily_until_end";
}

/**
 * Lo que muestra el diálogo de confirmación (`D-21`): el peor caso **dentro de
 * nuestros topes**. Con fin: lo que queda de hoy más un diario por cada día que
 * falta, sin pasar el total. Sin fin: lo que queda del total.
 *
 * No incluye el desfase de la guardia (el gasto se ve con retraso y se revisa
 * cada `ADS_GUARD_INTERVAL_MINUTES`): la web lo dice en texto, no se inventa un
 * número.
 */
export function maxPossibleSpend(input: MaxSpendInput): MaxSpend {
  const { caps } = input;
  const remainingTotal = Math.max(0, caps.totalCapMinor - input.spentTotalMinor);
  if (input.endTime === null) {
    return {
      maxMinor: remainingTotal,
      remainingTotalMinor: remainingTotal,
      daysLeft: null,
      bindingCap: "total",
    };
  }
  const msLeft = input.endTime.getTime() - input.now.getTime();
  const daysLeft = msLeft <= 0 ? 0 : Math.ceil(msLeft / DAY_MS);
  const todayLeft = Math.max(0, caps.dailyCapMinor - input.spentTodayMinor);
  const byDays = daysLeft === 0 ? 0 : todayLeft + caps.dailyCapMinor * (daysLeft - 1);
  return byDays < remainingTotal
    ? {
        maxMinor: byDays,
        remainingTotalMinor: remainingTotal,
        daysLeft,
        bindingCap: "daily_until_end",
      }
    : {
        maxMinor: remainingTotal,
        remainingTotalMinor: remainingTotal,
        daysLeft,
        bindingCap: "total",
      };
}

/** `true` si algún tope sube: subir presupuesto también pide confirmación. */
export function capsIncrease(before: SpendCaps, after: SpendCaps): boolean {
  return (
    after.dailyCapMinor > before.dailyCapMinor ||
    after.totalCapMinor > before.totalCapMinor
  );
}

/**
 * Meta: *"For each ad set, the budget is only allowed to change 4 times per
 * hour"* (https://developers.facebook.com/docs/marketing-api/overview/rate-limiting).
 * Se chequea antes de llamar, para no gastar la llamada en un rechazo seguro.
 */
export const AD_SET_BUDGET_CHANGES_PER_HOUR = 4;

export function budgetChangeAllowed(recentChanges: readonly Date[], now: Date): boolean {
  const since = now.getTime() - 3_600_000;
  return (
    recentChanges.filter((d) => d.getTime() > since).length <
    AD_SET_BUDGET_CHANGES_PER_HOUR
  );
}
