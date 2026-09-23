/**
 * El cobro de cuota: content saves (`FR-050`) y créditos de AI Studio
 * (`FR-080`, `NFR-025`) — PRD §16.2 y §9.4.
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
 *
 * ## `quota_ledgers.ai_credits` cuenta CONSUMIDOS, no saldo restante
 *
 * La columna existía sin usarse y el PRD (`DATA-029`) sólo la nombra, así que
 * las dos lecturas eran posibles y la decisión es de acá. Es **consumidos en el
 * período**: el saldo se calcula contra el cupo del plan
 * (`PLANS[plan].aiStudioCredits`), igual que `consumeSave` calcula el de saves
 * contra `PLANS[plan].contentSaves` en vez de leerlo de la fila.
 *
 * Elegir "saldo restante" habría sido defendible por el nombre y por el campo
 * `aiCredits` de `NewPeriodDefaults`, pero **rompe sin ruido**: la fila del
 * período la crea quien llega primero, y hoy son tres caminos —el save de
 * `POST /content`, el reembolso del worker y esto— de los cuales dos la crean
 * con el default `0`. Con semántica de saldo, un workspace Growth que guardó
 * contenido antes de crear un influencer arranca el período con saldo 0 y
 * **todo influencer se rechaza con 402**, sin forma de distinguir "nunca se
 * sembró" de "se gastó todo". Con semántica de consumidos, `0` significa lo
 * mismo en los tres caminos: nada gastado.
 *
 * Lo que esta elección **no** cubre es `Buy more` / `+ Add credits` (FR-080):
 * un saldo comprado puede pasarse del cupo del plan y un contador de
 * consumidos no puede bajar de 0 (lo prohíbe el CHECK de la tabla). Cuando se
 * implemente la compra hace falta una columna aparte —`ai_credits_purchased`,
 * exactamente el papel que `content_saves_purchased` cumple para los saves—.
 * Está en el reporte; no se inventa acá porque comprar créditos pasa por el
 * puerto `Payments` y es otra tarea.
 */

import {
  AI_STUDIO_COST,
  billingPeriodKey,
  consumeSave,
  HARD_CAPS,
  isDomainError,
  nextBillingResetUtc,
  parsePlanId,
  PLANS,
  startAiStudioGeneration,
  type AiStudioOperation,
  type CreditsLedger,
  type PlanId,
  type SaveBucket,
  type SavesLedger,
} from "@fastgram/core";
import type { InsufficientCreditsDetails } from "@fastgram/contracts";
import {
  companyRepository,
  quotaLedgerStore,
  type CompanyBilling,
  type QuotaLedgerRow,
  type TenantScope,
  type Transaction,
} from "@fastgram/db";
import type { Clock } from "@fastgram/ports";

import { ApiRejection } from "../http/errors.js";

export interface ConsumedSave {
  readonly bucket: SaveBucket;
  /** La clave del ledger que se tocó. Hay que guardarla para reembolsar. */
  readonly period: string;
}

export interface LockedLedger {
  readonly company: CompanyBilling;
  readonly plan: PlanId;
  readonly now: Date;
  readonly period: string;
  readonly row: QuotaLedgerRow;
}

/**
 * Lee el plan y deja el ledger del período **bloqueado** hasta el commit.
 *
 * Los cobros pasan por acá para que los defaults del período los decida un
 * solo sitio. Cuando había un solo llamador eso era una preferencia; con varios
 * es lo que evita que el período se cree con un cupo distinto según quién
 * llegue primero, que es un descuadre que sólo se ve en la factura.
 *
 * Se exporta para `POST /blitz` (`routes/v1/blitz.ts`), que no puede usar
 * {@link consumeContentSave} tal cual: su gate es `acceptBlitzSuggestion` de
 * `core`, que evalúa saves **y** swipes juntos sobre la misma fila bloqueada.
 */
export async function lockLedger(
  tx: Transaction,
  scope: TenantScope,
  clock: Clock,
): Promise<LockedLedger> {
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

  const plan = parsePlanId(company.planId);
  const now = new Date(clock.nowMs());
  const period = billingPeriodKey(now, company.billingAnchorDay);

  const row = await quotaLedgerStore.lockPeriod(tx, scope, period, {
    // `null` = ilimitado (Pro). Se guarda 0 porque la columna es `integer` no
    // nulo, y da igual: `consumeSave` lee el cupo de `PLANS`, no de acá. Esta
    // columna es para soporte, no para decidir.
    contentSavesIncluded: PLANS[plan].contentSaves ?? 0,
    // `aiCredits` NO se siembra a propósito: es un contador de consumidos y su
    // default `0` ya es el valor correcto. Ver la cabecera.
  });

  return { company, plan, now, period, row };
}

