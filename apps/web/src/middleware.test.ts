/**
 * El middleware conecta la cookie con la regla pura (`resolveNavigation`). Lo
 * que se fija acá es lo que la regla no ve: que pregunta a la API con el
 * token, que no pregunta en `/api/*`, y que la cookie muerta se borra en la
 * misma respuesta.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { middleware } from "./middleware";

const SELF = "http://localhost:3000";
const TOKEN = "tok_mw";
let upstream: ReturnType<typeof vi.fn>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nav(path: string, cookie?: string): NextRequest {
  return new NextRequest(`${SELF}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
}

beforeEach(() => {
  vi.stubEnv("FASTGRAM_API_URL", "http://api.internal/api/v1");
  upstream = vi.fn(async () =>
    Promise.resolve(
      json(200, {
        data: {
          user: { id: "u1", email: "a@b.test", emailVerified: true },
          companyId: "c1",
        },
      }),
    ),
  );
  vi.stubGlobal("fetch", upstream);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("middleware", () => {
  it("sin cookie no pregunta a la API y manda al login", async () => {
    const res = await middleware(nav("/home"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${SELF}/login?redirect_url=%2Fhome`);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("ya NO hay sesión de desarrollo: sin cookie, fuera de producción, es sin sesión", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await middleware(nav("/calendar"));
    expect(res.headers.get("location")).toContain("/login");
  });

  it("una cookie con el JSON viejo sin firmar no es una sesión: la API decide", async () => {
    upstream.mockResolvedValueOnce(
      json(401, { error: { code: "unauthorized", message: "x" } }),
    );
    const forged = encodeURIComponent(
      JSON.stringify({ userId: "admin", companyId: "c1", onboardingComplete: true }),
    );
    const res = await middleware(nav("/home", `fg_session=${forged}`));
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("cookie válida: pregunta con el token y deja pasar", async () => {
    const res = await middleware(nav("/home", `fg_session=${TOKEN}`));
    expect(res.headers.get("location")).toBeNull();
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.internal/api/v1/auth/session");
    expect(new Headers(init.headers).get("x-fastgram-session")).toBe(TOKEN);
  });

  it("token rechazado (401): login y la cookie se borra en la misma respuesta", async () => {
    upstream.mockResolvedValueOnce(
      json(401, { error: { code: "unauthorized", message: "x" } }),
    );
    const res = await middleware(nav("/home", `fg_session=${TOKEN}`));
    expect(res.headers.get("location")).toContain("/login");
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith("fg_session="));
    expect(cleared).toMatch(/^fg_session=;/);
    expect(cleared).toMatch(/HttpOnly/i);
  });

  it("API caída: login con el motivo de §15.2 y la cookie se conserva", async () => {
    upstream.mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await middleware(nav("/calendar", `fg_session=${TOKEN}`));
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("reason")).toBe("session_unverified");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("fg_session="))).toBe(
      false,
    );
  });

  it("/api/* no paga verificación (el proxy delega en la API)", async () => {
    const res = await middleware(nav("/api/fastgram/v1/content", `fg_session=${TOKEN}`));
    expect(res.headers.get("location")).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });
});
