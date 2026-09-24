/**
 * El HTTP mínimo que comparten los adaptadores de `ImageGen`/`VideoGen`
 * (`higgsfield/`, `fal/`) — `PU-MODEL-003`/`004`.
 *
 * Sin SDK a propósito: `@higgsfield/client` y `@fal-ai/client` serían
 * dependencias nuevas (no se tocan `package.json` en este sprint) y las dos
 * APIs son tres llamadas REST documentadas. Lo que sí se copia de los SDK es
 * la disciplina: timeout por llamada, nada de reintentar un `POST` de
 * generación, y la credencial sólo hacia el host que la emitió.
 */
import { PortError, type PortErrorCode } from "@fastgram/ports";

export type GenFetch = (
  input: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export const defaultGenFetch: GenFetch = (input, init) => fetch(input, init);

/** Lo que el proveedor contestó, ya leído. `json` es `null` si no era JSON. */
export interface GenHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly json: unknown;
  /** Primeros caracteres del cuerpo, **sólo** para el `cause` (va al log). */
  readonly text: string;
  readonly headers: Headers;
}

/** Cuánto del cuerpo del proveedor se guarda para diagnosticar. */
const CAUSE_BODY_CHARS = 300;

export async function genHttp(
  fetchFn: GenFetch,
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  options: { readonly timeoutMs: number; readonly source: string },
): Promise<GenHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchFn(url, { ...init, signal: controller.signal });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new PortError("timeout", "The generation provider did not answer in time", {
          source: options.source,
          cause,
        });
      }
      throw new PortError(
        "provider_unavailable",
        "Could not reach the generation provider",
        { source: options.source, cause },
      );
    }
    const text = await response.text().catch(() => "");
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      json,
      text: text.slice(0, CAUSE_BODY_CHARS),
      headers: response.headers,
    };
  } catch (error) {
    if (error instanceof PortError) throw error;
    if (controller.signal.aborted) {
      throw new PortError("timeout", "The generation provider did not answer in time", {
        source: options.source,
        cause: error,
      });
    }
    throw new PortError(
      "provider_unavailable",
      "Could not reach the generation provider",
      {
        source: options.source,
        cause: error,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

export function genError(
  code: PortErrorCode,
  message: string,
  source: string,
  res?: GenHttpResponse,
): PortError {
  return new PortError(code, message, {
    source,
    ...(res === undefined ? {} : { cause: `HTTP ${String(res.status)}: ${res.text}` }),
  });
}

export function malformed(source: string, why: string): PortError {
  return new PortError(
    "provider_contract_violation",
    "The generation provider answered something unexpected",
    { source, cause: why },
  );
}

/** `{base}/{path}` sin barras dobles. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Una URL que devolvió el proveedor (estado, resultado) **sólo** se sigue si
 * es del mismo origen que la base configurada: a esa URL va la credencial, y
 * una respuesta manipulada no puede mandarla a otro host.
 */
export function trustedProviderUrl(
  value: unknown,
  baseUrl: string,
  source: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw malformed(source, "missing provider url");
  }
  let url: URL;
  let base: URL;
  try {
    url = new URL(value);
    base = new URL(baseUrl);
  } catch {
    throw malformed(source, "unparseable provider url");
  }
  if (url.origin !== base.origin) {
    throw malformed(source, `provider url on another origin: ${url.origin}`);
  }
  return url.toString();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Un número que el proveedor puede mandar como número o como cadena (`"0.094"`). */
export function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Un mensaje del proveedor apto para la UI: una línea corta, sin nada raro. */
export function safeProviderMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length === 0) return fallback;
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

/** Redondeo a centavo de centavo: los precios de lista llegan a US$0,003. */
export function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
