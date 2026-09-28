/**
 * Plata en la web de Ads. La API habla en **unidades mínimas** (`…Minor`) de
 * la moneda de la cuenta; acá se formatea y se parsea lo que escribe el dueño.
 * La tabla de monedas sin decimales es la misma de `core/ads/money.ts`
 * (https://developers.facebook.com/docs/marketing-api/currencies): la web no
 * importa `core`.
 */
const OFFSET_ONE = new Set([
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
]);

export function currencyOffset(currency: string): 1 | 100 {
  return OFFSET_ONE.has(currency.toUpperCase()) ? 1 : 100;
}

export function formatMinor(minor: number | null, currency: string | null): string {
  if (minor === null) return "—";
  const code = currency ?? "USD";
  const major = minor / currencyOffset(code);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(
      major,
    );
  } catch {
    return `${major.toFixed(2)} ${code}`;
  }
}

/** `"12.5"` → 1250 en USD. `null` si no es un número positivo. */
export function parseMajorToMinor(input: string, currency: string): number | null {
  const raw = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/u.test(raw)) return null;
  const minor = Math.round(Number(raw) * currencyOffset(currency));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

export function minorToMajorInput(minor: number, currency: string): string {
  const offset = currencyOffset(currency);
  return offset === 1 ? String(minor) : (minor / offset).toFixed(2);
}

export function formatPercent(ratio: number | null): string {
  return ratio === null ? "—" : `${(ratio * 100).toFixed(2)}%`;
}

export function formatCount(n: number | null): string {
  return n === null ? "—" : new Intl.NumberFormat("en-US").format(n);
}
