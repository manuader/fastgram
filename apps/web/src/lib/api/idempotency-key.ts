/**
 * `Idempotency-Key` para las escrituras con coste (PRD:2288, §9.3).
 *
 * `crypto.randomUUID` sólo existe en **contexto seguro** (https o localhost);
 * en un http plano es `undefined`. El contrato no exige formato, sólo que no
 * esté vacía (`idempotency.ts` de la API), así que el respaldo vale: lo que
 * importa es que **el mismo intento** reintente con la misma cadena, no que sea
 * un uuid.
 *
 * Vivía dentro de `lib/studio/custom-video.ts`; salió de ahí cuando el alta de
 * una Brand Source (`POST /brand/sources`) necesitó la misma función.
 */
export function newIdempotencyKey(): string {
  const maybe: unknown = globalThis.crypto;
  if (
    typeof maybe === "object" &&
    maybe !== null &&
    "randomUUID" in maybe &&
    typeof (maybe as Crypto).randomUUID === "function"
  ) {
    return (maybe as Crypto).randomUUID();
  }
  return `fgw-${String(Date.now())}-${Math.random().toString(36).slice(2, 12)}`;
}
