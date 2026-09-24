/**
 * HTTP de los publicadores — `PU-PUB-003…006`.
 *
 * Todo lo que los cinco adaptadores comparten para hablar con una plataforma,
 * y la **única** regla que importa de este archivo: la distinción entre un
 * fallo **antes de entregar** (se puede reintentar sin duplicar) y uno **en el
 * paso que publica** (no se sabe si salió; `PublishDeliveryUncertainError`).
 * Cada llamada declara su `phase`, y es esa declaración la que decide.
 *
 * El `fetch` se inyecta: los tests le pasan respuestas con la forma que la
 * documentación oficial muestra, y **ningún test habla con una plataforma**.
 */
import {
  PortError,
  PublishDeliveryUncertainError,
  type PortErrorCode,
} from "@fastgram/ports";

/** Un subconjunto de `fetch` con lo que usan los adaptadores. */
export type PublisherFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string | Uint8Array | FormData;
    readonly signal?: AbortSignal;
  },
) => Promise<Response>;

/** Pausa inyectable: los tests no esperan de verdad. */
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * `prepare`: crear contenedor, subir media, consultar estado. Si falla, la
 * plataforma no publicó nada.
 * `deliver`: el paso que publica. Un timeout o un 5xx acá es incierto.
 */
export type CallPhase = "prepare" | "deliver";

export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  /** El cuerpo parseado como JSON, o `null` si no era JSON. */
  readonly json: unknown;
}

export interface CallOptions {
  readonly source: string;
  readonly phase: CallPhase;
  readonly timeoutMs: number;
}

/**
 * Hace la llamada y devuelve **cualquier** respuesta HTTP (también 4xx/5xx:
 * clasificarla es de cada plataforma). Sólo lanza por transporte: sin
 * respuesta, o timeout.
 */
export async function call(
  fetchImpl: PublisherFetch,
  url: string,
  init: {
    readonly method: string;
    readonly headers?: Record<string, string>;
    readonly body?: string | Uint8Array | FormData;
  },
  options: CallOptions,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      headers: init.headers ?? {},
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: controller.signal,
    });
  } catch (cause: unknown) {
    const aborted = controller.signal.aborted;
    throw transportError(
      aborted ? "timeout" : "provider_unavailable",
      aborted
        ? "The platform took too long to answer."
        : "The platform could not be reached.",
      options,
      cause,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => "");
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, json };
}

/** Error de transporte según la fase. */
export function transportError(
  code: PortErrorCode,
  message: string,
  options: Pick<CallOptions, "source" | "phase">,
  cause?: unknown,
  retryAfterSeconds?: number,
): PortError {
  const opts = {
    source: options.source,
    ...(cause === undefined ? {} : { cause }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
  return options.phase === "deliver"
    ? new PublishDeliveryUncertainError(code, message, opts)
    : new PortError(code, message, opts);
}

/**
 * Un 5xx: en `prepare` es `provider_unavailable` reintentable; en `deliver`,
 * entrega incierta.
 */
export function serverError(
  result: HttpResult,
  options: Pick<CallOptions, "source" | "phase">,
): PortError {
  return transportError(
    "provider_unavailable",
    "The platform is having trouble right now.",
    options,
    { status: result.status },
    retryAfterOf(result.headers),
  );
}

/** `Retry-After` en segundos, si vino como número. */
export function retryAfterOf(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Lee un campo `string` de un objeto `unknown` sin `as` a ciegas. */
export function str(value: unknown, ...path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === "string") return current;
  if (typeof current === "number" && Number.isFinite(current)) return String(current);
  return undefined;
}

/** Lee un campo cualquiera. */
export function field(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** La plataforma respondió 2xx con algo que no es lo documentado. */
export function contractViolation(source: string, what: string): PortError {
  return new PortError(
    "provider_contract_violation",
    "The platform answered with something unexpected.",
    { source, cause: { what } },
  );
}

/**
 * Baja los bytes de una URL (firmada del propio storage, o pública). Para las
 * plataformas que exigen subir el archivo (X, video de TikTok).
 *
 * Es `prepare`: si falla, no se entregó nada.
 */
export async function downloadBytes(
  fetchImpl: PublisherFetch,
  url: string,
  options: {
    readonly source: string;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  },
): Promise<{ readonly bytes: Uint8Array; readonly contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {},
        signal: controller.signal,
      });
    } catch (cause: unknown) {
      throw new PortError(
        controller.signal.aborted ? "timeout" : "provider_unavailable",
        "The media file could not be read.",
        { source: options.source, cause },
      );
    }
    if (!response.ok) {
      throw new PortError(
        response.status >= 500 ? "provider_unavailable" : "not_found",
        "The media file could not be read.",
        { source: options.source, cause: { status: response.status } },
      );
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > options.maxBytes) {
      throw new PortError("bad_request", "The media file is too large to publish.", {
        source: options.source,
        cause: { bytes: buffer.byteLength, max: options.maxBytes },
      });
    }
    return {
      bytes: buffer,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  } finally {
    clearTimeout(timer);
  }
}
