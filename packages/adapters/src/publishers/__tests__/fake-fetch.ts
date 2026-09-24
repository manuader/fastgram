/**
 * Un `fetch` falso para los tests de los publicadores: rutas → respuestas con
 * la **forma documentada** (cada test cita la página de la que sale).
 *
 * Nada de red: una ruta que el test no declaró es un error del test.
 */
import type { PublisherFetch, Sleep } from "../shared/http.js";

export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | Uint8Array | FormData | undefined;
}

export type Reply =
  | {
      readonly status?: number;
      readonly json?: unknown;
      readonly headers?: Record<string, string>;
    }
  | {
      readonly status?: number;
      readonly bytes: Uint8Array;
      readonly headers?: Record<string, string>;
    }
  | { readonly throws: Error };

export interface Route {
  readonly method: string;
  /** Substring o regex sobre la URL completa. */
  readonly match: string | RegExp;
  /** Respuestas en orden; la última se repite. */
  readonly replies: readonly Reply[];
}

export class FakeFetch {
  readonly calls: RecordedCall[] = [];
  readonly #routes: { route: Route; used: number }[];

  constructor(routes: readonly Route[]) {
    this.#routes = routes.map((route) => ({ route, used: 0 }));
  }

  readonly fetch: PublisherFetch = async (url, init) => {
    this.calls.push({ method: init.method, url, headers: init.headers, body: init.body });
    const entry = this.#routes.find(
      ({ route }) =>
        route.method === init.method &&
        (typeof route.match === "string"
          ? url.includes(route.match)
          : route.match.test(url)),
    );
    if (entry === undefined)
      throw new Error(`ruta no declarada en el test: ${init.method} ${url}`);
    const reply =
      entry.route.replies[Math.min(entry.used, entry.route.replies.length - 1)];
    entry.used += 1;
    if (reply === undefined) throw new Error("ruta sin respuestas");
    if ("throws" in reply) throw reply.throws;
    const headers = new Headers(reply.headers ?? {});
    if ("bytes" in reply) {
      return new Response(reply.bytes, { status: reply.status ?? 200, headers });
    }
    const body = reply.json === undefined ? null : JSON.stringify(reply.json);
    if (body !== null && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    return new Response(body, { status: reply.status ?? 200, headers });
  };

  /** Las llamadas que matchean. */
  to(method: string, match: string | RegExp): RecordedCall[] {
    return this.calls.filter(
      (c) =>
        c.method === method &&
        (typeof match === "string" ? c.url.includes(match) : match.test(c.url)),
    );
  }
}

/** `sleep` que no espera. */
export const noSleep: Sleep = async () => {};

/** Lee el cuerpo form-encoded o JSON de una llamada. */
export function bodyOf(call: RecordedCall | undefined): Record<string, unknown> {
  if (call === undefined || call.body === undefined) return {};
  if (typeof call.body !== "string") return {};
  const type = call.headers["Content-Type"] ?? "";
  if (type.includes("json")) return JSON.parse(call.body) as Record<string, unknown>;
  return Object.fromEntries(new URLSearchParams(call.body));
}
