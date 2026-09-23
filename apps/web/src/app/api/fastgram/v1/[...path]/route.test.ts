// @vitest-environment node
/**
 * El proxy es la única puerta por la que el token de sesión del usuario llega
 * a la API. Estos tests fijan qué credencial sale (la del usuario, y sólo
 * ésa), qué rechaza antes de tocar nada, y qué reenvía cuando pasa.
 *
 * Entorno `node` a propósito (el default de `src/app/**` es jsdom): el handler
 * corre en el servidor de Next, y bajo jsdom `Request`/`Response` no son los
 * de undici.
 *
 * Cada guarda tiene su test rojo verificado quitándola (reporte de la tarea).
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { GET, POST, PATCH, PUT, DELETE } = await import("./route");

const HOST = "localhost:3000";
const SELF = `http://${HOST}`;
/** Una key de servidor puesta en el entorno, para probar que **no** sale. */
const API_KEY = "fsln_live_test_key_not_a_secret";
const TOKEN = "session-token-of-the-user";

type Handler = typeof GET;

let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("FASTGRAM_API_KEY", API_KEY);
  vi.stubEnv("FASTGRAM_API_URL", "http://api.internal:3001/api/v1");
  vi.stubEnv("FASTGRAM_APP_ORIGIN", "");
  upstream = vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", upstream);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function context(path: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path }) };
}

/** Una escritura same-origin válida; `overrides` quita (`null`) o cambia headers. */
function writeRequest(
  method: string,
  overrides: Record<string, string | null> = {},
  body: string | null = JSON.stringify({ name: "x" }),
): NextRequest {
  const base: Record<string, string | null> = {
    host: HOST,
    origin: SELF,
    "sec-fetch-site": "same-origin",
    "x-fastgram-csrf": "1",
    "content-type": "application/json; charset=utf-8",
    "idempotency-key": "idem-123",
    cookie: `fg_session=${TOKEN}; other=1`,
    authorization: "Bearer attacker_chosen_key",
    "x-fastgram-session": "attacker-chosen-session",
    ...overrides,
  };
  const headers = new Headers();
  for (const [k, v] of Object.entries(base)) if (v !== null) headers.set(k, v);
  return new NextRequest(`${SELF}/api/fastgram/v1/blitz/preferences`, {
    method,
    headers,
    ...(body === null ? {} : { body }),
  });
}

async function errorOf(
  res: Response,
): Promise<{ code: string; details?: { reason?: string } }> {
  const json = (await res.json()) as {
    error: { code: string; details?: { reason?: string } };
  };
  return json.error;
}

function sentInit(): RequestInit {
  expect(upstream).toHaveBeenCalledTimes(1);
  const call = upstream.mock.calls[0] as [string, RequestInit];
  return call[1];
}

