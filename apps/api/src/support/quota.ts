/**
 * El cobro de content saves — `FR-050`, PRD §16.2 y §9.4.
 *
 * ## Por qué esto no estaba
 *
 * El motor de cuotas de `packages/core` está escrito y testeado desde hace
 * tiempo: `consumeSave` sabe el orden incluido → comprado → overage, y
 * `refundSave` devuelve **al bucket del que salió**. Lo que faltaba era todo lo
 * de alrededor: de dónde sale el plan (no había repositorio de `companies`), qué
 * clave identifica el período (el schema lo dejaba pendiente) y dónde se guarda
 * el bucket (no había columna). Sin esas tres cosas, `POST /content` **no
 * cobraba nada**.
 *
 * ## Las tres cosas que este archivo hace en el orden correcto
 *
 * 1. **Bloquea el ledger antes de decidir.** §9.4 pide reservas *atómicas*, y
 *    una lectura seguida de una escritura no lo es: dos peticiones simultáneas
 *    leerían el mismo saldo y las dos consumirían. El bloqueo vive en
 *    `quotaLedgerStore.lockPeriod`, y su test de concurrencia se pone rojo si
 *    se le quita.
 * 2. **Cobra antes de trabajar, no después.** El PRD lo dice literal: *"reserva
 *    la allowance antes de la generación del modelo, y la libera si falla"*.
 *    Cobrar después significa que un fallo a mitad de camino deja trabajo hecho
 *    y no pagado, o peor, trabajo pagado dos veces al reintentar.
 * 3. **Todo dentro de la transacción del llamador.** Si el cobro se
 *    confirmara por su cuenta y la creación del contenido fallara después, el
 *    cliente pagaría por una pieza que no existe — y no habría nada a qué
 *    asociar el reembolso, porque el reembolso se dispara desde el contenido.
 */

import {
  billingPeriodKey,
  consumeSave,
  DomainError,
  nextBillingResetUtc,
  PLANS,
  PLAN_IDS,
  refundSave,
  type PlanId,
  type SaveBucket,
  type SavesLedger,
} from "@fastgram/core";
import {
  companyRepository,
  quotaLedgerStore,
  type TenantScope,
  type Transaction,
} from "@fastgram/db";
import type { Clock } from "@fastgram/ports";

export interface ConsumedSave {
  readonly bucket: SaveBucket;
  /** La clave del ledger que se tocó. Hay que guardarla para reembolsar. */
  readonly period: string;
}

/**
 * Descuenta un content save, o lanza `content_quota_exceeded` (→ `402`).
 *
 * Tiene que llamarse **dentro** de la transacción que crea el contenido, y
 * **antes** de encolar el build.
 */
export async function consumeContentSave(
  tx: Transaction,
  scope: TenantScope,
  clock: Clock,
): Promise<ConsumedSave> {
  const company = await companyRepository.billing(tx, scope);
  if (company === null) {
    // El scope viene del hook de auth, así que el workspace existe. Si no está,
    // es que el GUC de la transacción no coincide con el del scope — bug de
    // cableado, no de datos, y un default silencioso lo escondería.
    throw new Error(
      "No se pudo leer el workspace para cobrar la cuota. Casi siempre es que " +
        "`app.current_company` no coincide con el scope de la petición.",
    );
  }

  const plan = asPlanId(company.planId);
  const now = new Date(clock.nowMs());
  const period = billingPeriodKey(now, company.billingAnchorDay);

  const fila = await quotaLedgerStore.lockPeriod(tx, scope, period, {
    // `null` = ilimitado (Pro). Se guarda 0 porque la columna es `integer` no
    // nulo, y da igual: `consumeSave` lee el cupo de `PLANS`, no de acá. Esta
    // columna es para soporte, no para decidir.
    contentSavesIncluded: PLANS[plan].contentSaves ?? 0,
  });

  const ledger: SavesLedger = {
    plan,
    includedUsed: fila.contentSavesUsed,
    purchasedRemaining: fila.contentSavesPurchased,
    overageUsed: fila.overageUnits,
    overageEnabled: company.apiOverageEnabled,
    resetAt: nextBillingResetUtc(now, company.billingAnchorDay),
  };

  // Lanza `content_quota_exceeded` con `resetAt` en los detalles si no alcanza.
  // Al lanzar dentro de la transacción, el rollback deshace el lock y no queda
  // nada a medio escribir.
  const { ledger: despues, bucket } = consumeSave(ledger);

  await quotaLedgerStore.writeCounters(tx, scope, period, {
    contentSavesUsed: despues.includedUsed,
    contentSavesPurchased: despues.purchasedRemaining,
    overageUnits: despues.overageUsed,
  });

  return { bucket, period };
}

/**
 * Devuelve un save al bucket del que salió — `FR-050`.
 *
 * Quien llama es responsable de no llamarlo dos veces por el mismo cargo: esa
 * guarda es `contents.saveRefundedAt`, y la base la sostiene con un CHECK que
 * impide marcar un reembolso sobre una pieza que nunca se cobró.
 *
 * `period` es el del cobro, no el de hoy. Un build que falla en el ciclo
 * siguiente tiene que devolver el save **al período que lo cobró**; devolverlo
 * al actual le sumaría cupo de un mes que el cliente no pagó y dejaría el
 * anterior cobrado de más.
 */
export async function refundContentSave(
  tx: Transaction,
  scope: TenantScope,
  period: string,
  bucket: SaveBucket,
  clock: Clock,
): Promise<void> {
  const company = await companyRepository.billing(tx, scope);
  if (company === null) return;

  const plan = asPlanId(company.planId);
  const now = new Date(clock.nowMs());

  const fila = await quotaLedgerStore.lockPeriod(tx, scope, period, {
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
 * `companies.planId` es `text` porque el PRD no define `Plan` como entidad.
 *
 * Un plan desconocido **no** cae a `free`: eso cobraría de menos o bloquearía
 * de más, en silencio y a un cliente real. Es un error de datos y tiene que
 * verse como tal.
 */
function asPlanId(value: string): PlanId {
  if ((PLAN_IDS as readonly string[]).includes(value)) return value as PlanId;
  throw new DomainError("invalid_state", "This workspace has an unknown plan.", {
    planId: value,
  });
}
