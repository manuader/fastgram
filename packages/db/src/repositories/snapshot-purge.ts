/**
 * El lado de la base de la purga de snapshots — PRD §9.5 #20, §9.14,
 * `DATA-032`.
 *
 * Envoltura fina sobre `app.purge_expired_snapshot_raw`, la función
 * `SECURITY DEFINER` de la migración `0010`. Qué columnas cuentan como
 * «material crudo», por qué `conflicts` sobrevive y por qué hace falta
 * `SECURITY DEFINER` está allá; acá sólo lo que hace falta para llamarla bien.
 */
import { sql } from "drizzle-orm";

import type { Executor } from "../client.js";

/**
 * Vacía `profileSignals` y `contentItems` de todo snapshot cuyo
 * `rawRetentionExpiresAt` sea `<= now`, y pone esa fecha en `NULL` para que la
 * próxima pasada no lo vuelva a ver. `derivedFields` y `conflicts` no se tocan.
 *
 * Devuelve cuántos snapshots purgó. **No recibe `companyId`**: es un barrido
 * global, y ésa es la excepción al aislamiento que la función documenta.
 */
export async function purgeExpiredSnapshotRaw(
  exec: Executor,
  now: Date,
): Promise<number> {
  if (Number.isNaN(now.getTime())) {
    // `toISOString()` tiraría un `RangeError` genérico; mejor decir qué pasó.
    throw new Error("purgeExpiredSnapshotRaw recibió una fecha inválida");
  }
  // Texto ISO + `::timestamptz` y no un `Date`: trampa 18. `drizzle()` le
  // cambia los serializadores al cliente, y un `Date` en un `sql` crudo muere
  // en el bind.
  const filas = await exec.execute<{ purgadas: number }>(
    sql`select app.purge_expired_snapshot_raw(${now.toISOString()}::timestamptz)::int as purgadas`,
  );
  const fila = filas[0];
  if (fila === undefined) {
    throw new Error("app.purge_expired_snapshot_raw no devolvió ninguna fila");
  }
  return fila.purgadas;
}

export const snapshotPurgeStore = { purgeExpiredSnapshotRaw };
