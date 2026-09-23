/**
 * El sobre de la API (§9.3) es un contrato que **nadie ve fallar en pantalla**:
 * si el cliente lee mal un `{error}`, lo que aparece es un estado vacío y no un
 * error, y eso se confunde con "no hay datos". De ahí estos tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiList, apiRequest } from "./client";
import { ApiRequestError } from "./errors";

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(body === undefined ? "" : JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiRequest", () => {
  it("abre el sobre `{data}`", async () => {
    respondWith({ data: { name: "Ada" } });
    await expect(apiRequest("/whoami")).resolves.toEqual({ name: "Ada" });
  });

  it("valida contra el schema del contrato", async () => {
    respondWith({ data: { name: "Ada" } });
    const schema = z.object({ name: z.string() });
    await expect(apiRequest("/whoami", { schema })).resolves.toEqual({ name: "Ada" });
  });

  it("un `data` que el schema no acepta es `invalid_response`, no un éxito", async () => {
    respondWith({ data: { name: 42 } });
    const schema = z.object({ name: z.string() });
    await expect(apiRequest("/whoami", { schema })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("traduce `{error}` a un código estable y conserva `details`", async () => {
    respondWith(
      {
        error: {
          code: "content_quota_exceeded",
          message: "Monthly content quota reached for your plan",
          details: { count: 30, limit: 30 },
        },
      },
      429,
    );
    const failure = await apiRequest("/content").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({
      code: "content_quota_exceeded",
      status: 429,
      details: { count: 30, limit: 30 },
    });
  });

  it("un 500 con cuerpo ilegible sigue siendo un fallo", async () => {
    respondWith({ oops: true }, 500);
    await expect(apiRequest("/content")).rejects.toMatchObject({
      code: "invalid_response",
      status: 500,
    });
  });

  it("una respuesta 200 sin `data` no se cuela como `undefined`", async () => {
    respondWith({ name: "Ada" });
    await expect(apiRequest("/whoami")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("un fallo de red es `network_error`, no una excepción cruda", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(apiRequest("/whoami")).rejects.toMatchObject({
      code: "network_error",
      status: 0,
    });
  });
});

describe("apiList · paginación por cursor", () => {
  it("devuelve items, cursor y hasMore", async () => {
    respondWith({
      data: [{ id: "a" }, { id: "b" }],
      pagination: { cursor: "opaque-1", hasMore: true },
    });
    await expect(apiList("/posts")).resolves.toEqual({
      items: [{ id: "a" }, { id: "b" }],
      cursor: "opaque-1",
      hasMore: true,
    });
  });

  it("un listado sin bloque `pagination` es una única página, no un error", async () => {
    // `GET /warmed-accounts` es así a propósito (PRD:1695).
    respondWith({ data: [{ id: "a" }] });
    await expect(apiList("/warmed-accounts")).resolves.toEqual({
      items: [{ id: "a" }],
      cursor: null,
      hasMore: false,
    });
  });

  it("manda `cursor` y `limit` en la query", async () => {
    respondWith({ data: [], pagination: { cursor: null, hasMore: false } });
    await apiList("/posts", { cursor: "c1", limit: 50, query: { status: "POSTED" } });
    const fetchMock = globalThis.fetch as unknown as {
      mock: { calls: [string][] };
    };
    const url = new URL(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(url.searchParams.get("cursor")).toBe("c1");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("status")).toBe("POSTED");
  });

  it("un `data` que no es array es `invalid_response`", async () => {
    respondWith({ data: { id: "a" }, pagination: { cursor: null, hasMore: false } });
    await expect(apiList("/posts")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

/**
 * La base pasó de ser absoluta (`:3001`) a ser **relativa** (el route handler
 * que pone la credencial). Una base relativa no es una URL: si se resolviera
 * mal, cada petición del navegador saldría hacia otro origen —o no saldría— y
 * el síntoma sería un CORS en consola, lejos de la causa.
 */
describe("base del API", () => {
  function lastFetchedUrl(): string {
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: [string][] } };
    return fetchMock.mock.calls[0]?.[0] ?? "";
  }

  it("en el navegador, la base relativa cuelga del origen de la página", async () => {
    respondWith({ data: { ok: true } });
    vi.stubGlobal("window", { location: { origin: "https://app.example.test" } });
    await apiRequest("/content");
    expect(lastFetchedUrl()).toBe("https://app.example.test/api/fastgram/v1/content");
  });

  it("el path de la petición no se come el prefijo de versión", async () => {
    // `new URL("/content", "https://x/api/fastgram/v1/")` daría `https://x/content`:
    // el `/` inicial descarta el path de la base. De ahí el `slice(1)` del cliente.
    respondWith({ data: { ok: true } });
    vi.stubGlobal("window", { location: { origin: "https://app.example.test" } });
    await apiRequest("/content/abc");
    expect(lastFetchedUrl()).toContain("/api/fastgram/v1/content/abc");
  });
});

describe("header anti-CSRF del proxy", () => {
  function sentHeaders(): Headers {
    const mock = fetch as unknown as ReturnType<typeof vi.fn>;
    const init = (mock.mock.calls[0] as [string, RequestInit])[1];
    return new Headers(init.headers);
  }

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "%s lleva `x-fastgram-csrf: 1`, y quien llama no lo puede pisar",
    async (method) => {
      respondWith({ data: {} });
      await apiRequest("/content", {
        method,
        body: { a: 1 },
        headers: { "x-fastgram-csrf": "0" },
      });
      expect(sentHeaders().get("x-fastgram-csrf")).toBe("1");
    },
  );

  it("GET no lo lleva: no hace falta y fuerza un preflight inútil", async () => {
    respondWith({ data: {} });
    await apiRequest("/content");
    expect(sentHeaders().get("x-fastgram-csrf")).toBeNull();
  });
});
