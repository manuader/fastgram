/**
 * Cuota de content saves — PRD §16.2 y §16.6.
 *
 * La regla completa, del PRD:
 *
 *   "Orden de consumo: incluidos → comprados → overage medido (si está
 *    habilitado). Un build fallido **reembolsa**. Borrar contenido **no**
 *    reembolsa."
 *
 * Las tres partes importan y las tres se implementan mal con facilidad:
 *
 * 1. **El orden** no es arbitrario. Los incluidos caducan al cerrar el
 *    período; los comprados no. Gastar primero los comprados le quema al
 *    cliente saldo permanente mientras deja vencer saldo que ya pagó.
 *
 * 2. **El reembolso por build fallido** es lo que obliga a que el encolado del
 *    job ocurra dentro de la misma transacción que descuenta la cuota
 *    (IMPL §2.3, ADR-005). Para reembolsar con certeza hay que saber que el
 *    job existe.
 *
 * 3. **Borrar no reembolsa.** Es deliberado: si borrar devolviera el save, la
 *    cuota dejaría de medir generación —que es lo que cuesta— y pasaría a
 *    medir almacenamiento.
 */
import { DomainError } from "../errors.js";
import {
  AI_STUDIO_COST,
  PLANS,
  UNKNOWN_LIMITS,
  type AiStudioOperation,
  type PlanId,
} from "./plans.js";
import { nextDailyResetUtc } from "./reset.js";

/** De dónde salió un save. El orden de este array ES el orden de consumo. */
export const SAVE_BUCKETS = ["included", "purchased", "overage"] as const;
export type SaveBucket = (typeof SAVE_BUCKETS)[number];

export interface SavesLedger {
  readonly plan: PlanId;
  /** Consumidos del cupo del plan en el período actual. */
  readonly includedUsed: number;
  /** Saldo comprado disponible. No caduca al cerrar el período. */
  readonly purchasedRemaining: number;
  /** Saves facturados por encima de la cuota en el período actual. */
  readonly overageUsed: number;
  /** `Settings → API`. Si está en false, agotada la cuota se corta (§16.6). */
  readonly overageEnabled: boolean;
  /** Cuándo se reinicia el cupo incluido. */
  readonly resetAt: Date;
}

export interface SaveConsumption {
  readonly ledger: SavesLedger;
  /** De qué bucket salió. Se persiste: es lo que permite reembolsar bien. */
  readonly bucket: SaveBucket;
}

/**
 * Descuenta un content save.
 *
 * Lanza `DomainError("content_quota_exceeded")` si no hay de dónde. El error
 * lleva `resetAt` en los detalles, como exige el PRD.
 */
export function consumeSave(ledger: SavesLedger): SaveConsumption {
  const included = PLANS[ledger.plan].contentSaves;

  // Pro: ilimitado. No se lleva contador ni se factura overage.
  if (included === null) {
    return { ledger, bucket: "included" };
  }

  if (ledger.includedUsed < included) {
    return {
      ledger: { ...ledger, includedUsed: ledger.includedUsed + 1 },
      bucket: "included",
    };
  }

  if (ledger.purchasedRemaining > 0) {
    return {
      ledger: { ...ledger, purchasedRemaining: ledger.purchasedRemaining - 1 },
      bucket: "purchased",
    };
  }

  if (ledger.overageEnabled) {
    return {
      ledger: { ...ledger, overageUsed: ledger.overageUsed + 1 },
      bucket: "overage",
    };
  }

  throw new DomainError(
    "content_quota_exceeded",
    "You've used all your content saves for this billing period.",
    { resetAt: ledger.resetAt.toISOString(), plan: ledger.plan },
  );
}

/**
 * Devuelve un save al bucket del que salió, tras un build fallido.
 *
 * Reembolsar siempre a `included` sería más simple y estaría mal: si el save
 * salió del saldo comprado, devolverlo al cupo incluido le regala al cliente
 * un save que caduca y le come uno permanente. Por eso `SaveConsumption`
 * guarda el bucket y por eso hay que persistirlo con el contenido.
 */
export function refundSave(ledger: SavesLedger, bucket: SaveBucket): SavesLedger {
  switch (bucket) {
    case "included":
      return { ...ledger, includedUsed: Math.max(0, ledger.includedUsed - 1) };
    case "purchased":
      return { ...ledger, purchasedRemaining: ledger.purchasedRemaining + 1 };
    case "overage":
      return { ...ledger, overageUsed: Math.max(0, ledger.overageUsed - 1) };
  }
}

/** Cuántos saves quedan antes de tocar overage. `null` = ilimitado. */
export function savesRemaining(ledger: SavesLedger): number | null {
  const included = PLANS[ledger.plan].contentSaves;
  if (included === null) return null;
  return Math.max(0, included - ledger.includedUsed) + ledger.purchasedRemaining;
}

// ───────────────────────────────────────────────────────────────────────────
// Blitz swipes — PRD §16.2
// ───────────────────────────────────────────────────────────────────────────

