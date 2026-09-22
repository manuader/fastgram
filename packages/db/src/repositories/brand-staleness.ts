/**
 * El lado de la base del barrido de staleness — PRD §9.5 #19, `F-026`.
 *
 * Es una envoltura fina sobre `app.sweep_stale_brand_sources`, la función
 * `SECURITY DEFINER` de la migración `0009`. El porqué de la función está allá;
 * acá sólo lo que hace falta para llamarla bien.
 */
import { sql } from "drizzle-orm";

import type { Executor } from "../client.js";

/**
 * Marca `stale` las fuentes analizadas hace más de `staleAfterDays`.
 *
 * Devuelve cuántas filas cambiaron. **No recibe `companyId` y no puede
 * recibirlo**: es un barrido global y ésa es exactamente la excepción al
 * aislamiento que la función documenta y acota.
 *
 * `staleAfterDays` lo pasa el llamador porque el número vive en
 * `packages/core` (`STALE_AFTER_DAYS`) y lo fija un test. Escribirlo también en
 * SQL serían dos fuentes de verdad, y la de SQL no la mira `pnpm consistency`.
 */
export async function sweepStaleBrandSources(
  exec: Executor,
  now: Date,
  staleAfterDays: number,
): Promise<number> {
  if (!Number.isInteger(staleAfterDays) || staleAfterDays <= 0) {
    throw new Error(
      `staleAfterDays tiene que ser un entero positivo, y llegó ${String(staleAfterDays)}`,
    );
  }
  // El instante viaja como **texto ISO** y no como `Date`: es la trampa 18.
  // `drizzle()` le cambia los serializadores al cliente postgres.js, así que un
  // `Date` como parámetro de un `sql` crudo llega al protocolo sin serializar y
  // el driver muere en el bind, no en la lógica. El `::timestamptz` castea del
  // lado del servidor.
  const filas = await exec.execute<{ barridas: number }>(
    sql`select app.sweep_stale_brand_sources(
          ${now.toISOString()}::timestamptz,
          ${staleAfterDays}::int
        )::int as barridas`,
  );
  const fila = filas[0];
  if (fila === undefined) {
    // Una función escalar siempre devuelve una fila. Si no está, alguien cambió
    // la firma en SQL y no este archivo.
    throw new Error("app.sweep_stale_brand_sources no devolvió ninguna fila");
  }
  return fila.barridas;
}

export const brandStalenessStore = { sweepStaleBrandSources };
