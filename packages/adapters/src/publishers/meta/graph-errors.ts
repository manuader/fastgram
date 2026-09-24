/**
 * Traducción de errores de la Graph API de Meta (Instagram, Threads, Facebook
 * Pages) a lo neutral del puerto — `P3-PUB-006`, §10 regla 6.
 *
 * Fuentes, consultadas el 2026-09-24:
 *  - Forma del error y códigos generales (1, 2, 4, 10, 17, 190, 200-299, 341,
 *    368, 506, subcódigos 458…467):
 *    https://developers.facebook.com/docs/graph-api/guides/error-handling
 *  - Códigos de publicación de Instagram (subcódigos 2207xxx):
 *    https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes
 *
 * Forma documentada:
 *
 *   { "error": { "message": "...", "type": "OAuthException", "code": 190,
 *                "error_subcode": 460, "error_user_title": "...",
 *                "error_user_msg": "...", "fbtrace_id": "..." } }
 *
 * **Nada del cuerpo sale hacia afuera**: el `message` de Meta va a `cause`
 * (para el log del worker, que no lo serializa) y el mensaje del resultado es
 * una constante de este archivo.
 */
import { PortError, type PublishStatus } from "@fastgram/ports";

import { failed } from "../shared/base.js";
import {
  retryAfterOf,
  serverError,
  transportError,
  type CallOptions,
  type HttpResult,
} from "../shared/http.js";

export interface GraphError {
  readonly code: number | undefined;
  readonly subcode: number | undefined;
}

export function graphErrorOf(json: unknown): GraphError | null {
  if (typeof json !== "object" || json === null) return null;
  const error = (json as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return { code: num(record["code"]), subcode: num(record["error_subcode"]) };
}

export type GraphOutcome =
  | { readonly kind: "throw"; readonly error: PortError }
  | { readonly kind: "fail"; readonly status: PublishStatus };

/** Subcódigos de sesión que exigen volver a conectar (error-handling). */
const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467, 492]);

/** Instagram: la media que la plataforma rechaza (error-codes de IG). */
const MEDIA_SUBCODES = new Set([
  2207004, // 36000 · imagen demasiado grande (8 MiB)
  2207005, // 36001 · formato de imagen no soportado
  2207009, // 36003 · relación de aspecto inválida
  2207023, // 100 · tipo de media desconocido
  2207026, // 352 · formato de video no soportado
  2207028, // 100 · el carrusel necesita de 2 a 10
]);

/** Instagram: transitorios que la doc manda reintentar. */
const RETRY_SUBCODES = new Set([
  2207001, // -1 · error del servidor: «Try again»
  2207003, // -2 · tardó demasiado en bajar la media
  2207008, // 24 · el contenedor venció: se crea otro
  2207020, // -2 · la media venció: se crea otro contenedor
  2207032, // -1 · «please try to re-create media»
]);

/**
 * Clasifica una respuesta **no 2xx** de la Graph API.
 *
 * `source` y `phase` deciden si un transitorio es reintentable (`prepare`) o
 * entrega incierta (`deliver`) — ver `shared/http.ts`.
 */
export function classifyGraphError(
  result: HttpResult,
  options: Pick<CallOptions, "source" | "phase">,
): GraphOutcome {
  const err = graphErrorOf(result.json);
  const cause = { status: result.status, code: err?.code, subcode: err?.subcode };
  const code = err?.code;
  const subcode = err?.subcode;

  // Sesión caída → AWAITING_RECONNECT (FR-060), no FAILED.
  if (code === 190 || (subcode !== undefined && AUTH_SUBCODES.has(subcode))) {
    return {
      kind: "throw",
      error: new PortError("unauthorized", "The account needs to be reconnected.", {
        source: options.source,
        cause,
      }),
    };
  }

  // IG · 9/2207042 «You reached maximum number of posts»: el tope de 24 h.
  if (subcode === 2207042) {
    return {
      kind: "fail",
      status: failed(
        "post_limit_exceeded",
        "The account reached the platform's daily posting limit.",
      ),
    };
  }

  if (subcode !== undefined && MEDIA_SUBCODES.has(subcode)) {
    return {
      kind: "fail",
      status: failed("unsupported_media", "The platform rejected this media file."),
    };
  }

  // IG · 4/2207051 «We restrict certain activity to protect our community»:
  // lleva el código 4 de «demasiadas llamadas», pero la doc manda revisar por
  // spam, no reintentar. Va antes de la rama de abajo.
  if (subcode === 2207051) {
    return {
      kind: "fail",
      status: failed("unknown", "The platform restricted this activity on the account."),
    };
  }

  // 4, 17, 32, 341, 613: demasiadas llamadas → «wait and retry». Es un 4xx:
  // la plataforma no procesó el pedido, así que es seguro en las dos fases.
  if (code === 4 || code === 17 || code === 32 || code === 341 || code === 613) {
    return {
      kind: "throw",
      // `prepare` a propósito aunque sea el paso que publica: un 4xx es un
      // rechazo, no una entrega a medias.
      error: transportError(
        "rate_limited",
        "The platform asked to slow down.",
        { source: options.source, phase: "prepare" },
        cause,
        retryAfterOf(result.headers),
      ),
    };
  }

  // 10 y 200-299: permisos de la API → ERR-D03 «Reconnect to upgrade permissions».
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) {
    return {
      kind: "fail",
      status: failed(
        "permissions_missing",
        "The connected account is missing a permission. Reconnect it.",
      ),
    };
  }

  if (
    (subcode !== undefined && RETRY_SUBCODES.has(subcode)) ||
    code === 1 ||
    code === 2
  ) {
    return { kind: "throw", error: serverError(result, options) };
  }

  if (result.status >= 500) return { kind: "throw", error: serverError(result, options) };

  if (result.status === 429) {
    return {
      kind: "throw",
      error: transportError(
        "rate_limited",
        "The platform asked to slow down.",
        { source: options.source, phase: "prepare" },
        cause,
        retryAfterOf(result.headers),
      ),
    };
  }

  // IG 25/2207050 cuenta restringida, 4/2207051 actividad restringida, 368
  // bloqueo temporal, 506 publicación duplicada, 36004/2207010 caption larga,
  // 100 parámetro inválido: clasificados como rechazo definitivo pero sin
  // motivo propio en el puerto. `unknown` escala a DP-006.
  return {
    kind: "fail",
    status: failed("unknown", "The platform rejected this post."),
  };
}
