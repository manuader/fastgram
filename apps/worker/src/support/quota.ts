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
