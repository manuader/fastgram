/**
 * Activación de influencers — PRD §16.2, `FR-055`, `FR-080`, `FR-083`.
 *
 * El cap de 50 es sobre **activos**, y la distinción es de producto, no de
 * implementación: el plan Pro permite 2 000 personajes creados y el cap
 * técnico permite 50 activos a la vez. Son dos números que miden cosas
 * distintas —catálogo y capacidad de generación— y confundirlos rompe en los
 * dos sentidos:
 *
 *  - Contando los creados, un workspace Pro se bloquea con 49 activos y 2 000
 *    guardados. Le decimos "llegaste al límite" a alguien que tiene un solo
 *    influencer en Blitz.
 *  - No contando nada, Blitz tiene que resolver el muestreo sobre 2 000
 *    candidatos por sugerencia, que es el cuello que el cap existe para
 *    evitar.
 *
 * Desactivar libera slot inmediatamente: no hay borrado de por medio.
 */
import { DomainError } from "../errors.js";
import { assertCanActivateInfluencer } from "./caps.js";

export interface WorkspaceInfluencer {
  readonly id: string;
  readonly companyId: string;
  readonly isActive: boolean;
  /** El entrenamiento LoRA de `FR-080`: 15–20 min, 250 créditos. */
  readonly isTrained: boolean;
}

/**
 * Activa un influencer para Blitz.
 *
 * `activeCount` **no incluye** a éste; quien llama cuenta los ya activos en la
 * misma transacción en la que va a escribir. Si lo incluyera, el cap efectivo
 * sería 49.
 */
export function activateInfluencer(
  influencer: WorkspaceInfluencer,
  activeCount: number,
): WorkspaceInfluencer {
  if (influencer.isActive) return influencer;

  // Un influencer sin entrenar no puede producir una pieza. Activarlo lo
  // metería en el muestreo de `AI-002` para después caerse a contenido
  // regular en cada tirada: ocuparía un slot de los 50 sin dar nada.
  if (!influencer.isTrained) {
    throw new DomainError(
      "invalid_state",
      "Finish training this influencer before activating it.",
      { influencerId: influencer.id },
    );
  }

  assertCanActivateInfluencer(activeCount);
  return { ...influencer, isActive: true };
}

/** Desactivar libera slot en el acto. */
export function deactivateInfluencer(
  influencer: WorkspaceInfluencer,
): WorkspaceInfluencer {
  if (!influencer.isActive) return influencer;
  return { ...influencer, isActive: false };
}
