/**
 * Errores de puerto — PRD §10, NFR-022, IMPL §4.
 *
 * Regla: ningún error crudo de un proveedor sale hacia afuera. El adaptador lo
 * traduce a uno de estos códigos. La razón no es estética: el PRD promete
 * "códigos de error estables y neutrales" (NFR-022) y el contrato público
 * devuelve `{"error":{"code":..,"message":..}}` (PRD §11). Si un código de
 * Stripe o de TikTok se filtrara al contrato, cambiar de proveedor sería un
 * breaking change para todo integrador.
 */

/** Códigos neutrales. Los literales salen del PRD; no se inventan. */
export const PORT_ERROR_CODES = [
  "not_found",
  "forbidden",
  "unauthorized",
  "bad_request",
  "conflict",
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "quota_exceeded",
  /** El proveedor respondió, pero con algo que no encaja en el contrato. */
  "provider_contract_violation",
] as const;

export type PortErrorCode = (typeof PORT_ERROR_CODES)[number];

export interface PortErrorOptions {
  /** Qué puerto y adaptador lo produjo. Ej: "Storage/r2", "Judgment/typesafe". */
  readonly source: string;
  /**
   * El error original. Se guarda para el log, NUNCA se serializa hacia afuera.
   * Es la pieza que permite diagnosticar sin filtrar el proveedor al cliente.
   */
  readonly cause?: unknown;
  /** Si el proveedor dijo cuándo reintentar. Segundos. */
  readonly retryAfterSeconds?: number;
}

export class PortError extends Error {
  override readonly name = "PortError";
  readonly code: PortErrorCode;
  readonly source: string;
  readonly retryAfterSeconds?: number;

  constructor(code: PortErrorCode, message: string, options: PortErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.source = options.source;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }

  /**
   * Lo único que puede cruzar la frontera hacia el cliente.
   * No incluye `cause` ni `source` a propósito.
   */
  toPublic(): { code: PortErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }

  /** Reintentar sólo tiene sentido para estos. Lo usa la política de la cola. */
  get isRetryable(): boolean {
    return (
      this.code === "rate_limited" ||
      this.code === "provider_unavailable" ||
      this.code === "timeout"
    );
  }
}

export function isPortError(e: unknown): e is PortError {
  return e instanceof PortError;
}
