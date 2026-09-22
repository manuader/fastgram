/**
 * El reembolso del content save — `FR-050`, PRD §16.2.
 *
 * ## Por qué está acá y no en `apps/api`
 *
 * Porque quien reembolsa es **el handler del build que falla**, y ése corre en
 * este proceso. La API cobra (`apps/api/src/support/quota.ts`) y no reembolsa
 * nunca; el worker reembolsa y no cobra nunca. Cada app tiene la mitad que de
 * verdad ejecuta, y por eso no hay dos copias de la regla que decide **a qué
 * bucket** vuelve el save — que es la parte cara de equivocarse, porque los
 * tres buckets tienen precio distinto y el error no tiene síntoma.
 *
 * Lo que sí es común vive en `core`: `refundSave` hace la aritmética y
 * `parsePlanId` estrecha el plan sin caer a `free` por las dudas.
 *
 * ## El período es el del cobro, no el de hoy
 *
 * Un build que falla en el ciclo siguiente tiene que devolver el save **al
 * período que lo cobró**. Devolverlo al actual le sumaría cupo de un mes que el
 * cliente no pagó y dejaría el anterior cobrado de más. Por eso el período
 * llega como parámetro —sale de `contents.savePeriod`— y no se deriva del
 * reloj: derivarlo depende de `billingAnchorDay`, que pudo cambiar entremedio.
 */

import {
  nextBillingResetUtc,
  parsePlanId,
  PLANS,
  refundSave,
  type SaveBucket,
} from "@fastgram/core";
import {
  companyRepository,
  quotaLedgerStore,
  type TenantScope,
  type Transaction,
} from "@fastgram/db";
import type { Clock } from "@fastgram/ports";

/**
 * Devuelve un save al bucket del que salió.
 *
 * Tiene que llamarse **dentro** de la transacción que marca la pieza como
 * `FAILED`. Si el reembolso se confirmara aparte, entre los dos pasos habría
 * una ventana en la que el usuario perdió el save y la pieza ya está muerta —
 * que es exactamente lo que el encolado transaccional de `ADR-005` existe para
 * evitar del otro lado.
 *
 * **No es idempotente por sí misma**: la guarda contra el doble reembolso es
 * `contents.saveRefundedAt`, y la comprueba quien llama, con la fila bloqueada.
 * Ponerla acá adentro obligaría a este módulo a saber de contenidos, y el mismo
 * mecanismo tiene que servir después para los créditos de AI Studio.
 */
export async function refundContentSave(
  tx: Transaction,
  scope: TenantScope,
  period: string,
  bucket: SaveBucket,
  clock: Clock,
): Promise<void> {
  const company = await companyRepository.billing(tx, scope);
  if (company === null) {
    // El `companyId` sale del payload del job, que lo escribió la API dentro de
    // la transacción que creó la pieza. Si el workspace no está, el GUC de esta
    // transacción no coincide con el scope: bug de cableado, no de datos, y un
    // return silencioso lo escondería regalando saves.
    throw new Error(
      `No se pudo leer el workspace ${scope.companyId} para reembolsar el save. ` +
        "Casi siempre es que `app.current_company` no coincide con el scope.",
    );
  }

  const plan = parsePlanId(company.planId);
  const now = new Date(clock.nowMs());

  const fila = await quotaLedgerStore.lockPeriod(tx, scope, period, {
    // `null` = ilimitado (Pro); se guarda 0 porque la columna es `integer` no
    // nulo. `refundSave` lee el cupo de `PLANS`, no de acá.
    contentSavesIncluded: PLANS[plan].contentSaves ?? 0,
  });

  const despues = refundSave(
    {
      plan,
      includedUsed: fila.contentSavesUsed,
      purchasedRemaining: fila.contentSavesPurchased,
      overageUsed: fila.overageUnits,
      overageEnabled: company.apiOverageEnabled,
      resetAt: nextBillingResetUtc(now, company.billingAnchorDay),
    },
    bucket,
  );

  await quotaLedgerStore.writeCounters(tx, scope, period, {
    contentSavesUsed: despues.includedUsed,
    contentSavesPurchased: despues.purchasedRemaining,
    overageUnits: despues.overageUsed,
  });
}

/**
 * Devuelve los créditos de AI Studio de un pipeline que falló — `FR-080`, §9.4.
 *
 * ## Por qué NO usa `releaseAiStudioGeneration` de `core`
 *
 * Porque devuelve **lo que se cobró**, no lo que costaría hoy. `core` trabaja
 * sobre un `CreditsLedger` con saldo *restante* (`remaining`), y la columna
 * `quota_ledgers.ai_credits` cuenta *consumidos* — la decisión está argumentada
 * en `apps/api/src/support/quota.ts` y se resume en que la fila del período la
 * crea quien llega primero, así que un `0` tiene que significar lo mismo por los
 * tres caminos que la crean.
 *
 * Con esa forma, llamar a `releaseAiStudioGeneration` obligaría a inventar un
 * `remaining` a partir del plan, sumarle el costo y volver a convertir. Ese ida
 * y vuelta sólo puede introducir error, y además usaría `AI_STUDIO_COST` de
 * **hoy**: si la tarifa cambia entre el cobro y el fallo —`OQ-21` está abierta
 * justamente sobre eso— el cliente recibiría de vuelta un número distinto del
 * que se le sacó.
 *
 * Por eso el monto llega como parámetro y sale de `influencers.credits_charged`,
 * que es lo que de verdad se descontó. Es la misma razón por la que
 * `contents.save_bucket` se persiste en vez de recalcularse.
 *
 * **Sin `Clock`**, al revés que `refundContentSave`. Ése lo necesita para
 * calcular el `resetAt` que `refundSave` le pide; acá el período llega como
 * parámetro y la aritmética es una resta, así que un reloj sería un argumento
 * que nadie lee. El compilador me lo marcó después de copiar la firma.
 *
 * ## La guarda contra el doble reembolso NO está acá
 *
 * Está en `influencerCreditsStore.claimCreditsRefund`, que marca y devuelve el
 * cargo **en una sola sentencia**: quien recibe un objeto es el único que lo va
 * a recibir. Esta función asume que ya ganó ese derecho, y llamarla sin haberlo
 * ganado regala créditos. Se separa así porque la atomicidad la da el `UPDATE …
 * RETURNING`, no esta aritmética.
 */
export async function refundAiCredits(
  tx: Transaction,
  scope: TenantScope,
  period: string,
  charged: number,
): Promise<void> {
  const company = await companyRepository.billing(tx, scope);
  if (company === null) {
    throw new Error(
      `No se pudo leer el workspace ${scope.companyId} para devolver créditos. ` +
        "Casi siempre es que `app.current_company` no coincide con el scope.",
    );
  }

  const plan = parsePlanId(company.planId);
  const fila = await quotaLedgerStore.lockPeriod(tx, scope, period, {
    contentSavesIncluded: PLANS[plan].contentSaves ?? 0,
  });

  // `Math.max(0, …)` y no una resta pelada: el CHECK de la base prohíbe
  // contadores negativos, así que un cargo mayor que lo consumido —una fila
  // editada a mano, un período reescrito— haría fallar la transacción entera y
  // el pipeline se quedaría sin cerrar. Devolver de menos es recuperable;
  // dejar el influencer colgado, no.
  await quotaLedgerStore.writeAiCredits(
    tx,
    scope,
    period,
    Math.max(0, fila.aiCredits - charged),
  );
}
