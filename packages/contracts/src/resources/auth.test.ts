/**
 * Contrato de `/auth/*` — el que el BFF de `apps/web` consume en paralelo.
 *
 * Los nombres y las formas están **fijados por el coordinador** antes de que
 * cualquiera de los dos lados escribiera código (trampa 25 de HANDOFF): si un
 * test de acá se pone rojo, el cambio rompe al otro lado y hay que reportarlo,
 * no "arreglar el test".
 */
import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "../openapi.js";
import {
  SESSION_HEADER,
  SESSION_UNAUTHORIZED_MESSAGE,
  authSessionSchema,
  loginRequestSchema,
  passwordResetCompleteRequestSchema,
  passwordResetRequestSchema,
  sessionInfoSchema,
  signUpRequestSchema,
} from "./auth.js";

const user = { id: "u_1", email: "a@example.test", emailVerified: false };

describe("requests de /auth", () => {
  it("signup exige exactamente {email, password, fullName}", () => {
    const ok = { email: "a@example.test", password: "12345678", fullName: "Ana" };
    expect(signUpRequestSchema.parse(ok)).toEqual(ok);
    expect(signUpRequestSchema.safeParse({ ...ok, role: "admin" }).success).toBe(false);
    expect(signUpRequestSchema.safeParse({ ...ok, password: "1234567" }).success).toBe(
      false,
    );
    expect(signUpRequestSchema.safeParse({ ...ok, fullName: " A " }).success).toBe(false);
    expect(signUpRequestSchema.safeParse({ ...ok, email: "no-es-email" }).success).toBe(
      false,
    );
  });

  it("login no aplica el mínimo de la política: una contraseña corta es un 401, no un 400", () => {
    expect(
      loginRequestSchema.safeParse({ email: "a@example.test", password: "123" }).success,
    ).toBe(true);
    expect(
      loginRequestSchema.safeParse({ email: "a@example.test", password: "" }).success,
    ).toBe(false);
    expect(
      loginRequestSchema.safeParse({ email: "a@example.test", password: "x", extra: 1 })
        .success,
    ).toBe(false);
  });

  it("password-reset y complete son strict", () => {
    expect(
      passwordResetRequestSchema.safeParse({ email: "a@example.test" }).success,
    ).toBe(true);
    expect(
      passwordResetRequestSchema.safeParse({ email: "a@example.test", x: 1 }).success,
    ).toBe(false);
    expect(
      passwordResetCompleteRequestSchema.safeParse({
        token: "t",
        newPassword: "12345678",
      }).success,
    ).toBe(true);
    expect(
      passwordResetCompleteRequestSchema.safeParse({ token: "t", newPassword: "short" })
        .success,
    ).toBe(false);
  });
});

describe("responses de /auth", () => {
  it("la sesión es {sessionToken, expiresAt ISO, user:{id,email,emailVerified}}", () => {
    const ok = { sessionToken: "tok", expiresAt: "2026-09-30T12:00:00.000Z", user };
    expect(authSessionSchema.parse(ok)).toEqual(ok);
    expect(authSessionSchema.safeParse({ ...ok, expiresAt: 123 }).success).toBe(false);
    expect(
      authSessionSchema.safeParse({ ...ok, user: { ...user, name: "Ana" } }).success,
    ).toBe(false);
  });

  it("GET /auth/session admite companyId null (sesión sin workspace)", () => {
    expect(
      sessionInfoSchema.parse({ user, companyId: null, onboardingComplete: false }),
    ).toEqual({ user, companyId: null, onboardingComplete: false });
    expect(sessionInfoSchema.safeParse({ user }).success).toBe(false);
    // `onboardingComplete` es obligatorio: sin él la web volvía a deducirlo del
    // `companyId` y mandaba a /home a mitad del alta.
    expect(sessionInfoSchema.safeParse({ user, companyId: null }).success).toBe(false);
  });

  it("el copy del 401 de sesión es el literal de §15.2", () => {
    expect(SESSION_UNAUTHORIZED_MESSAGE).toBe(
      "We couldn't verify your session. Try again, or sign in again if this continues.",
    );
    expect(SESSION_HEADER).toBe("X-Fastgram-Session");
  });
});

describe("/auth en el OpenAPI", () => {
  const doc = buildOpenApiDocument();
  const ops = [
    ["/auth/signup", "post"],
    ["/auth/login", "post"],
    ["/auth/logout", "post"],
    ["/auth/session", "get"],
    ["/auth/password-reset", "post"],
    ["/auth/password-reset/complete", "post"],
  ] as const;

  it("las seis operaciones están, marcadas internas y sin API key", () => {
    for (const [path, method] of ops) {
      const op = doc.paths[path]?.[method];
      expect(op, `falta ${method} ${path}`).toBeDefined();
      expect(op?.["x-internal"]).toBe(true);
      expect(op?.security).toEqual([]);
    }
  });

  it("ninguna ruta de negocio quedó marcada interna ni sin seguridad", () => {
    // La única excepción fuera de `/auth/*`, nombrada: `P1-TENANT-001` crea el
    // workspace con la sesión de un usuario que todavía no tiene ninguno.
    // Sumar otra acá es una decisión, no un arreglo del test.
    const INTERNAL_OUTSIDE_AUTH = new Set(["/onboarding/workspace"]);
    for (const [path, operations] of Object.entries(doc.paths)) {
      if (path.startsWith("/auth/") || INTERNAL_OUTSIDE_AUTH.has(path)) continue;
      for (const op of Object.values(operations)) {
        expect(op["x-internal"], path).toBeUndefined();
        expect(op.security, path).toBeUndefined();
      }
    }
  });
});
