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
import { AI_STUDIO_COST, PLANS, type AiStudioOperation, type PlanId } from "./plans.js";

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

export interface SwipesLedger {
  readonly dailyLimit: number;
  readonly used: number;
  readonly resetAt: Date;
}

/**
 * Aceptar una sugerencia en Blitz.
 *
 * **El gate de saves se evalúa ANTES que el de swipes.** Lo dice el PRD y no
 * es un detalle de orden: aceptar una sugerencia crea contenido, así que sin
 * saves la acción no puede completarse. Cobrar el swipe primero le gastaría al
 * usuario un swipe diario por una operación que igual va a fallar, y el swipe
 * no se recupera hasta mañana.
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
      // El PRD le da código propio a este caso: el usuario está en Blitz, no
      // en el editor, y el mensaje tiene que explicar por qué se bloqueó el
      // deck entero y no sólo esta tarjeta.
      throw new DomainError(
        "blitz_quota_blocked",
        "You're out of content saves, so Blitz can't save this one.",
        { resetAt: saves.resetAt.toISOString() },
      );
    }
    throw e;
  }

  // 2. Recién ahora, el swipe.
  if (swipes.used >= swipes.dailyLimit) {
    throw new DomainError(
      "blitz_quota_blocked",
      "You've used all your Blitz swipes for today.",
      { resetAt: swipes.resetAt.toISOString() },
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
