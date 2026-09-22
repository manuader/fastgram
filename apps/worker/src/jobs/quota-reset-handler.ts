/**
 * El handler de `quota-reset` — PRD §9.5 #17, §16.2, `P1-QUOTA-013`.
 *
 * ## Es red, no mecanismo, y de eso sale todo lo demás
 *
 * El reset de cuota **no ocurre acá**. Se calcula en lectura contra el reloj
 * (`core/quota/reset.ts`), y ésa es la decisión 7 del handoff: si dependiera de
 * este cron, la cuota de un cliente dependería de que el cron haya corrido. Un
 * cron que no corrió un martes no puede ser la diferencia entre poder crear
 * contenido y no poder.
 *
 * Lo que queda para el cron es una sola cosa, y es la que el catálogo ya
 * declara: *"limpia contadores de cuentas inactivas que nadie consultó"*.
 *
 * ## Qué hace, exactamente
 *
 * Pone en cero los `dailySwipesUsed` cuyo `dailySwipeResetAt` ya venció, y
 * adelanta ese instante al próximo 00:00 UTC. Es el **único** contador del
 * ledger que guarda su propio instante de reset y que, por lo tanto, puede
 * quedar viejo indefinidamente en un workspace que nadie consulta.
 *
 * El invariante que lo mantiene como red: **sólo deja la fila en el estado que
 * el camino de lectura calcularía en ese mismo instante**, porque usa el mismo
 * `nextDailyResetUtc` del dominio. Si este job nunca corriera, la primera
 * lectura de ese workspace arreglaría la fila igual. Eso es lo que se puede
 * romper sin romper la facturación, y es la prueba de que el alcance es el
 * correcto.
 *
 * ## Qué NO hace, y por qué — la parte que hay que defender
 *
 * - **No reinicia los content saves.** Su reset *es* la clave del período: al
 *   cruzar el ancla de facturación aparece una fila nueva (la crea `lockPeriod`
 *   en la primera petición del ciclo) y la vieja queda como historia. Un
 *   `UPDATE` sobre la vieja reescribiría una factura cerrada.
 * - **No arrastra el saldo comprado.** Eso lo hace `lockPeriod` al crear el
 *   período, por el mismo criterio de la decisión 7: hacerlo acá ataría el
 *   saldo comprado de un cliente a que el cron haya corrido. Ver
 *   `P1-QUOTA-012`.
 * - **No crea el ledger del período siguiente.** Sería adelantarse: el saldo
 *   comprado todavía puede moverse antes del corte, y crear la fila antes fija
 *   un arrastre que después queda viejo. Además volvería al cron mecanismo.
 * - **No borra ni archiva períodos viejos.** Son historia de facturación
 *   (§16.4 muestra el período en el portal, y soporte lo lee). Una retención es
 *   una decisión de producto que nadie tomó todavía.
 * - **No toca los créditos de AI Studio ni los warmed slots.** Los créditos son
 *   recargables y los otorga un evento de facturación; los slots se compran.
 *   Un cron que los pusiera en un número estaría inventando facturación.
 * - **No expira nada.** §16.2 no tiene ni una cuota que caduque por tiempo
 *   salvo por reset, y el trial explícitamente no resetea nunca.
 *
 * ## El barrido corre sin `companyId`, y esa excepción tiene dueño
 *
 * No hay workspace en el payload: es un barrido. Así que no puede usar
 * `withCompany`, y sale del scope de tenant que el resto del sistema exige.
 * La excepción está acotada en el único lugar donde se puede acotar de verdad
 * —el SQL— y documentada ahí: `quotaLedgerStore.sweepExpiredDailySwipes` y la
 * migración `0006_quota_swipe_sweep.sql`. Resumen de su tamaño: no recibe
 * `companyId`, no devuelve ni una fila de ningún cliente (devuelve un entero),
 * y escribe dos columnas de una tabla sólo en filas ya vencidas.
 *
 * `withoutCompany` por sí solo **no** alcanzaba: `quota_ledgers` tiene
 * `FORCE ROW LEVEL SECURITY`, así que sin GUC un `UPDATE` afecta cero filas sin
 * error. De ahí la función `SECURITY DEFINER`.
 *
 * ## El payload se ignora, a propósito
 *
 * Un barrido cross-tenant que leyera un `companyId` del payload sería una
 * manera de mover los contadores de otro workspace desde la cola. No hay nada
 * que parsear: lo que llega se descarta.
 *
 * ## Fallos: acá sí se relanza siempre
 *
 * Al revés que `content-build`, que en el último intento tiene que cerrar la
 * pieza y devolver el save: acá no hay nada cobrado esperando. Si el barrido
 * falla los tres intentos, lo único que queda es un contador viejo en cuentas
 * que nadie consultó, y la primera lectura de cada una lo arregla. Así que el
 * error se propaga tal cual y la cola aplica su backoff.
 */

