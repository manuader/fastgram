/** `searchParams` de una página del App Router (Next 15: llega como `Promise`). */
export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** `?a=1&a=2` llega como array: vale el primero, como en `URLSearchParams.get`. */
export function firstParam(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}