/**
 * Límite diario de swipes de Blitz. **`null` = sin límite.**
 *
 * ## De dónde sale, y por qué es `null` y no un número grande
 *
 * El PRD no tenía el número: §2.4 lo listaba entre lo desconocido (*"límites
 * exactos de swipes diarios por plan"*). El dueño del producto lo decidió el
 * 2026-09-23 y quedó escrito en PRD §2.4:
 *
 *   *"Límite diario de swipes: sin límite por ahora. El swipe se cuenta pero no
 *    se limita. Es provisorio y se cambia por configuración; no es un número
 *    del producto original."*
 *
 * Por eso esto es `null` —la misma convención de {@link PLANS}, donde `null`
 * significa **ilimitado** y no "sin definir"— y no `Number.MAX_SAFE_INTEGER` ni
 * `999`. Un número grande se lee como un límite que alguien eligió; dentro de un
 * año nadie sabría si `999` era una decisión o un parche. `null` dice
 * exactamente lo que se decidió.
 *
 * **Se cuenta igual.** El contador `quota_ledgers.daily_swipes_used` sube con
 * cada aceptación aunque no corte nada: el día que haya un número, el dato para
 * calibrarlo ya existe, y cambiar este valor alcanza para que empiece a cortar.
 *
 * Es un valor único y no uno por plan porque la decisión es una sola para todos.
 * Cuando sea por plan, esto pasa a ser un mapa indexado por `PlanId`, como
 * {@link PLANS}.
 */
export const BLITZ_DAILY_SWIPE_LIMIT: number | null = null;

export interface SwipesLedger {
  /** `null` = sin límite (PRD §2.4, 2026-09-23). Ver {@link BLITZ_DAILY_SWIPE_LIMIT}. */
  readonly dailyLimit: number | null;
  readonly used: number;
  readonly resetAt: Date;
}

/**
 * El ledger de swipes **vigente**, a partir de lo que quedó guardado.
 *
 * El reset diario (00:00 UTC, §16.2) se calcula en lectura, igual que el de
 * saves (decisión 7 del handoff): si el instante guardado ya pasó —o nunca se
 * guardó uno— el contador vale 0, haya corrido o no el barrido de
 * `quota-reset`. El `resetAt` que devuelve es siempre el **próximo** 00:00 UTC,
 * que es el que hay que escribir junto con el contador nuevo.
 */
export function currentSwipesLedger(params: {
  readonly storedUsed: number;
  readonly storedResetAt: Date | null;
  readonly now: Date;
  readonly dailyLimit: number | null;
}): SwipesLedger {
  const vigente =
    params.storedResetAt !== null &&
    params.storedResetAt.getTime() > params.now.getTime();
  return {
    dailyLimit: params.dailyLimit,
    used: vigente ? params.storedUsed : 0,
    resetAt: nextDailyResetUtc(params.now),
  };
}

/** Qué cuota cortó una aceptación. Es el `quota_type` del evento de §22 (PRD:3043). */
export type BlitzQuotaType = "saves" | "swipes";

/**
 * Aceptar una sugerencia en Blitz.
 *
 * **El gate de saves se evalúa ANTES que el de swipes.** Lo dice el PRD y no
 * es un detalle de orden: aceptar una sugerencia crea contenido, así que sin
 * saves la acción no puede completarse. Cobrar el swipe primero le gastaría al
 * usuario un swipe diario por una operación que igual va a fallar, y el swipe
 * no se recupera hasta mañana.
 *
 * ## El código de error y `details.quotaType`
 *
 * Los dos cortes salen como `blitz_quota_blocked` —el nombre del evento de
 * analítica de §22, cuyo prop `quota_type` distingue `swipes` de `saves`—, y
 * `details.quotaType` lleva esa distinción. **No** son los códigos del cable: el
 * PRD fija `429 content_quota_exceeded` (con `count`, `limit`, `resetAt`) para
 * los saves y `429 blitz_quota_exceeded` (con `resetAt`) para los swipes
 * (FR-050 *States*, ERR-R02/R03). La traducción la hace el borde
 * (`apps/api/src/routes/v1/blitz.ts`), que sin `quotaType` no tendría cómo
 * elegir entre los dos: el `resetAt` solo no los distingue.
 *
 * Devuelve los dos ledgers actualizados y el bucket del que salió el save.
 */
