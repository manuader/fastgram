/**
 * "Hay sesión" = hay cookie **y** la API la valida. Estos tests fijan los tres
 * resultados de preguntarle a la API y que ninguno se confunde con otro: el
 * error caro es tratar "no sé" (API caída) como "no hay sesión".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearedSessionCookieOptions,
  sessionCookieOptions,
  verifySessionToken,
} from "./session";

const TOKEN = "tok_abc123";
const ENV = { FASTGRAM_API_URL: "http://api.internal/api/v1" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const VALID = {
  data: {
    user: { id: "u1", email: "a@b.test", emailVerified: false },
    companyId: "c1",
  },
};

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe("verifySessionToken", () => {
  it("sin cookie no pregunta nada: anonymous", async () => {
    const fetchImpl = vi.fn();
    expect(await verifySessionToken(undefined, ENV, fetchImpl)).toEqual({
      kind: "anonymous",
    });
    expect(await verifySessionToken("", ENV, fetchImpl)).toEqual({ kind: "anonymous" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("manda el token en X-Fastgram-Session a /auth/session, sin API key", async () => {
    const fetchImpl = vi.fn(async () => Promise.resolve(json(200, VALID)));
    await verifySessionToken(
      TOKEN,
      { ...ENV, FASTGRAM_API_KEY: "fsln_live_x" },
      fetchImpl,
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.internal/api/v1/auth/session");
    const headers = new Headers(init.headers);
    expect(headers.get("x-fastgram-session")).toBe(TOKEN);
    expect(headers.get("authorization")).toBeNull();
  });

  it("200 con el contrato → authenticated, con companyId y onboarding derivado", async () => {
    const state = await verifySessionToken(TOKEN, ENV, async () =>
      Promise.resolve(json(200, VALID)),
    );
    expect(state).toEqual({
      kind: "authenticated",
      session: {
        userId: "u1",
        email: "a@b.test",
        companyId: "c1",
        onboardingComplete: true,
        isStaff: false,
      },
    });
  });

  it("companyId null → onboarding pendiente", async () => {
    const state = await verifySessionToken(TOKEN, ENV, async () =>
      Promise.resolve(json(200, { data: { ...VALID.data, companyId: null } })),
    );
    expect(state).toMatchObject({
      kind: "authenticated",
      session: { companyId: null, onboardingComplete: false },
    });
  });

  it("401 → rejected (la cookie es basura)", async () => {
    const state = await verifySessionToken(TOKEN, ENV, async () =>
      Promise.resolve(json(401, { error: { code: "unauthorized", message: "no" } })),
    );
    expect(state).toEqual({ kind: "rejected" });
  });

  it("503, red caída o cuerpo fuera de contrato → unverifiable, NUNCA rejected", async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => Promise.resolve(json(503, { error: { code: "service_unavailable" } })),
      async () => Promise.resolve(json(500, {})),
      async () => Promise.reject(new TypeError("fetch failed")),
      async () => Promise.resolve(json(200, { data: { user: { id: "u1" } } })),
      async () => Promise.resolve(new Response("<html>", { status: 200 })),
    ];
    for (const fetchImpl of cases) {
      expect(await verifySessionToken(TOKEN, ENV, fetchImpl)).toEqual({
        kind: "unverifiable",
      });
    }
  });

  it("en producción sin FASTGRAM_API_URL → unverifiable, sin llamar a localhost", async () => {
    const fetchImpl = vi.fn();
    expect(
      await verifySessionToken(TOKEN, { NODE_ENV: "production" }, fetchImpl),
    ).toEqual({
      kind: "unverifiable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("el token no aparece en ningún log", async () => {
    await verifySessionToken(TOKEN, ENV, async () =>
      Promise.reject(new TypeError(`fetch failed with ${TOKEN}`)),
    );
    await verifySessionToken(TOKEN, ENV, async () => Promise.resolve(json(500, {})));
    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TOKEN);
  });

  it("no cachea entre llamadas: cada verificación pregunta (sin cache de proceso)", async () => {
    const fetchImpl = vi.fn(async () => Promise.resolve(json(200, VALID)));
    await verifySessionToken(TOKEN, ENV, fetchImpl);
    await verifySessionToken(TOKEN, ENV, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("flags de la cookie", () => {
  const expires = new Date("2030-01-01T00:00:00Z");

  it("httpOnly, SameSite=Lax, Path=/ y la expiración de la API", () => {
    expect(sessionCookieOptions(expires, {})).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      expires,
    });
  });

  it("Secure en producción y con un origen público https", () => {
    expect(sessionCookieOptions(expires, { NODE_ENV: "production" }).secure).toBe(true);
    expect(
      sessionCookieOptions(expires, { FASTGRAM_APP_ORIGIN: "https://app.fastgram.test" })
        .secure,
    ).toBe(true);
  });

  it("borrar = mismas flags, vencida", () => {
    const cleared = clearedSessionCookieOptions({ NODE_ENV: "production" });
    expect(cleared.expires.getTime()).toBe(0);
    expect(cleared).toMatchObject({ httpOnly: true, secure: true, path: "/" });
  });
});
