/**
 * El handler de `snapshot-purge` — PRD §9.5 #20, §9.14 «Retención y borrado»,
 * `DATA-032`, `P1-BRAND-021`.
 *
 * `DATA-032` promete que `rawRetentionExpiresAt` «fuerza la purga del material
 * crudo». Hasta acá la fecha se guardaba y nadie la aplicaba: sin handler,
 * `main.ts` ni siquiera programaba el cron. Es una obligación de retención —el
 * catálogo le da 5 intentos por eso—, así que no tenerla es incumplir algo que
 * el documento dice que se cumple.
 *
 * Qué columnas se vacían y cuáles sobreviven (`derivedFields`, `conflicts`)
 * está decidido y justificado en la migración `0010`; este archivo no lo
 * repite para que no haya dos versiones que se desincronicen.
 *
 * ## Corre sin tenant, y por eso no usa `withCompany`
 *
 * Un barrido no es de nadie. `purgeExpiredSnapshotRaw` llama a una función
 * `SECURITY DEFINER` porque `brand_source_snapshots` tiene `FORCE ROW LEVEL
 * SECURITY`: sin eso, con `fastgram_app` el `UPDATE` afectaría **cero filas y
 * sin error** — y un barrido de retención que no purga nada se ve igual que
 * uno que no encontró nada vencido.
 */
import { snapshotPurgeStore, withoutCompany, type Database } from "@fastgram/db";
import type { Clock, JobContext, JobHandler } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

export interface SnapshotPurgeDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
}

export function createSnapshotPurgeHandler(deps: SnapshotPurgeDeps): JobHandler<unknown> {
  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    // El payload se ignora a propósito: un barrido que aceptara un `companyId`
    // dejaría de ser global, y la función SQL tampoco lo acepta.
    const ahora = new Date(deps.clock.nowMs());

    const purgados = await withoutCompany(
      deps.db,
      (tx) => snapshotPurgeStore.purgeExpiredSnapshotRaw(tx, ahora),
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

    deps.logger.info(
      { jobId: ctx.jobId, purgados, ahora: ahora.toISOString() },
      "purga de material crudo de brand source snapshots",
    );
  };
}