export function acceptBlitzSuggestion(
  saves: SavesLedger,
  swipes: SwipesLedger,
): { saves: SavesLedger; swipes: SwipesLedger; bucket: SaveBucket } {
  // 1. Saves primero.
  let consumption: SaveConsumption;
  try {
    consumption = consumeSave(saves);
  } catch (e) {
    if (e instanceof DomainError && e.code === "content_quota_exceeded") {
      throw new DomainError(
        "blitz_quota_blocked",
        "You're out of content saves, so Blitz can't save this one.",
        {
          quotaType: "saves" satisfies BlitzQuotaType,
          resetAt: saves.resetAt.toISOString(),
          // ERR-R03 pide `count` y `limit`. `consumeSave` sólo lanza cuando el
          // plan tiene cupo finito, así que `limit` nunca es `null` acá; el `?? 0`
          // es para el compilador.
          count: saves.includedUsed,
          limit: PLANS[saves.plan].contentSaves ?? 0,
        },
      );
    }
    throw e;
  }

  // 2. Recién ahora, el swipe. `null` = sin límite: se cuenta y no se corta.
  if (swipes.dailyLimit !== null && swipes.used >= swipes.dailyLimit) {
    throw new DomainError(
      "blitz_quota_blocked",
      "You've used all your Blitz swipes for today.",
      {
        quotaType: "swipes" satisfies BlitzQuotaType,
        resetAt: swipes.resetAt.toISOString(),
      },
    );
  }

  return {
    saves: consumption.ledger,
    swipes: { ...swipes, used: swipes.used + 1 },
    bucket: consumption.bucket,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// AI Studio credits — PRD §16.2
// ───────────────────────────────────────────────────────────────────────────

export interface CreditsLedger {
  readonly remaining: number;
  readonly resetAt: Date;
}

/**
 * Reserva créditos ANTES del trabajo costoso.
 *
 * El PRD describe el comportamiento del original: *"reserves
 * content_angle_generation allowance before model generation"*, y libera si
 * falla. Reservar después de generar permite que N peticiones simultáneas
 * pasen todas el chequeo con el mismo saldo.
 */
export function reserveCredits(
  ledger: CreditsLedger,
  operation: AiStudioOperation,
  units = 1,
): CreditsLedger {
  const cost = AI_STUDIO_COST[operation] * units;
  if (ledger.remaining < cost) {
    throw new DomainError(
      "content_quota_exceeded",
      `This needs ${cost} AI Studio credits and you have ${ledger.remaining}.`,
      { resetAt: ledger.resetAt.toISOString(), required: cost },
    );
  }
  return { ...ledger, remaining: ledger.remaining - cost };
}

/** Libera una reserva cuando la generación falla. */
export function releaseCredits(
  ledger: CreditsLedger,
  operation: AiStudioOperation,
  units = 1,
): CreditsLedger {
  return { ...ledger, remaining: ledger.remaining + AI_STUDIO_COST[operation] * units };
}

// ───────────────────────────────────────────────────────────────────────────
// Trial allowance — PRD §16.2 y §16.7
// ───────────────────────────────────────────────────────────────────────────

export interface TrialLedger {
  /** De por vida, por CUENTA. Se comparte entre workspaces personales. */
  readonly lifetimeLimit: number;
  readonly used: number;
}

/**
 * Consume del allowance de trial.
 *
 * Su error va **sin `resetAt`**: no hay ninguno. El PRD lo especifica así, y
 * un `resetAt` inventado acá le diría al usuario que espere a una fecha en la
 * que no va a pasar nada.
 */
export function consumeTrial(ledger: TrialLedger): TrialLedger {
  if (ledger.used >= ledger.lifetimeLimit) {
    throw new DomainError(
      "content_quota_exceeded",
      "You've used your full trial allowance. Upgrade to keep creating.",
      { trial: true },
    );
  }
  return { ...ledger, used: ledger.used + 1 };
}

/**
 * ¿La cuota de contenido de este workspace es el **trial allowance**?
 *
 * Hoy, sólo en el plan Free. `PLANS.free.contentSaves` es `0` porque §16.1 dice
 * *"Limited content"* sin número, y la cabecera de ese plan en `plans.ts` lo
 * deja escrito: *"No se inventa: se usa el trial allowance de por vida"*. Un
 * Free no tiene cupo mensual; tiene la asignación de por vida de §16.2/§16.7.
 *
 * **Lo que esto no decide:** si un plan pago en `trialing` también está acotado
 * por el trial allowance. PRD §2.4 dice que el primer workspace nace Free +
 * `trialing` y que por eso *"le aplican las restricciones de trial de §16.7"*,
 * pero no dice nada de un Starter en prueba. Extenderlo a `trialing` sin plan
 * Free sería inventar un límite, así que no se hace; queda como pregunta
 * abierta en el reporte de la tarea.
 */
export function trialAllowanceGoverns(plan: PlanId): boolean {
  return plan === "free";
}

/**
 * El tope del trial allowance. **`null` = desconocido**, no ilimitado.
 *
 * Es el mismo hueco que {@link UNKNOWN_LIMITS}.`freeContentSaves`: §16.1 no da
 * el número. Mientras sea `null`, quien cobre contenido a un workspace cuyo
 * cupo es el trial **no puede comprobar el límite** y tiene que responder el
 * `503 service_unavailable` de §9.6 / ERR-R06 —*"esto no significa cuota
 * agotada"*—, no un `429` que diría que se agotó algo que nadie midió, ni un
 * `202` que regalaría el driver de costo #1 del producto.
 */
export const TRIAL_CONTENT_ALLOWANCE: number | null = UNKNOWN_LIMITS.freeContentSaves;