/**
 * Descuenta un content save, o lanza `content_quota_exceeded` (→ `429`, ERR-R03,
 * con `count`/`limit`/`resetAt` en ms que `http/errors.ts` valida contra el
 * contrato antes de publicar). **No** es el 402 de los créditos de más abajo.
 *
 * Tiene que llamarse **dentro** de la transacción que crea el contenido, y
 * **antes** de encolar el build.
 */
export async function consumeContentSave(
  tx: Transaction,
  scope: TenantScope,
  clock: Clock,
): Promise<ConsumedSave> {
  const { company, plan, now, period, row: fila } = await lockLedger(tx, scope, clock);

  const ledger: SavesLedger = {
    plan,
    includedUsed: fila.contentSavesUsed,
    purchasedRemaining: fila.contentSavesPurchased,
    overageUsed: fila.overageUnits,
    overageEnabled: company.apiOverageEnabled,
    resetAt: nextBillingResetUtc(now, company.billingAnchorDay),
  };

  // Lanza `content_quota_exceeded` con `count`, `limit` y `resetAt` (ms) si no alcanza.
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
 * **El reembolso no está acá.** Vive en `apps/worker/src/support/quota.ts`,
 * porque quien reembolsa es el handler del build que falla, y este proceso no
 * falla ningún build. Tenerlo de los dos lados habría sido la segunda copia de
 * una regla de facturación: la que decide **a qué bucket** vuelve el save.
 */

// ───────────────────────────────────────────────────────────────────────────
// Créditos de AI Studio — `FR-080`, `NFR-025`, §9.5 #6
// ───────────────────────────────────────────────────────────────────────────

export interface ConsumeCreditsRequest {
  readonly operation: AiStudioOperation;
  /** Cuántas unidades. Un lote de 4 imágenes son 4 × 4 = 16 créditos. */
  readonly units?: number | undefined;
  /**
   * Generaciones encoladas o corriendo ahora mismo en este workspace.
   *
   * Lo cuenta el llamador porque no hay una sola tabla que lo sepa: ver la nota
   * de `POST /influencers`. **Un `0` de relleno convierte el cap de 10 en
   * decoración**, así que quien no pueda contarlo de verdad tiene que decirlo,
   * no pasar cero.
   */
  readonly inFlightCount: number;
}

export interface ConsumedAiCredits {
  /** La clave del ledger que se tocó. Hay que guardarla para reembolsar. */
  readonly period: string;
  /** Lo reservado. Es lo que hay que devolver si la generación falla. */
  readonly charged: number;
  /** Saldo antes del cargo. Sirve para el `details.balance` de FR-080. */
  readonly balanceBefore: number;
}

/**
 * Reserva créditos de AI Studio antes del trabajo caro.
 *
 * Tiene que llamarse **dentro** de la transacción que crea la fila y **antes**
 * de encolar el pipeline, por lo mismo que el save de content: si el cobro se
 * confirmara aparte y el encolado fallara después, el cliente pagaría 250
 * créditos por un pipeline que no existe.
 *
 * El orden de los dos límites —concurrencia y después créditos— lo impone
 * `startAiStudioGeneration` y está argumentado en su cabecera: rechazando
 * primero lo barato no queda nada que compensar. Acá no se reordena.
 */
export async function consumeAiStudioCredits(
  tx: Transaction,
  scope: TenantScope,
  clock: Clock,
  request: ConsumeCreditsRequest,
): Promise<ConsumedAiCredits> {
  const { company, plan, now, period, row } = await lockLedger(tx, scope, clock);

  // Saldo = cupo del plan − consumidos. Se acota en 0 porque una bajada de plan
  // deja consumidos > cupo (gastó 400 en Growth y pasó a Starter, que trae 250)
  // y un saldo negativo haría que el mensaje del 402 hablara de un número
  // imposible.
  const balanceBefore = Math.max(0, PLANS[plan].aiStudioCredits - row.aiCredits);

  const credits: CreditsLedger = {
    remaining: balanceBefore,
    resetAt: nextBillingResetUtc(now, company.billingAnchorDay),
  };

  let charged: number;
  try {
    charged = startAiStudioGeneration({
      operation: request.operation,
      units: request.units,
      inFlightCount: request.inFlightCount,
      credits,
    }).reservedCredits;
  } catch (e: unknown) {
    throw asApiRejection(e, request, balanceBefore);
  }

  // El cargo se escribe sobre lo que leyó el `lockPeriod` de esta misma
  // transacción, no sobre `credits.remaining`: `charged` es exactamente lo que
  // hay que devolver si el pipeline falla, y sumarlo al contador mantiene esa
  // simetría incluso cuando el saldo venía acotado por el `Math.max` de arriba.
  await quotaLedgerStore.writeAiCredits(tx, scope, period, row.aiCredits + charged);

  return { period, charged, balanceBefore };
}

/**
 * Traduce los dos rechazos de `startAiStudioGeneration` al contrato del PRD.
 *
 * Hace falta porque `DomainError` no alcanza para ninguno de los dos:
 *
 *  - **Créditos insuficientes.** FR-080 (PRD:1519) fija `402 payment_required`
 *    con `details.balance` y `details.required`, y hay un schema del contrato
 *    que lo tipa (`insufficientCreditsDetailsSchema`). `reserveCredits` lanza
 *    `content_quota_exceeded` con `{resetAt, required}`: el código no es el que
 *    el PRD nombra para este endpoint y **falta `balance`**, que es el dato que
 *    la UI usa para el copy *"<N> more credits to continue."*. El saldo sólo se
 *    conoce acá, así que acá se arma.
 *
 *    Por eso **no** se toca `DOMAIN_CODES_WITH_PUBLIC_DETAILS`: no hace falta:
 *    `ApiRejection.publicDetails` ya es la puerta explícita para lo que sí se
 *    publica, y el default de `DomainError.details` —no salir— se queda como
 *    está.
 *
 *  - **Cap de concurrencia.** `assertCanStartGeneration` lanza `out_of_range`,
 *    que `http/errors.ts` mapea a **400**. Un 400 le dice al cliente que su
 *    petición está mal formada y que no reintente, cuando el PRD manda
 *    justamente esperar (ERR-R07, acción *"esperar"*). El PRD **no fija el
 *    código HTTP** de este caso: §19.8 le da copy literal y acción pero no
 *    status, y la lista de errores de FR-080 no lo menciona. Se elige `409
 *    conflict` —un código que FR-080 ya usa en este endpoint y que significa
 *    "el estado actual no lo permite, volvé a intentar"— en vez de `429
 *    rate_limited`, porque el `details` tipado de `rate_limited`
 *    (`rateLimitedDetailsSchema`) exige `retryAfterMs` y acá no hay forma
 *    honesta de calcularlo: un pipeline tarda 15–20 minutos y el que libera el
 *    slot puede ser cualquiera de los diez. Queda reportado como decisión.
 */
function asApiRejection(
  e: unknown,
  request: ConsumeCreditsRequest,
  balance: number,
): unknown {
  if (!isDomainError(e)) return e;

  if (e.code === "content_quota_exceeded") {
    const details: InsufficientCreditsDetails = {
      balance,
      required: AI_STUDIO_COST[request.operation] * (request.units ?? 1),
    };
    // Copy literal de FR-080 (PRD:1519) y de ERR-R08.
    return new ApiRejection(
      402,
      "payment_required",
      "Not enough credits. Top up or upgrade to continue.",
      { ...details },
    );
  }

  // `out_of_range` cubre dos casos en `startAiStudioGeneration`: el cap de
  // concurrencia y un `units` no positivo. Sólo se traduce el primero, y la
  // condición es la que hace verdadero el mensaje — traducir el otro diría
  // "tenés 10 generaciones en vuelo" sobre una petición con `units: 0`.
  if (
    e.code === "out_of_range" &&
    request.inFlightCount >= HARD_CAPS.inFlightGenerations
  ) {
    return new ApiRejection(
      409,
      "conflict",
      // Copy literal de ERR-R07 (§19.8).
      `You have ${String(HARD_CAPS.inFlightGenerations)} generations in flight. Wait for some to finish before starting another.`,
      { cap: HARD_CAPS.inFlightGenerations, inFlight: request.inFlightCount },
    );
  }

  return e;
}
