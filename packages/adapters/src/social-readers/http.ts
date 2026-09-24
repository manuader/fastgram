/**
 * El HTTP compartido de los extractores sociales — `PU-SCRAPE-001`.
 *
 * Los destinos de estos adaptadores **los configura el operador** (la URL del
 * servicio de visión, la del contenedor de TikTok, la de FxTwitter, la Graph
 * API), no el usuario: por eso no pasan por la guarda SSRF del extractor web.
 * Lo que sí viene del usuario es el `handle`, y se valida con un patrón
 * estricto y se codifica antes de ir en una URL ({@link ./handles.ts}).
 *
 * Ningún error crudo sale de acá (`NFR-022`): la red caída es
 * `provider_unavailable`, el timeout es `timeout`, y el original queda en
 * `cause` para el log.
 */
import { PortError } from "@fastgram/ports";

/** Lo mínimo de `fetch` que se usa. Inyectable para los tests. */
export type SocialFetch = (
  url: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  /** `undefined` si el cuerpo no era JSON. */
  readonly json: unknown;
}

export async function requestJson(
  fetchImpl: SocialFetch,
  url: string,
  options: {
    readonly source: string;
    readonly timeoutMs: number;
    readonly method?: "GET" | "POST";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  },
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, json };
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new PortError("timeout", "The profile extractor did not answer in time.", {
        source: options.source,
        cause: error,
      });
    }
    throw new PortError("provider_unavailable", "The profile extractor is unreachable.", {
      source: options.source,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** `Retry-After` en segundos (sólo la forma numérica), o `undefined`. */
export function retryAfterSeconds(
  headers: Headers,
  bodyValue?: unknown,
): number | undefined {
  if (typeof bodyValue === "number" && Number.isFinite(bodyValue) && bodyValue >= 0) {
    return Math.ceil(bodyValue);
  }
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Texto no vacío, o `undefined`. */
export function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** Entero no negativo, o `undefined`. Acepta strings numéricos (TikTok `statsV2`). */
export function count(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : undefined;
}

export function date(v: unknown): Date | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  // La Graph API escribe `2026-09-10T12:00:00+0000`: el offset sin `:` no es
  // ISO 8601 extendido y no todos los motores lo aceptan.
  const d = new Date(
    typeof v === "string" ? v.replace(/T(.+)([+-]\d{2})(\d{2})$/, "T$1$2:$3") : v,
  );
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const HASHTAG = /#([\p{L}\p{N}_]+)/gu;
const MENTION = /(?:^|[^\p{L}\p{N}_])@([\p{L}\p{N}._]+)/gu;

/** Hashtags de un texto, sin `#`, sin repetir, en orden de aparición. */
export function hashtagsOf(caption: string | undefined): string[] {
  if (caption === undefined) return [];
  return [...new Set([...caption.matchAll(HASHTAG)].map((m) => m[1] ?? ""))].filter(
    (h) => h !== "",
  );
}

export function mentionsOf(caption: string | undefined): string[] {
  if (caption === undefined) return [];
  return [...new Set([...caption.matchAll(MENTION)].map((m) => m[1] ?? ""))].filter(
    (h) => h !== "",
  );
}

/** Del más reciente al más viejo: el orden que el puerto exige. Estable. */
export function newestFirst<T extends { readonly postedAt?: Date }>(
  items: readonly T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (b.item.postedAt?.getTime() ?? -Infinity) -
          (a.item.postedAt?.getTime() ?? -Infinity) || a.index - b.index,
    )
    .map((x) => x.item);
}

/** Base URL sin barra final. */
export function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * `{ [key]: value }` si hay valor, `{}` si no. Con `exactOptionalPropertyTypes`
 * una clave opcional no admite `undefined`: esto evita escribir la misma
 * expresión dos veces en cada campo.
 */
export function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
