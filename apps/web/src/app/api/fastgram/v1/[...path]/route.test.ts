// @vitest-environment node
/**
 * El proxy es la única puerta con la key del servidor puesta. Estos tests
 * fijan lo que el handler hace con las **escrituras**: qué rechaza antes de
 * tocar nada, y qué reenvía cuando pasa.
 *
 * Entorno `node` a propósito (el default de `src/app/**` es jsdom): el handler
 * corre en el servidor de Next, y bajo jsdom `Request`/`Response` no son los
 * de undici.
 *
 * Cada guarda tiene su test rojo verificado quitándola (reporte de la tarea).
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/session";

const readSession = vi.fn<() => Promise<Session | null>>();
vi.mock("@/lib/auth/server-session", () => ({
  readSession: () => readSession(),
}));

const { GET, POST, PATCH, PUT, DELETE } = await import("./route");

const SESSION: Session = {
  userId: "u1",
  companyId: "c1",
  onboardingComplete: true,
  isStaff: false,
};

const HOST = "localhost:3000";
const SELF = `http://${HOST}`;
const API_KEY = "fsln_live_test_key_not_a_secret";

type Handler = typeof GET;

let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  readSession.mockResolvedValue(SESSION);
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
    cookie: "fg_session=abc",
    authorization: "Bearer attacker_chosen_key",
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
  it("reenvía método, cuerpo, Content-Type e Idempotency-Key; no Cookie ni el Authorization del cliente", async () => {
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
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
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
    readSession.mockResolvedValue(null);
    const res = await POST(writeRequest("POST"), context(["content"]));
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
      getRequest({ cookie: "fg_session=abc", authorization: "Bearer x" }),
      context(["content"]),
    );
    expect(res.status).toBe(200);
    const [target] = upstream.mock.calls[0] as [string];
    expect(target).toBe("http://api.internal:3001/api/v1/content?limit=5");
    const init = sentInit();
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("content-type")).toBeNull();
  });

  it("sin sesión → 401", async () => {
    readSession.mockResolvedValue(null);
    const res = await get(getRequest(), context(["content"]));
    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("proxy · marca activa (PU-BRAND-001)", () => {
  const BRAND = "3f2b8c1e-9a4d-4c6b-8e2f-1a2b3c4d5e6f";

  function getWith(cookie: string, extra: Record<string, string> = {}): NextRequest {
    return new NextRequest(`${SELF}/api/fastgram/v1/content`, {
      headers: { host: HOST, cookie, ...extra },
    });
  }

  it("la cookie fg_workspace sale como X-Fastgram-Workspace", async () => {
    const res = await GET(
      getWith(`fg_session=abc; fg_workspace=${BRAND}`),
      context(["content"]),
    );
    expect(res.status).toBe(200);
    expect(new Headers(sentInit().headers).get("x-fastgram-workspace")).toBe(BRAND);
  });

  it("también en escrituras, después de pasar la guarda CSRF", async () => {
    const res = await PATCH(
      writeRequest("PATCH", { cookie: `fg_session=abc; fg_workspace=${BRAND}` }),
      context(["blitz", "preferences"]),
    );
    expect(res.status).toBe(200);
    expect(new Headers(sentInit().headers).get("x-fastgram-workspace")).toBe(BRAND);
  });

  it("una escritura cross-site con la cookie puesta sigue siendo 403 y no llega a la API", async () => {
    const res = await DELETE(
      writeRequest("DELETE", {
        origin: "https://evil.test",
        cookie: `fg_session=abc; fg_workspace=${BRAND}`,
      }),
      context(["workspaces", BRAND]),
    );
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("sin cookie no hay header: la API usa la marca de la key", async () => {
    await GET(getWith("fg_session=abc"), context(["content"]));
    expect(new Headers(sentInit().headers).get("x-fastgram-workspace")).toBeNull();
  });

  it("una cookie sin forma de uuid no se reenvía", async () => {
    await GET(getWith("fg_workspace=..%2Fadmin"), context(["content"]));
    expect(new Headers(sentInit().headers).get("x-fastgram-workspace")).toBeNull();
  });

  it("un X-Fastgram-Workspace que manda el navegador no pasa", async () => {
    await GET(
      getWith("fg_session=abc", { "x-fastgram-workspace": BRAND }),
      context(["content"]),
    );
    expect(new Headers(sentInit().headers).get("x-fastgram-workspace")).toBeNull();
  });
});
