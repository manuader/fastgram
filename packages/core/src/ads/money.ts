/**
 * Plata de anuncios — sprint 9 (R), `D-21`.
 *
 * Todo el dominio trabaja en **unidades mínimas** enteras de la moneda de la
 * cuenta publicitaria. La Marketing API pide los presupuestos así y lo llama
 * "offset": 100 para la mayoría (centavos) y 1 para las monedas sin decimales.
 * La lista de offset 1 es literal de
 * https://developers.facebook.com/docs/marketing-api/currencies (2026-09-28):
 * "Chilean Peso, Colombian Peso, Costa Rican Colón, Hungarian Forint, Iceland
 * Krona, Indonesian Rupiah, Japanese Yen, Korean Won, Paraguayan Guarani,
 * Taiwan Dollar, Vietnamese Dong".
 */

export const OFFSET_ONE_AD_CURRENCIES = [
  "CLP",
  "COP",
  "CRC",
  "HUF",
  "ISK",
  "IDR",
  "JPY",
  "KRW",
  "PYG",
  "TWD",
  "VND",
] as const;

/** `1` o `100`: cuántas unidades mínimas tiene una unidad de la moneda. */
export function currencyOffset(currency: string): 1 | 100 {
  return (OFFSET_ONE_AD_CURRENCIES as readonly string[]).includes(currency.toUpperCase())
    ? 1
    : 100;
}

const DECIMAL = /^-?\d+(\.\d+)?$/u;

/**
 * `"1500.50"` (unidades mayores, como vienen `spend` y `action_values` en los
 * insights) → `150050`. `null` si no es un número decimal.
 */
export function majorToMinor(value: string | number, currency: string): number | null {
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!DECIMAL.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * currencyOffset(currency));
}

/** Para mostrar: `150050` → `1500.5` (el formateo con símbolo es de la web). */
export function minorToMajor(minor: number, currency: string): number {
  return minor / currencyOffset(currency);
}
