/**
 * El handler de `influencer-pipeline` — PRD §9.5 #5, `FR-080`, §9.4.
 *
 * `POST /influencers` crea la fila, **cobra 250 créditos de AI Studio** y encola
 * esto. Del otro lado no había nadie, así que el influencer se quedaba en
 * `generating_variations` para siempre y **los 250 créditos no volvían nunca**.
 * Es el mismo agujero que tuvo el content save hasta hace dos tandas, con el
 * mismo final: un cargo sin quien lo devuelva no se devuelve.
 *
 * ## Lo que hoy hace, y por qué es poco a propósito
 *
 * **No hay adaptador de `MediaGeneration`.** El puerto existe
 * (`generateImages`, `trainCharacter`), y no hay ninguna implementación real: el
 * pipeline de `FR-080` son 15–20 minutos de GPU contra un proveedor que todavía
 * no se eligió. Así que sin generador montado este handler hace **lo único
 * honesto que se puede hacer**: marca el influencer `failed` y **devuelve los
 * 250 créditos**. El motivo va al log y no a la fila, porque `DATA-013` no
 * define un campo de error — ver el comentario en `failAndRefund`.
 *
 * Es exactamente el mismo criterio que el handler de `publishing` con su mapa de
 * publicadores vacío. Dejar el influencer en `generating_variations` sería
 * ocultar que no pasa nada; marcarlo `ready` sería mentir sobre un personaje que
 * no se puede usar. Fallar y devolver la plata es la verdad, y es reversible: el
 * usuario lo vuelve a crear cuando el generador exista.
 *
 * ## El reembolso, que es la parte que no se puede romper
 *
 * La guarda contra el doble reembolso **no está acá**: está en
 * `influencerCreditsStore.claimCreditsRefund`, que marca `creditsRefundedAt` y
 * devuelve el cargo **en la misma sentencia**. Quien recibe un objeto es el
 * único que lo va a recibir; quien recibe `null` no tiene nada que hacer. Un
 * `SELECT` seguido de un `UPDATE` no tendría esa propiedad — las dos
 * transacciones leerían `null` y las dos devolverían— y es la misma carrera que
 * dejó pasar 120 de 120 peticiones contra un límite de 60.
 *
 * El monto sale de `influencers.credits_charged`, o sea **lo que de verdad se
 * cobró**, no lo que costaría hoy: `OQ-21` está abierta sobre el tarifario y una
 * tarifa que cambie entre el cobro y el fallo devolvería un número distinto del
 * que se sacó.
 *
 * Y el reembolso va en **la misma transacción** que marca el estado. Si fueran
 * dos, entre ellas habría una ventana donde el personaje ya está muerto y el
 * usuario todavía no tiene sus créditos.
 */

import { parseInfluencerPipelineJob, type InfluencerPipelineJob } from "@fastgram/core";
import {
  influencerCreditsStore,
  influencerRepository,
  withCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";
import { PortError, type Clock, type JobContext, type JobHandler } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { refundAiCredits } from "../support/quota.js";

/**
 * Lo mínimo del puerto `MediaGeneration` que este handler usa.
 *
 * Se declara acá en vez de importar el puerto entero porque hoy **no hay
 * adaptador** y el handler sólo necesita saber arrancar el pipeline. Cuando
 * exista uno real, esto se reemplaza por el puerto y el cambio es de una línea.
 */
export interface PipelineGenerator {
  start(job: InfluencerPipelineJob): Promise<void>;
}

export interface InfluencerPipelineDeps {
  readonly db: Database;
  /** `undefined` = no hay generador montado. Ver el encabezado. */
  readonly generator?: PipelineGenerator | undefined;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
}

/** Los estados de `DATA-013` que significan "el pipeline está corriendo". */
const EN_VUELO: ReadonlySet<string> = new Set(["generating_variations", "training"]);

export function createInfluencerPipelineHandler(
  deps: InfluencerPipelineDeps,
): JobHandler<unknown> {
  const inCompany = <T>(
    companyId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  /**
   * Cierra el personaje como fallido y devuelve los créditos, en una sola
   * transacción.
   *
   * Devuelve cuántos créditos volvieron: `0` significa que no había nada que
   * devolver —nunca se cobró, o alguien ya reembolsó— y es un resultado normal,
   * no un error.
   */
  async function failAndRefund(job: InfluencerPipelineJob): Promise<number> {
    return inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      const row = await influencerCreditsStore.lockInfluencer(
        tx,
        scope,
        job.influencerId,
      );
      if (row === null) return 0;

      // Un pipeline que ya se resolvió no se vuelve a cerrar. Sin esto, un job
      // reentregado marcaría `failed` un personaje que quedó `ready`.
      if (!EN_VUELO.has(row.status)) return 0;

      const charge = await influencerCreditsStore.claimCreditsRefund(
        tx,
        scope,
        job.influencerId,
        new Date(deps.clock.nowMs()),
      );

      if (charge !== null) {
        await refundAiCredits(tx, scope, charge.period, charge.charged);
      }

      // **El motivo no se persiste, porque no hay dónde.** `DATA-013` no define
      // un campo de error en `Influencer` y la tabla no tiene columna: las
      // únicas candidatas serían `internalRefs` —el `jsonb` del que la
      // migración `0007` acaba de sacar el cargo, justamente porque un `update`
      // lo reemplaza entero— o inventar una columna desde acá, que es un cambio
      // de schema y de contrato. Así que el mensaje va al log y el usuario ve
      // un `failed` pelado. Queda reportado.
      await influencerRepository.update(tx, scope, job.influencerId, {
        status: "failed",
      });

      return charge?.charged ?? 0;
    });
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseInfluencerPipelineJob(ctx.payload);
    if (!parsed.ok) {
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de influencer-pipeline inválido",
      );
      return;
    }

    const job = parsed.payload;
    const base = { jobId: ctx.jobId, influencerId: job.influencerId };

    if (deps.generator === undefined) {
      const devueltos = await failAndRefund(job);
      deps.logger.warn(
        { ...base, devueltos, motivo: "no hay adaptador de MediaGeneration montado" },
        "no hay generador montado: el personaje se cierra y los créditos vuelven",
      );
      return;
    }

    try {
      await deps.generator.start(job);
      deps.logger.info(base, "pipeline de influencer arrancado");
    } catch (error: unknown) {
      const code = error instanceof PortError ? error.code : "unknown";
      const devueltos = await failAndRefund(job);
      deps.logger.error({ ...base, code, devueltos, error }, "el pipeline falló");
    }
  };
}
