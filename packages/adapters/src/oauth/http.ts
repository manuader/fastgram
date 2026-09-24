/**
 * El `fetch` de los clientes OAuth, con corte por tiempo y traducción de
 * errores a `PortError` — `PU-PUB-002`.
 *
 * ## Qué va al `cause` y qué no
 *
 * Sólo el status y los **códigos** de error que devuelve la plataforma
 * (`error`, `error.code`, `error.type`). Nunca el cuerpo entero ni la URL:
 * los endpoints de Meta llevan el `client_secret` y el `access_token` en la
 * query (así están documentados), y un cuerpo de éxito trae los tokens.
 */
import { PortError, type PortErrorCode } from "@fastgram/ports";

export type OAuthFetch = (
  input: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface OAuthHttpConfig {
  readonly fetch?: OAuthFetch;
  /** Por llamada. Default 8 s: el callback encadena hasta cuatro. */
  readonly timeoutMs?: number;
}

export const DEFAULT_OAUTH_TIMEOUT_MS = 8_000;

/** Por defecto se resuelve `globalThis.fetch` en cada llamada (los tests lo reemplazan). */
const globalFetch: OAuthFetch = (input, init) => globalThis.fetch(input, init);

export interface OAuthErrorInfo {
  readonly status: number;
  /** `error` (OAuth 2.0), o `error.code`/`error.type` (Graph, TikTok). */
  readonly codes: readonly string[];
}

/** Extrae los códigos de error de un cuerpo, sin copiar nada más. */
export function errorCodesOf(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const e = (body as Record<string, unknown>)["error"];
  if (typeof e === "string") return [e];
  if (typeof e === "object" && e !== null) {
    const o = e as Record<string, unknown>;
    const out: string[] = [];
    for (const k of ["code", "type", "error_subcode"]) {
      const v = o[k];
      if (typeof v === "string" || typeof v === "number") out.push(String(v));
    }
    return out;
  }
  return [];
}

function codeFor(info: OAuthErrorInfo): PortErrorCode {
  const { status, codes } = info;
  // `invalid_grant` (RFC 6749 §5.2): code vencido o ya usado, refresh token
  // revocado. `OAuthException`/190 es el token inválido de la Graph API.
  if (codes.includes("invalid_grant") || codes.includes("190")) return "unauthorized";
  if (codes.includes("access_token_invalid") || codes.includes("invalid_client")) {
    return "unauthorized";
  }
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "bad_request";
}

export class OAuthHttp {
  readonly #fetch: OAuthFetch;
  readonly #timeoutMs: number;
  readonly #source: string;

  constructor(source: string, config: OAuthHttpConfig = {}) {
    this.#fetch = config.fetch ?? globalFetch;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
    this.#source = source;
  }

  /** `application/x-www-form-urlencoded`, como piden todos los token endpoints. */
  form(
    url: string,
    fields: Readonly<Record<string, string>>,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    return this.call(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  }

  get(
    url: string,
    query: Readonly<Record<string, string>> = {},
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const q = new URLSearchParams(query).toString();
    return this.call(q === "" ? url : `${url}?${q}`, { method: "GET", headers });
  }

  async call(
    url: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: { Accept: "application/json", ...init.headers },
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      // Sin `cause`: el error de `fetch` puede citar la URL, con secretos en la query.
      if (controller.signal.aborted) {
        throw new PortError("timeout", "The platform did not answer in time", {
          source: this.#source,
        });
      }
      throw new PortError("provider_unavailable", "Could not reach the platform", {
        source: this.#source,
      });
    }
    try {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        const info: OAuthErrorInfo = {
          status: response.status,
          codes: errorCodesOf(body),
        };
        throw new PortError(codeFor(info), "The platform rejected the request", {
          source: this.#source,
          cause: info,
        });
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new PortError(
          "provider_contract_violation",
          "The platform answered with something that is not a JSON object",
          { source: this.#source, cause: { status: response.status } },
        );
      }
      return body as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Un 200 que igual trae un error (TikTok lo hace). */
  rejectIfError(body: Record<string, unknown>, okCodes: readonly string[] = []): void {
    const codes = errorCodesOf(body).filter((c) => !okCodes.includes(c));
    if (codes.length === 0) return;
    const info: OAuthErrorInfo = { status: 200, codes };
    throw new PortError(codeFor(info), "The platform rejected the request", {
      source: this.#source,
      cause: info,
    });
  }

  contract(why: string): PortError {
    return new PortError(
      "provider_contract_violation",
      "The platform answered with an unexpected shape",
      { source: this.#source, cause: why },
    );
  }
}

/* ------------------------------------------------------------------------ *
 * Lectura defensiva de las respuestas
 * ------------------------------------------------------------------------ */

export function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (typeof v === "string" && v.length > 0) return v;
  // Threads e Instagram devuelven `user_id` como número en algunos ejemplos.
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

export function num(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

export function obj(o: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof o !== "object" || o === null) return undefined;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function expiresAtFrom(now: Date, seconds: number | undefined): Date | null {
  return seconds === undefined ? null : new Date(now.getTime() + seconds * 1000);
}

/** Scopes separados por coma o espacio (cada plataforma usa uno). */
export function splitScopes(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
