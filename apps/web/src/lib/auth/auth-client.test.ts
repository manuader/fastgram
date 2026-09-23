/**
 * El cliente de identidad del navegador: que manda la guarda CSRF, que lee el
 * `Retry-After`, y qué mensaje ve el usuario por cada fallo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../api/errors";
import { presentAuthError, retryAfterSeconds, signIn, signOut } from "./auth-client";

let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  upstream = vi.fn();
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("signIn / signOut", () => {
  it("POST same-origin al BFF con el header CSRF", async () => {
    upstream.mockResolvedValue(
      json(200, {
        data: { user: { id: "u", email: "e", emailVerified: true }, next: "/home" },
      }),
    );
    const result = await signIn({ email: "a@b.test", password: "x" });
    expect(result.next).toBe("/home");
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/fastgram/auth/login");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-fastgram-csrf")).toBe("1");
  });

  it("un 429 lleva los segundos de Retry-After en details", async () => {
    upstream.mockResolvedValue(
      json(
        429,
        { error: { code: "rate_limited", message: "x" } },
        { "retry-after": "42" },
      ),
    );
    const error = await signIn({ email: "a", password: "b" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).details).toMatchObject({ retryAfterSeconds: 42 });
  });

  it("un next que no es una ruta de la app es respuesta inválida", async () => {
    upstream.mockResolvedValue(
      json(200, {
        data: {
          user: { id: "u", email: "e", emailVerified: true },
          next: "https://evil.test",
        },
      }),
    );
    await expect(signIn({ email: "a", password: "b" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("logout acepta 204 sin cuerpo", async () => {
    upstream.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(signOut()).resolves.toBeUndefined();
  });

  it("red caída → network_error", async () => {
    upstream.mockRejectedValue(new TypeError("fetch failed"));
    await expect(signOut()).rejects.toMatchObject({ code: "network_error" });
  });
});

describe("retryAfterSeconds", () => {
  it("segundos, fecha HTTP, y basura", () => {
    expect(retryAfterSeconds("30")).toBe(30);
    expect(retryAfterSeconds("1.2")).toBe(2);
    const now = Date.parse("2030-01-01T00:00:00Z");
    expect(retryAfterSeconds("Tue, 01 Jan 2030 00:00:10 GMT", now)).toBe(10);
    expect(retryAfterSeconds("mañana")).toBeNull();
    expect(retryAfterSeconds(null)).toBeNull();
  });
});

describe("presentAuthError", () => {
  const err = (
    code: ConstructorParameters<typeof ApiRequestError>[0]["code"],
    details?: Record<string, unknown>,
  ) => new ApiRequestError({ code, status: 0, details });

  it("401 en el login es neutro (no dice cuál campo falló)", () => {
    expect(presentAuthError(err("unauthorized"), "login")).toEqual({
      key: "auth.error.invalidCredentials",
    });
  });

  it("409 en el signup ofrece ir al login", () => {
    expect(presentAuthError(err("conflict"), "signup")).toEqual({
      key: "auth.error.emailTaken",
      action: "login",
    });
  });

  it("429 con y sin segundos", () => {
    expect(
      presentAuthError(err("rate_limited", { retryAfterSeconds: 12 }), "login"),
    ).toEqual({
      key: "auth.error.rateLimitedFor",
      vars: { seconds: 12 },
    });
    expect(presentAuthError(err("rate_limited"), "login")).toEqual({
      key: "auth.error.rateLimited",
    });
  });

  it("503 y 400 del reset", () => {
    expect(presentAuthError(err("service_unavailable"), "signup").key).toBe(
      "error.serviceUnavailable.title",
    );
    expect(presentAuthError(err("bad_request"), "reset")).toEqual({
      key: "auth.reset.invalidLink",
      action: "requestNewLink",
    });
  });
});
