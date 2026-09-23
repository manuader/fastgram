/**
 * Los handlers de identidad del BFF. Lo que no puede fallar:
 *
 * 1. El `sessionToken` va a una cookie `httpOnly` y **nunca** al cuerpo.
 * 2. Todo `POST` pasa por la guarda CSRF antes de tocar la API (login CSRF).
 * 3. Los errores de la API suben con su status, su `code` y su `Retry-After`.
 * 4. El logout borra la cookie aunque la API falle.
 *
 * `fetch` es un doble que responde por ruta con la forma **del contrato** que
 * se le dio a este agente — no contra la API real (ver el reporte).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleLogin,
  handleLogout,
  handlePasswordReset,
  handlePasswordResetComplete,
  handleSignup,
} from "./bff";

const HOST = "localhost:3000";
const SELF = `http://${HOST}`;
const TOKEN = "tok_SUPER_secret_value_123";
const EXPIRES = "2031-05-01T12:00:00.000Z";
const ENV = { FASTGRAM_API_URL: "http://api.internal/api/v1" } as const;
const USER = { id: "u1", email: "a@b.test", emailVerified: false };

type Route = (init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Route>;
let upstream: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function issued(status = 200): Response {
  return json(status, { data: { sessionToken: TOKEN, expiresAt: EXPIRES, user: USER } });
}

function sessionOf(
  companyId: string | null,
  onboardingComplete = companyId !== null,
): Response {
  return json(200, { data: { user: USER, companyId, onboardingComplete } });
}

beforeEach(() => {
  routes = {
    "/auth/login": () => issued(200),
    "/auth/signup": () => issued(201),
    "/auth/session": () => sessionOf("c1"),
    "/auth/logout": () => new Response(null, { status: 204 }),
    "/auth/password-reset": () => new Response(null, { status: 202 }),
    "/auth/password-reset/complete": () => new Response(null, { status: 204 }),
  };
  upstream = vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace(ENV.FASTGRAM_API_URL, "");
    const route = routes[path];
    if (route === undefined) throw new Error(`ruta no esperada: ${path}`);
    return route(init);
  });
  vi.stubGlobal("fetch", upstream);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

function post(
  path: string,
  body: unknown,
  overrides: Record<string, string | null> = {},
): Request {
  const base: Record<string, string | null> = {
    host: HOST,
    origin: SELF,
    "sec-fetch-site": "same-origin",
    "x-fastgram-csrf": "1",
    "content-type": "application/json",
    ...overrides,
  };
  const headers = new Headers();
  for (const [k, v] of Object.entries(base)) if (v !== null) headers.set(k, v);
  return new Request(`${SELF}/api/fastgram/auth${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sessionCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith("fg_session="));
}

function calledPaths(): string[] {
  return upstream.mock.calls.map(([url]) =>
    String(url).replace(ENV.FASTGRAM_API_URL, ""),
  );
}

const LOGIN = { email: "a@b.test", password: "hunter22" };

describe("login · éxito", () => {
  it("pone el token en una cookie httpOnly/Lax/Path=/ con la expiración de la API", async () => {
    const res = await handleLogin(post("/login", LOGIN), ENV);
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res) ?? "";
    expect(cookie).toContain(`fg_session=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Expires=${new Date(EXPIRES).toUTCString()}`);
    // Fuera de producción y sin origen https, sin `Secure` (Safari la tira en http).
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("el cuerpo NO lleva el token: sólo el usuario y a dónde ir", async () => {
    const res = await handleLogin(post("/login", LOGIN), ENV);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toEqual({ data: { user: USER, next: "/home" } });
  });

  it("Secure en producción", async () => {
    const res = await handleLogin(
      post("/login", LOGIN, { origin: "https://app.fastgram.test" }),
      {
        ...ENV,
        NODE_ENV: "production",
        FASTGRAM_APP_ORIGIN: "https://app.fastgram.test",
      },
    );
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toMatch(/Secure/i);
  });

  it("manda a la API sólo email y password, sin API key", async () => {
    await handleLogin(post("/login", { ...LOGIN, returnTo: "/calendar", extra: "x" }), {
      ...ENV,
      FASTGRAM_API_KEY: "fsln_live_x",
    } as Record<string, string>);
    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(LOGIN);
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("companyId null → next = /onboarding, aunque haya returnTo", async () => {
    routes["/auth/session"] = () => sessionOf(null);
    const res = await handleLogin(
      post("/login", { ...LOGIN, returnTo: "/calendar" }),
      ENV,
    );
    expect(await res.json()).toMatchObject({ data: { next: "/onboarding" } });
  });

  it("workspace en draft → next = /onboarding: no se deduce del companyId", async () => {
    routes["/auth/session"] = () => sessionOf("c1", false);
    const res = await handleLogin(
      post("/login", { ...LOGIN, returnTo: "/calendar" }),
      ENV,
    );
    expect(await res.json()).toMatchObject({ data: { next: "/onboarding" } });
  });

  it("con workspace respeta un returnTo de la app y descarta uno ajeno", async () => {
    const ok = await handleLogin(
      post("/login", { ...LOGIN, returnTo: "/calendar" }),
      ENV,
    );
    expect(await ok.json()).toMatchObject({ data: { next: "/calendar" } });
    const evil = await handleLogin(
      post("/login", { ...LOGIN, returnTo: "//evil.test/x" }),
      ENV,
    );
    expect(await evil.json()).toMatchObject({ data: { next: "/home" } });
  });

  it("si la verificación no contesta, el login igual vale (next = returnTo o /home)", async () => {
    routes["/auth/session"] = () =>
      json(503, { error: { code: "service_unavailable", message: "x" } });
    const res = await handleLogin(post("/login", LOGIN), ENV);
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toContain(TOKEN);
    expect(await res.json()).toMatchObject({ data: { next: "/home" } });
  });
});

describe("login · errores de la API", () => {
  it("401 sube como 401 unauthorized, sin cookie", async () => {
    routes["/auth/login"] = () =>
      json(401, {
        error: { code: "unauthorized", message: "Invalid email or password" },
      });
    const res = await handleLogin(post("/login", LOGIN), ENV);
    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toBeUndefined();
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("429 conserva Retry-After", async () => {
    routes["/auth/login"] = () =>
      json(
        429,
        { error: { code: "rate_limited", message: "slow" } },
        { "retry-after": "30" },
      );
    const res = await handleLogin(post("/login", LOGIN), ENV);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("503 service_unavailable sube como 503", async () => {
    routes["/auth/login"] = () =>
      json(503, { error: { code: "service_unavailable", message: "not configured" } });
    const res = await handleLogin(post("/login", LOGIN), ENV);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "service_unavailable" } });
  });

  it("API caída → 502 service_unavailable", async () => {
    routes["/auth/login"] = () => {
      throw new TypeError("fetch failed");
    };
    const res = await handleLogin(post("/login", LOGIN), ENV);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "service_unavailable" } });
  });

  it("un error que no es el sobre de §9.3 no se reenvía: 502", async () => {
    routes["/auth/login"] = () =>
      new Response("<html>stack trace</html>", { status: 500 });
    const res = await handleLogin(post("/login", LOGIN), ENV);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("stack trace");
  });

  it("un 200 fuera de contrato (sin expiresAt, o ya vencido) → 502 y sin cookie", async () => {
    routes["/auth/login"] = () =>
      json(200, { data: { sessionToken: TOKEN, user: USER } });
    const missing = await handleLogin(post("/login", LOGIN), ENV);
    expect(missing.status).toBe(502);
    expect(sessionCookie(missing)).toBeUndefined();
    expect(await missing.text()).not.toContain(TOKEN);

    routes["/auth/login"] = () =>
      json(200, {
        data: { sessionToken: TOKEN, expiresAt: "2001-01-01T00:00:00Z", user: USER },
      });
    const expired = await handleLogin(post("/login", LOGIN), ENV);
    expect(expired.status).toBe(502);
    expect(sessionCookie(expired)).toBeUndefined();
  });
});

describe("guardas antes de la API", () => {
  const handlers = [
    ["login", handleLogin, "/login", LOGIN],
    ["signup", handleSignup, "/signup", { ...LOGIN, fullName: "Ada" }],
    ["logout", handleLogout, "/logout", undefined],
    ["password-reset", handlePasswordReset, "/password-reset", { email: "a@b.test" }],
    [
      "password-reset/complete",
      handlePasswordResetComplete,
      "/password-reset/complete",
      { token: "t", newPassword: "hunter22" },
    ],
  ] as const;

  for (const [name, handler, path, body] of handlers) {
    it(`${name}: origen ajeno → 403 y la API ni se entera`, async () => {
      const res = await handler(post(path, body, { origin: "https://evil.test" }), ENV);
      expect(res.status).toBe(403);
      expect(sessionCookie(res)).toBeUndefined();
      expect(upstream).not.toHaveBeenCalled();
    });

    it(`${name}: sin el header custom → 403`, async () => {
      const res = await handler(post(path, body, { "x-fastgram-csrf": null }), ENV);
      expect(res.status).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    });
  }

  it("cuerpo inválido → 400 sin llamar a la API", async () => {
    for (const body of [
      {},
      { email: "a@b.test" },
      { email: 1, password: "x" },
      "no-json",
    ]) {
      const res = await handleLogin(post("/login", body), ENV);
      expect(res.status).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("en producción sin FASTGRAM_API_URL → 503", async () => {
    const res = await handleLogin(
      post("/login", LOGIN, { origin: "https://app.fastgram.test" }),
      { NODE_ENV: "production", FASTGRAM_APP_ORIGIN: "https://app.fastgram.test" },
    );
    expect(res.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("signup", () => {
  it("201: cookie puesta, cuerpo sin token, sólo los tres campos del contrato a la API", async () => {
    routes["/auth/session"] = () => sessionOf(null);
    const res = await handleSignup(
      post("/signup", { ...LOGIN, fullName: "Ada Lovelace", returnTo: "/home" }),
      ENV,
    );
    expect(res.status).toBe(201);
    expect(sessionCookie(res)).toContain(TOKEN);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toMatchObject({ data: { next: "/onboarding" } });
    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ ...LOGIN, fullName: "Ada Lovelace" });
  });

  it("409 conflict sube como 409, sin cookie", async () => {
    routes["/auth/signup"] = () =>
      json(409, { error: { code: "conflict", message: "exists" } });
    const res = await handleSignup(post("/signup", { ...LOGIN, fullName: "Ada" }), ENV);
    expect(res.status).toBe(409);
    expect(sessionCookie(res)).toBeUndefined();
    expect(await res.json()).toMatchObject({ error: { code: "conflict" } });
  });
});

describe("logout", () => {
  it("llama a la API con el token de la cookie y la borra", async () => {
    const res = await handleLogout(
      post("/logout", undefined, { cookie: `fg_session=${TOKEN}` }),
      ENV,
    );
    expect(res.status).toBe(204);
    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("x-fastgram-session")).toBe(TOKEN);
    const cookie = sessionCookie(res) ?? "";
    expect(cookie).toMatch(/^fg_session=;/);
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it("borra la cookie aunque la API esté caída o conteste 500", async () => {
    for (const failing of [
      () => {
        throw new TypeError("fetch failed");
      },
      () => json(500, {}),
    ]) {
      routes["/auth/logout"] = failing;
      const res = await handleLogout(
        post("/logout", undefined, { cookie: `fg_session=${TOKEN}` }),
        ENV,
      );
      expect(res.status).toBe(204);
      expect(sessionCookie(res)).toMatch(/^fg_session=;/);
    }
  });

  it("sin cookie no llama a la API, y contesta 204 igual", async () => {
    const res = await handleLogout(post("/logout", undefined), ENV);
    expect(res.status).toBe(204);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("recuperación de contraseña", () => {
  it("password-reset: 202 sin cuerpo", async () => {
    const res = await handlePasswordReset(
      post("/password-reset", { email: "a@b.test" }),
      ENV,
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(calledPaths()).toEqual(["/auth/password-reset"]);
  });

  it("password-reset: 429 conserva Retry-After", async () => {
    routes["/auth/password-reset"] = () =>
      json(
        429,
        { error: { code: "rate_limited", message: "x" } },
        { "retry-after": "60" },
      );
    const res = await handlePasswordReset(
      post("/password-reset", { email: "a@b.test" }),
      ENV,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("complete: 204 y reenvía token + newPassword", async () => {
    const res = await handlePasswordResetComplete(
      post("/password-reset/complete", { token: "reset-t", newPassword: "hunter22" }),
      ENV,
    );
    expect(res.status).toBe(204);
    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      token: "reset-t",
      newPassword: "hunter22",
    });
  });

  it("complete: 400 (enlace inválido) sube como 400", async () => {
    routes["/auth/password-reset/complete"] = () =>
      json(400, { error: { code: "bad_request", message: "invalid token" } });
    const res = await handlePasswordResetComplete(
      post("/password-reset/complete", { token: "bad", newPassword: "hunter22" }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
  });
});

describe("logs", () => {
  it("ningún camino imprime el token ni la contraseña", async () => {
    routes["/auth/login"] = () => new Response("nope", { status: 500 });
    await handleLogin(post("/login", LOGIN), ENV);
    routes["/auth/logout"] = () => {
      throw new TypeError(`fetch failed ${TOKEN}`);
    };
    await handleLogout(
      post("/logout", undefined, { cookie: `fg_session=${TOKEN}` }),
      ENV,
    );
    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(LOGIN.password);
  });
});