describe("proxy · escrituras rechazadas por CSRF", () => {
  it("origen ajeno → 403 y no llega a la API", async () => {
    const res = await PATCH(
      writeRequest("PATCH", { origin: "https://evil.test" }),
      context(["blitz", "preferences"]),
    );
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({
      code: "forbidden",
      details: { reason: "origin_mismatch" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("mismo host con otro esquema tampoco es el origen propio", async () => {
    const res = await POST(
      writeRequest("POST", { origin: `https://${HOST}` }),
      context(["content"]),
    );
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("sin Origin → 403", async () => {
    const res = await POST(writeRequest("POST", { origin: null }), context(["content"]));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ details: { reason: "missing_origin" } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("Sec-Fetch-Site cross-site → 403 aunque el Origin coincida", async () => {
    const res = await DELETE(
      writeRequest("DELETE", { "sec-fetch-site": "cross-site" }),
      context(["content", "1"]),
    );
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ details: { reason: "cross_site_fetch" } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("Sec-Fetch-Site same-site (subdominio hermano) → 403", async () => {
    const res = await PUT(
      writeRequest("PUT", { "sec-fetch-site": "same-site" }),
      context(["x"]),
    );
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("sin el header custom → 403", async () => {
    const res = await POST(
      writeRequest("POST", { "x-fastgram-csrf": null }),
      context(["content"]),
    );
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({
      details: { reason: "missing_csrf_header" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("no confía en X-Forwarded-Host: un Origin que sólo coincide con él es ajeno", async () => {
    const res = await POST(
      writeRequest("POST", {
        origin: "https://evil.test",
        "x-forwarded-host": "evil.test",
        "x-forwarded-proto": "https",
      }),
      context(["content"]),
    );
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("con FASTGRAM_APP_ORIGIN manda la variable, no el Host", async () => {
    vi.stubEnv("FASTGRAM_APP_ORIGIN", "https://app.fastgram.test");
    const rejected = await POST(writeRequest("POST"), context(["content"]));
    expect(rejected.status).toBe(403);
    const accepted = await POST(
      writeRequest("POST", {
        origin: "https://app.fastgram.test",
        host: "10.0.0.7:3000",
      }),
      context(["content"]),
    );
    expect(accepted.status).toBe(200);
  });
});

describe("proxy · escritura same-origin válida", () => {
  it("reenvía método, cuerpo, Content-Type, Idempotency-Key y la sesión de la cookie; nada más", async () => {
    const res = await PATCH(writeRequest("PATCH"), context(["blitz", "preferences"]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });

    const [target] = upstream.mock.calls[0] as [string];
    expect(target).toBe("http://api.internal:3001/api/v1/blitz/preferences");
    const init = sentInit();
    expect(init.method).toBe("PATCH");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(
      JSON.stringify({ name: "x" }),
    );

    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(headers.get("idempotency-key")).toBe("idem-123");
    // Una credencial y una sola: la del usuario, sacada de la cookie — no la
    // key del servidor, no el `Authorization` ni el header que mandó el cliente.
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-fastgram-session")).toBe(TOKEN);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-fastgram-csrf")).toBeNull();
    expect(headers.get("origin")).toBeNull();
  });

  it("un status de error de la API sube tal cual, con su sobre", async () => {
    upstream.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: "payment_required", message: "no" } }),
        {
          status: 402,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const res = await POST(writeRequest("POST"), context(["content"]));
    expect(res.status).toBe(402);
    expect(await errorOf(res)).toMatchObject({ code: "payment_required" });
  });

  it("un 204 de la API no revienta el handler", async () => {
    upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await DELETE(writeRequest("DELETE", {}, null), context(["content", "1"]));
    expect(res.status).toBe(204);
    expect(sentInit().body).toBeUndefined();
  });

  it("NFR-005: si la API no responde, un solo intento y 502", async () => {
    upstream.mockRejectedValue(new TypeError("fetch failed"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await POST(writeRequest("POST"), context(["content"]));
    expect(res.status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("sin sesión → 401, aun con las guardas CSRF en orden", async () => {
    const res = await POST(writeRequest("POST", { cookie: null }), context(["content"]));
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatchObject({ code: "unauthorized" });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("proxy · GET sigue igual", () => {
  const get: Handler = GET;

  function getRequest(headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(`${SELF}/api/fastgram/v1/content?limit=5`, {
      headers: { host: HOST, ...headers },
    });
  }

  it("no exige Origin ni header custom, y reenvía sin cuerpo ni Content-Type", async () => {
    const res = await get(
      getRequest({ cookie: `fg_session=${TOKEN}`, authorization: "Bearer x" }),
      context(["content"]),
    );
    expect(res.status).toBe(200);
    const [target] = upstream.mock.calls[0] as [string];
    expect(target).toBe("http://api.internal:3001/api/v1/content?limit=5");
    const init = sentInit();
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-fastgram-session")).toBe(TOKEN);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("content-type")).toBeNull();
  });

  it("sin sesión → 401, y la key del servidor no la reemplaza", async () => {
    const res = await get(
      getRequest({ authorization: "Bearer x" }),
      context(["content"]),
    );
    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("una cookie vacía no es una sesión", async () => {
    const res = await get(getRequest({ cookie: "fg_session=" }), context(["content"]));
    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("un 401 de la API (token vencido) sube tal cual", async () => {
    upstream.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await get(
      getRequest({ cookie: `fg_session=${TOKEN}` }),
      context(["content"]),
    );
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toMatchObject({ code: "unauthorized" });
  });

  it("Retry-After de un 429 cruza el puente", async () => {
    upstream.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "12" },
      }),
    );
    const res = await get(
      getRequest({ cookie: `fg_session=${TOKEN}` }),
      context(["content"]),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
  });
});

describe("proxy · /auth/* no se reenvía nunca", () => {
  /**
   * Los endpoints de identidad de la API devuelven `sessionToken` en el
   * cuerpo, y el proxy devuelve el cuerpo tal cual: reenviarlos le daría el
   * token al JavaScript de la página.
   */
  it("POST /auth/login por el proxy → 404, sin llegar a la API", async () => {
    const res = await POST(
      writeRequest("POST", {}, JSON.stringify({ email: "a@b.test", password: "x" })),
      context(["auth", "login"]),
    );
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("GET /auth/session tampoco, ni con mayúsculas", async () => {
    for (const first of ["auth", "AUTH", "Auth"]) {
      const res = await GET(
        new NextRequest(`${SELF}/api/fastgram/v1/${first}/session`, {
          headers: { host: HOST, cookie: `fg_session=${TOKEN}` },
        }),
        context([first, "session"]),
      );
      expect(res.status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});
