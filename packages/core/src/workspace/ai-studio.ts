/**
 * Arrancar una generación de AI Studio — PRD `NFR-025`, §9.5 #6, §16.2, `AI-005`.
 *
 * Dos límites distintos se aplican acá y conviene no confundirlos:
 *
 * | Límite | Qué mide | Cuándo se libera |
 * |---|---|---|
 * | 10 generaciones **en vuelo** | concurrencia contra la GPU | al terminar, bien o mal |
 * | créditos de AI Studio | consumo del plan | sólo si la generación **falla** |
 *
 * El orden importa y es éste: **primero el de concurrencia, después los
 * créditos**. Al revés, un workspace que ya está en el techo de 10 reserva
 * créditos, recibe el error de concurrencia y hay que devolvérselos con una
 * escritura compensatoria — que es exactamente el camino donde se pierden
 * créditos cuando algo falla en el medio. Rechazando primero lo barato, no
 * hay nada que compensar.
 *
 * El chequeo va **antes de encolar**, como dice el puerto `Queue`. Hacerlo en
 * el worker sería tarde: los jobs ya están en la cola y el límite dejaría de
 * ser un límite para pasar a ser una forma cara de fallar.
 */
import { DomainError } from "../errors.js";
import {
  releaseCredits,
  reserveCredits,
  type CreditsLedger,
} from "../quota/content-saves.js";
import { AI_STUDIO_COST, type AiStudioOperation } from "../quota/plans.js";
import { assertCanStartGeneration } from "./caps.js";

export interface StartGenerationInput {
  readonly operation: AiStudioOperation;
  /** Cuántas unidades. Un lote de 4 imágenes son 4 × 4 = 16 créditos. */
  readonly units?: number | undefined;
  /** Generaciones encoladas o corriendo ahora mismo en este workspace. */
  readonly inFlightCount: number;
  readonly credits: CreditsLedger;
}

export interface StartGenerationResult {
  readonly credits: CreditsLedger;
  /** Lo reservado. Es lo que hay que devolver si la generación falla. */
  readonly reservedCredits: number;
  readonly operation: AiStudioOperation;
  readonly units: number;
}

export function startAiStudioGeneration(
  input: StartGenerationInput,
): StartGenerationResult {
  const units = input.units ?? 1;
  if (!Number.isInteger(units) || units < 1) {
    throw new DomainError("out_of_range", "Ask for at least one generation.", {
      units,
    });
  }

  // 1. Concurrencia. Lo barato primero: rechazar acá no deja nada que deshacer.
  assertCanStartGeneration(input.inFlightCount);

  // 2. Créditos, reservados ANTES del trabajo costoso (§9.4: «reservas
  //    atómicas de cuota antes de trabajo costoso»). Reservar después permite
  //    que N peticiones simultáneas pasen todas con el mismo saldo.
  const credits = reserveCredits(input.credits, input.operation, units);

  return {
    credits,
    reservedCredits: AI_STUDIO_COST[input.operation] * units,
    operation: input.operation,
    units,
  };
}

/**
 * Devuelve la reserva cuando la generación **falla**.
 *
 * No cuando el usuario borra el resultado: ahí el trabajo ya se hizo y la GPU
 * ya se pagó. Es la misma distinción que en los content saves —borrar no
 * reembolsa— y por el mismo motivo: la cuota mide generación, no
 * almacenamiento.
 */
export function releaseAiStudioGeneration(
  credits: CreditsLedger,
  operation: AiStudioOperation,
  units = 1,
): CreditsLedger {
  return releaseCredits(credits, operation, units);
}
