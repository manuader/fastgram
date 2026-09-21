/**
 * Idempotencia de operaciones facturables — PRD `DATA-027`, §9.3 y `NFR-004`.
 *
 * El contrato del PRD tiene tres ramas y las tres importan:
 *
 *   "Misma key + mismo body = replay de la respuesta original;
 *    misma key + body distinto = `409 conflict`;
 *    una petición que falla **libera** la key."
 *
 * La segunda rama es la que suele faltar. Sin ella, un cliente que reusa una
 * key por error —el mismo UUID para dos peticiones distintas, que es lo que
 * pasa cuando alguien la genera por sesión en vez de por petición— recibe en
 * silencio la respuesta de la **otra** operación. Es peor que un error: el
 * cliente cree que su segunda petición salió bien y nunca la reintenta.
 *
 * **Sobre la tercera rama y las transacciones.** No hay función de "liberar":
 * la reserva se escribe **dentro de la misma transacción** que hace el trabajo
 * (IMPL §2.3), así que una petición que falla aborta la transacción y la
 * reserva desaparece con ella. Liberarla con una escritura compensatoria sería
 * volver a abrir la ventana que el encolado transaccional cierra. El estado
 * `released` de `DATA-027` existe para el caso en que el adaptador decida
 * persistir la reserva fuera de la transacción; el dominio lo acepta como
 * "podés seguir" y no lo produce.
 */
import { DomainError } from "./errors.js";

export const IDEMPOTENCY_STATES = ["in_flight", "completed", "released"] as const;
export type IdempotencyState = (typeof IDEMPOTENCY_STATES)[number];

export interface IdempotencyRecord {
  readonly key: string;
  readonly companyId: string;
  /** Qué operación reservó la key. Ver la nota de `endpoint` más abajo. */
  readonly endpoint: string;
  /**
   * Huella del cuerpo de la petición. El dominio **no** la calcula: hashear
   * JSON sin canonicalizar da huellas distintas para cuerpos equivalentes, y
   * canonicalizar es trabajo del borde, donde está el esquema.
   */
  readonly requestHash: string;
  readonly responseSnapshot?: unknown | undefined;
  readonly state: IdempotencyState;
  readonly createdAt: Date;
}

export type IdempotencyDecision =
  /** No hay reserva previa utilizable: seguí, y persistí `record`. */
  | { readonly kind: "proceed"; readonly record: IdempotencyRecord }
  /** Ya se hizo. Devolvé esto y no toques nada más. */
  | { readonly kind: "replay"; readonly response: unknown };

export interface ReserveIdempotencyParams {
  readonly key: string;
  readonly companyId: string;
  readonly endpoint: string;
  readonly requestHash: string;
  readonly now: Date;
}

/**
 * Decide qué hacer con una `Idempotency-Key`.
 *
 * `existing` es lo que el repositorio encontró para `(companyId, key)`, o
 * `null`. El scope por `companyId` es parte de `DATA-027` y no es un detalle:
 * sin él, dos workspaces que eligen la misma key —cosa perfectamente posible,
 * son opacas— se pisarían las respuestas entre sí.
 */
export function reserveIdempotency(
  existing: IdempotencyRecord | null,
  params: ReserveIdempotencyParams,
): IdempotencyDecision {
  const fresh: IdempotencyRecord = {
    key: params.key,
    companyId: params.companyId,
    endpoint: params.endpoint,
    requestHash: params.requestHash,
    state: "in_flight",
    createdAt: params.now,
  };

  if (existing === null) return { kind: "proceed", record: fresh };

  if (existing.companyId !== params.companyId) {
    // Defensa en profundidad: si el repositorio se olvidó el scope, acá no
    // se filtra la respuesta de otro workspace.
    throw new DomainError("conflict", "That idempotency key is already in use.", {
      key: params.key,
    });
  }

  // Misma key en otro endpoint es el mismo error de cliente que un body
  // distinto, y por el mismo motivo: la key identifica **una** operación.
  if (existing.endpoint !== params.endpoint) {
    throw new DomainError(
      "conflict",
      "That idempotency key was already used for a different operation.",
      { key: params.key, endpoint: params.endpoint, usedFor: existing.endpoint },
    );
  }

  if (existing.requestHash !== params.requestHash) {
    throw new DomainError(
      "conflict",
      "That idempotency key was already used with a different request body.",
      { key: params.key, endpoint: params.endpoint },
    );
  }

  switch (existing.state) {
    case "completed":
      return { kind: "replay", response: existing.responseSnapshot };
    case "released":
      // El intento anterior falló y soltó la key. Reintentar es lo correcto.
      return { kind: "proceed", record: fresh };
    case "in_flight":
      // Dos peticiones con la misma key a la vez. El PRD no especifica esta
      // rama; se rechaza en vez de esperar porque el dominio no tiene reloj
      // para un timeout y bloquear una petición HTTP contra otra en curso
      // convierte un pico de reintentos en una caída. Queda como decisión
      // abierta: ver el informe.
      throw new DomainError(
        "conflict",
        "That request is still being processed. Retry in a moment.",
        { key: params.key, endpoint: params.endpoint, inFlight: true },
      );
  }
}

/** Cierra la reserva con la respuesta que hay que replicar en el próximo intento. */
export function completeIdempotency(
  record: IdempotencyRecord,
  response: unknown,
): IdempotencyRecord {
  return { ...record, state: "completed", responseSnapshot: response };
}
