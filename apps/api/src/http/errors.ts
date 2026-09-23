/**
 * Traducción de errores a HTTP — PRD §9.2, §9.3, §19, NFR-022.
 *
 * Único lugar del sistema donde un error se convierte en un status y un cuerpo.
 * Tenerlo centralizado es lo que hace verificable la promesa del PRD de
 * "códigos de error estables y neutrales": si cada ruta armara su propio 500,
 * la promesa no sería auditable.
 */
import { DomainError, isDomainError } from "@fastgram/core";
import { contentQuotaExceededDetailsSchema, type ErrorCode } from "@fastgram/contracts";
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
  // ERR-R03 (§19.8): `429 content_quota_exceeded`. **No es 402.** El 402 del
  // PRD es de créditos de AI Studio (`payment_required`, FR-080/ERR-R08), que
  // `support/quota.ts` arma como `ApiRejection` y no pasa por acá. Hasta el
  // 2026-09-23 esto decía 402 y `POST /content` respondía 402 mientras
  // `POST /blitz` —que traduce por su cuenta— respondía 429 para la misma cuota.
  content_quota_exceeded: 429,
  // Normalmente no llega acá: `toBlitzRejection` (`routes/v1/blitz.ts`) lo
  // traduce a `429 content_quota_exceeded` o `429 blitz_quota_exceeded`.
  // `blitz_quota_blocked` no es un código del contrato; si alguna vez sale, es
  // un corte de cuota que no pasó por esa traducción, y sigue siendo una cuota.
  blitz_quota_blocked: 429,
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

/**
 * Un rechazo con un código del contrato que el dominio no tiene.
 *
 * ## Por qué hizo falta
 *
 * `errorCodeSchema` tiene 30 códigos; `DomainErrorCode` tiene 6. Los de
 * `FR-051` y `FR-060` —`stale_revision`, `content_has_linked_posts`,
 * `connection_ambiguous`— viven sólo en el contrato, y `DomainError.toPublic()`
 * emite `code` + `message` y **descarta `details`**. Una ruta que quisiera
 * responder `409 stale_revision` con `details.connections` no tenía cómo.
 *
 * Tres agentes que escribieron rutas distintas, sin hablarse, inventaron cada
 * uno su propia clase centinela local para esto. Cuando tres implementaciones
 * independientes llegan al mismo parche, lo que falta es la abstracción.
 *
 * ## `publicDetails` es un campo aparte, y tiene que serlo
 *
 * `DomainError.details` **no se serializa nunca** hacia afuera, y eso no es un
 * descuido: ahí viajan cosas como `attemptedBy` y `crossTenant`, que son
 * precisamente lo que §9.2 no quiere que salga. Reutilizar ese campo para
 * detalles públicos convertiría una decisión de seguridad en un accidente de
 * nombre. Por eso lo público entra por su propia puerta: lo que se pone acá se
 * publica, y se lee así en el sitio donde se escribe.
 */
export class ApiRejection extends Error {
  override readonly name = "ApiRejection";
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    /** Se publica. Ver arriba: nada que no deba salir del sistema. */
    readonly publicDetails?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function isApiRejection(e: unknown): e is ApiRejection {
  return e instanceof ApiRejection;
}

/**
 * Los códigos de dominio cuyos `details` **son parte del contrato público**, y
 * el schema del contrato que los valida.
 *
 * La regla general es la contraria y no se toca: `DomainError.details` no sale
 * nunca, porque ahí viajan `attemptedBy` y `crossTenant`, que son exactamente
 * lo que §9.2 no quiere publicar. Pero ERR-R03 nombra `count`, `limit` y
 * `resetAt` junto al copy del error: son contrato, no diagnóstico. Sin
 * `resetAt` la UI sólo puede decir "no se puede" en vez de "vuelve el 15".
 *
 * ## Se valida contra el schema del contrato, y no se convierte nada
 *
 * Lo que sale es la salida de `schema.safeParse(details)`: los campos que el
 * contrato no nombra (`plan`, `trial`) **se descartan** —van al log—, y si
 * `details` no cumple el schema **no se publica ningún `details`**. No se
 * "arregla" en el borde (p. ej. un `resetAt` en ISO pasado a ms): un borde que
 * convierte esconde que `core` emite otra cosa, y el día que otro llamador lea
 * `DomainError.details` directo, recibe el formato viejo. Así, un `resetAt` ISO
 * en `core` se ve como un 429 sin `details` en el test de este archivo y en el
 * de integración de `POST /content`.
 *
 * `blitz_quota_blocked` no está: su traducción (código, copy y `details`) vive
 * en `toBlitzRejection` (`routes/v1/blitz.ts`), que es la única ruta que lo
 * lanza. Publicar sus `details` crudos acá publicaría `quotaType` bajo un
 * código que el contrato no tiene.
 *
 * La lista es **explícita y corta** a propósito. Un "publicá los details salvo
 * en `not_found`" invertiría el default, y el día que alguien agregue un código
 * nuevo con información sensible adentro, se publicaría sin que nadie lo
 * decidiera. Acá agregar uno es un acto deliberado, y viene con su schema.
 */
const PUBLIC_DETAILS_SCHEMAS: Partial<
  Record<DomainErrorCode, typeof contentQuotaExceededDetailsSchema>
> = {
  content_quota_exceeded: contentQuotaExceededDetailsSchema,
};

/**
 * Los `details` publicables de un `DomainError`, o `undefined`.
 *
 * `invalid` va al log: un `details` que el contrato rechaza es un bug de `core`
 * y tiene que verse en algún lado aunque el cliente no lo reciba.
 */
function publicDomainDetails(e: DomainError): {
  details?: Record<string, unknown>;
  invalid?: unknown;
} {
  const schema = PUBLIC_DETAILS_SCHEMAS[e.code];
  if (schema === undefined || e.details === undefined) return {};
  const parsed = schema.safeParse(e.details);
  if (!parsed.success) return { invalid: parsed.error.issues };
  return { details: { ...parsed.data } };
}

export function translateError(e: unknown): TranslatedError {
  if (isApiRejection(e)) {
    return {
      status: e.status,
      body: {
        error: {
          code: e.code,
          message: e.message,
          ...(e.publicDetails === undefined ? {} : { details: e.publicDetails }),
        },
      },
      headers: {},
      logContext: { kind: "rejection", code: e.code },
    };
  }

  if (isDomainError(e)) {
    const { details, invalid } = publicDomainDetails(e);
    return {
      status: DOMAIN_STATUS[e.code],
      body: {
        error: { ...e.toPublic(), ...(details === undefined ? {} : { details }) },
      },
      headers: {},
      // Al log van SIEMPRE, se publiquen o no.
      logContext: {
        kind: "domain",
        code: e.code,
        details: e.details,
        ...(invalid === undefined ? {} : { publicDetailsInvalid: invalid }),
      },
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
