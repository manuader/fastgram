/**
 * Errores de dominio.
 *
 * Distinción que importa: `PortError` (en @fastgram/ports) es "algo de afuera
 * falló". `DomainError` es "la operación viola una regla del producto". La
 * primera casi siempre se reintenta; la segunda nunca, porque reintentar no
 * cambia que el usuario no tiene cuota.
 *
 * Los códigos salen del PRD. No se inventan: son parte del contrato público.
 */
export const DOMAIN_ERROR_CODES = [
  /** PRD: cuota de content saves agotada. */
  "content_quota_exceeded",
  /** PRD: el Blitz se bloquea cuando no quedan saves. */
  "blitz_quota_blocked",
  /** Regla de negocio violada sin código propio en el PRD. */
  "invalid_state",
  /** Un valor fuera del rango que fija el PRD (caps, rangos, enums). */
  "out_of_range",
  /** El recurso no existe **o** es de otro workspace. Ver nota abajo. */
  "not_found",
  /** Reintento de una operación ya aplicada con otro cuerpo. */
  "conflict",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  override readonly name = "DomainError";
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    /** Contexto para el log. Nunca se serializa hacia el cliente. */
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }

  toPublic(): { code: DomainErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

/**
 * Acceso a un recurso de otro workspace.
 *
 * Devuelve `not_found`, **no** `forbidden`, y es deliberado: el PRD lo exige
 * para no filtrar la existencia del recurso. Un 403 le confirma a quien sondea
 * que el id existe; un 404 no le dice nada. Existe como función propia para
 * que el intento cruzado quede explícito en el código y en el log, aunque
 * hacia afuera sea indistinguible de un id inexistente.
 */
export function crossTenantAsNotFound(
  resource: string,
  id: string,
  attemptedBy: string,
): DomainError {
  return new DomainError("not_found", `${resource} not found`, {
    resource,
    id,
    attemptedBy,
    crossTenant: true,
  });
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}
