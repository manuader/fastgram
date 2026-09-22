/**
 * El handler de `brand-source-staleness-sweep` — PRD §9.5 #19, `F-026`,
 * `P1-BRAND-021`, `P1-BRANDPG-006`.
 *
 * `FR-026` dice que una fuente analizada hace 90 días pasa a `stale` y se le
 * ofrece al usuario refrescarla. El dominio sabía decidirlo desde hace tandas
 * —`isStale` y `markStaleIfNeeded`, con test de borde «89 no, 90 sí»— y **nadie
 * lo aplicaba**: sin handler, `apps/worker/src/main.ts` ni siquiera programaba
 * el cron, así que ninguna fuente envejecía nunca.
 *
 * ## Por qué no usa `markStaleIfNeeded`
 *
 * Porque esa función decide sobre **una** fuente ya cargada en memoria, y este
 * barrido es global: traer todas las fuentes de todos los workspaces para
 * decidir una por una sería leer la tabla entera cada madrugada para escribir
 * unas pocas filas. La condición viaja al `WHERE`.
 *
 * El costo de esa decisión hay que decirlo: **la regla de staleness queda
 * escrita dos veces**, en TypeScript y en SQL. Se mitiga de dos formas — el
 * umbral (`STALE_AFTER_DAYS`) es **uno solo** y viaja como parámetro desde
 * `core`, y el test de integración del barrido comprueba el mismo borde que el
 * test del dominio («89 no, 90 sí»). Si alguien cambia un `<=` por un `<`, hay
 * un rojo que lo dice.
 *
 * ## Corre sin tenant, y por eso no usa `withCompany`
 *
 * Un barrido no es de nadie. `sweepStaleBrandSources` llama a una función
 * `SECURITY DEFINER` (migración `0009`) porque `brand_sources` tiene
 * `FORCE ROW LEVEL SECURITY`: sin eso, con `fastgram_app` el `UPDATE` afectaría
 * **cero filas y sin error**. Medido sacándole el `SECURITY DEFINER`:
 * `expected 0 to be greater than or equal to 1`.
 */
import { STALE_AFTER_DAYS } from "@fastgram/core";
import { brandStalenessStore, withoutCompany, type Database } from "@fastgram/db";
import type { Clock, JobContext, JobHandler } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

export interface BrandStalenessDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
}

export function createBrandStalenessHandler(
  deps: BrandStalenessDeps,
): JobHandler<unknown> {
  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    // **El payload se ignora a propósito, y no es descuido.** Un barrido que
    // aceptara un `companyId` dejaría de ser global: quien pudiera encolar
    // elegiría a quién le envejecen las fuentes. La función SQL tampoco lo
    // acepta, así que las dos capas dicen lo mismo.
    const desde = deps.clock.nowMs();

    const barridas = await withoutCompany(
      deps.db,
      (tx) =>
        brandStalenessStore.sweepStaleBrandSources(tx, new Date(desde), STALE_AFTER_DAYS),
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

    deps.logger.info(
      { jobId: ctx.jobId, barridas, staleAfterDays: STALE_AFTER_DAYS },
      "barrido de staleness de brand sources",
    );
  };
}
