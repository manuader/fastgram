/**
 * Traducción de errores a HTTP — PRD §9.2, §9.3, §19, NFR-022.
 *
 * Único lugar del sistema donde un error se convierte en un status y un cuerpo.
 * Tenerlo centralizado es lo que hace verificable la promesa del PRD de
 * "códigos de error estables y neutrales": si cada ruta armara su propio 500,
 * la promesa no sería auditable.
 */
import { DomainError, isDomainError } from "@fastgram/core";
import { isPortError, type PortErrorCode } from "@fastgram/ports";
import type { DomainErrorCode } from "@fastgram/core";

/** Envelope de error del PRD §9.3. `details` es opcional. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  content_quota_exceeded: 402,
  blitz_quota_blocked: 402,
  invalid_state: 409,
  out_of_range: 400,
  // El PRD §9.2 es explícito: acceso cruzado devuelve 404, nunca 403, para no
  // filtrar existencia. El 403 le confirma a quien sondea que el id existe.
  not_found: 404,
  conflict: 409,
};

const PORT_STATUS: Record<PortErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  unauthorized: 401,
  bad_request: 400,
  conflict: 409,
  rate_limited: 429,
  provider_unavailable: 503,
  timeout: 504,
  quota_exceeded: 402,
  // Un proveedor devolvió algo que no encaja en el contrato. Es un fallo
  // nuestro de integración, no del cliente: 502, no 400.
  provider_contract_violation: 502,
};

export interface TranslatedError {
  status: number;
  body: ErrorEnvelope;
  /** Headers obligatorios del PRD para ciertos casos (429, 401). */
  headers: Record<string, string>;
  /** Qué mandar al log. Nunca se serializa hacia el cliente. */
  logContext: Record<string, unknown>;
}

export function translateError(e: unknown): TranslatedError {
  if (isDomainError(e)) {
    return {
      status: DOMAIN_STATUS[e.code],
      body: { error: e.toPublic() },
      headers: {},
      logContext: { kind: "domain", code: e.code, details: e.details },
    };
  }

  if (isPortError(e)) {
    const headers: Record<string, string> = {};
    if (e.retryAfterSeconds !== undefined) {
      headers["Retry-After"] = String(e.retryAfterSeconds);
    }
    if (e.code === "unauthorized") {
      // PRD §9.1: todos los 401 llevan este header.
      headers["WWW-Authenticate"] = 'Bearer realm="api"';
    }
    return {
      status: PORT_STATUS[e.code],
      body: { error: e.toPublic() },
      headers,
      // `source` identifica el proveedor. Va al log, jamás al cuerpo: si
      // "Storage/r2" saliera hacia afuera, cambiar de proveedor sería un
      // breaking change para todo integrador.
      logContext: { kind: "port", code: e.code, source: e.source, cause: e.cause },
    };
  }

  // Todo lo demás es un bug nuestro. El cliente no se entera de qué fue:
  // un stack trace en el cuerpo es una filtración, no un diagnóstico.
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "Something went wrong" } },
    headers: {},
    logContext: { kind: "unexpected", error: e },
  };
}

/** 401 con el header que exige el PRD §9.1. */
export function unauthorized(message: string): TranslatedError {
  return {
    status: 401,
    body: { error: { code: "unauthorized", message } },
    headers: { "WWW-Authenticate": 'Bearer realm="api"' },
    logContext: { kind: "auth" },
  };
}

export { DomainError };