import { nextDailyResetUtc } from "@fastgram/core";
import { quotaLedgerStore, withoutCompany, type Database } from "@fastgram/db";
import type { Clock, JobContext, JobHandler } from "@fastgram/ports";

/** Lo mínimo que este handler necesita loguear. `pino` lo cumple. */
export interface QuotaResetLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface QuotaResetDeps {
  readonly db: Database;
  readonly clock: Clock;
  /**
   * Rol para el `SET LOCAL ROLE` de cada transacción. Mismo criterio que el
   * handler de build: sin él, un proceso conectado como superusuario saltea RLS
   * y el aislamiento deja de existir sin que nada avise. Acá tiene un efecto
   * extra que conviene saber: con el rol puesto, el barrido **sólo** funciona a
   * través de la función `SECURITY DEFINER`.
   */
  readonly appRole?: string | undefined;
  readonly logger: QuotaResetLogger;
  /**
   * Filas por transacción.
   *
   * Cada tanda es su propia transacción corta a propósito: una sola sentencia
   * sobre la tabla entera mantendría bloqueadas las filas de workspaces activos
   * mientras dura, y el job tiene `timeoutSeconds: 300` en el catálogo.
   */
  readonly batchSize?: number;
  /**
   * Tope de tandas por corrida.
   *
   * Es la red contra un barrido que no termina: si cada tanda encuentra trabajo
   * indefinidamente, algo está reescribiendo los instantes de reset hacia el
   * pasado y hay que verlo en el log, no descubrirlo por un job colgado.
   */
  readonly maxBatches?: number;
}

const BATCH_SIZE = 500;
const MAX_BATCHES = 200;

export function createQuotaResetHandler(deps: QuotaResetDeps): JobHandler<unknown> {
  const batchSize = deps.batchSize ?? BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? MAX_BATCHES;

  return async function handle(_ctx: JobContext<unknown>): Promise<void> {
    // Un solo instante para toda la corrida. Si una corrida cruzara la
    // medianoche, `now` y `nextResetAt` siguen siendo coherentes entre sí
    // —salen del mismo instante— y una fila barrida con el borde de ayer se
    // vuelve a barrer mañana. Es lo peor que puede pasar y no cuesta nada.
    const now = new Date(deps.clock.nowMs());
    const nextResetAt = nextDailyResetUtc(now);

    let barridas = 0;
    let tandas = 0;

    while (tandas < maxBatches) {
      const enEstaTanda = await withoutCompany(
        deps.db,
        (tx) => quotaLedgerStore.sweepExpiredDailySwipes(tx, now, nextResetAt, batchSize),
        deps.appRole === undefined ? {} : { role: deps.appRole },
      );
      tandas += 1;
      barridas += enEstaTanda;

      // Menos que el límite = no quedó nada vencido. Con `SKIP LOCKED` una
      // tanda también puede volver corta porque alguien tenía filas
      // bloqueadas; esas las resetea su propia lectura, así que cortar acá es
      // correcto y no deja trabajo perdido.
      if (enEstaTanda < batchSize) break;
    }

    const agotado = tandas >= maxBatches;
    deps.logger.info(
      { barridas, tandas, hasta: nextResetAt.toISOString() },
      "quota-reset: contadores de swipes diarios vencidos puestos en cero",
    );
    if (agotado) {
      deps.logger.warn(
        { barridas, tandas },
        "quota-reset: se agotó el tope de tandas y todavía había trabajo; " +
          "revisar si algo escribe `dailySwipeResetAt` en el pasado",
      );
    }
  };
}
