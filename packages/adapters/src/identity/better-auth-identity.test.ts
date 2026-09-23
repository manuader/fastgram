/**
 * `BetterAuthIdentity` sin base: configuración, guardas previas a Better Auth y
 * la traducción de errores cuando Postgres no responde. Lo que necesita una base
 * real está en `better-auth-identity.int.test.ts`.
 */

import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { isPortError, type PortError } from "@fastgram/ports";

import {
  BetterAuthIdentity,
  SSO_NOT_CONFIGURED_MESSAGE,
  type BetterAuthIdentityConfig,
} from "./better-auth-identity.js";

// Un puerto donde no escucha nadie: conexión rechazada en el acto, sin red.
const deadPool = new pg.Pool({
  connectionString: "postgres://nobody:nothing@127.0.0.1:1/none",
  connectionTimeoutMillis: 2_000,
  max: 1,
});

afterAll(async () => {
  await deadPool.end();
});

function config(
  overrides: Partial<BetterAuthIdentityConfig> = {},
): BetterAuthIdentityConfig {
  return {
    pool: deadPool,
    secret: randomBytes(32).toString("base64url"),
    baseUrl: "http://localhost:3000",
    sendPasswordResetEmail: async () => {},
    // `error` y no menos: el logger de Better Auth escribe el fallo de conexión
    // del chequeo de esquema, y eso es justo lo que se está provocando.
    logLevel: "error",
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<PortError> {
  const outcome = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (outcome === null) throw new Error("no lanzó");
  if (!isPortError(outcome)) throw new Error(`no es PortError: ${String(outcome)}`);
  return outcome;
}

describe("BetterAuthIdentity — configuración requerida, sin defaults", () => {
  it("rechaza un secreto corto, vacío o el placeholder público de Better Auth", () => {
    for (const secret of ["", "corto", "better-auth-secret-123456789"]) {
      expect(() => new BetterAuthIdentity(config({ secret }))).toThrow(
        /BETTER_AUTH_SECRET/,
      );
    }
  });

  it("el mensaje de error no incluye el valor del secreto", () => {
    const secret = "s".repeat(20);
    expect(() => new BetterAuthIdentity(config({ secret }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) as string }),
    );
  });

  it("rechaza una baseUrl vacía o relativa", () => {
    for (const baseUrl of ["", "/api/auth", "localhost:3000"]) {
      expect(() => new BetterAuthIdentity(config({ baseUrl }))).toThrow(
        /BETTER_AUTH_URL/,
      );
    }
  });

  it("exige el callback de envío del email de recuperación", () => {
    const broken = {
      ...config(),
      sendPasswordResetEmail: undefined,
    } as unknown as BetterAuthIdentityConfig;
    expect(() => new BetterAuthIdentity(broken)).toThrow(/sendPasswordResetEmail/);
  });
});

describe("BetterAuthIdentity — guardas que no llegan a la base", () => {
  const identity = new BetterAuthIdentity(config());

  it("token vacío o con caracteres de cookie es unauthorized", async () => {
    for (const token of ["", "a;b", "a b", "a\r\nb", "x".repeat(600)]) {
      expect((await rejection(identity.verifySessionToken(token))).code).toBe(
        "unauthorized",
      );
    }
  });

  it("ids que no son uuid: getUser null, revoke y delete idempotentes", async () => {
    expect(await identity.getUser("usuario-que-no-existe-0000")).toBeNull();
    await expect(identity.revokeSession("sesion-que-no-existe")).resolves.toBeUndefined();
    await expect(identity.deleteUser("usuario-que-no-existe")).resolves.toBeUndefined();
  });

  it("SSO: sin state o con redirectUri relativa es bad_request, y sin proveedor también", async () => {
    const noState = await rejection(
      identity.createAuthorizationUrl({
        provider: "google",
        redirectUri: "https://example.invalid/cb",
        state: "",
      }),
    );
    expect(noState.code).toBe("bad_request");

    const relative = await rejection(
      identity.createAuthorizationUrl({
        provider: "google",
        redirectUri: "/cb",
        state: "s",
      }),
    );
    expect(relative.code).toBe("bad_request");

    const valid = await rejection(
      identity.createAuthorizationUrl({
        provider: "google",
        redirectUri: "https://example.invalid/cb",
        state: "s",
      }),
    );
    expect(valid.toPublic()).toEqual({
      code: "bad_request",
      message: SSO_NOT_CONFIGURED_MESSAGE,
    });
  });
});

describe("BetterAuthIdentity — Postgres caído", () => {
  const identity = new BetterAuthIdentity(config());

  it("verifySessionToken es provider_unavailable, con el error crudo sólo en `cause`", async () => {
    const error = await rejection(identity.verifySessionToken("abc.def"));
    expect(error.code).toBe("provider_unavailable");
    expect(error.message).toBe("Authentication is temporarily unavailable");
    expect(error.message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|postgres/i);
    expect(error.cause).toBeDefined();
  });

  it("el alta es provider_unavailable, no bad_request ni conflict", async () => {
    const error = await rejection(
      identity.signUpWithPassword({
        email: "x@example.test",
        password: "long-enough-password",
        fullName: "Xx",
      }),
    );
    expect(error.code).toBe("provider_unavailable");
  });

  it("getUser de un uuid es provider_unavailable, no null (null diría «no existe»)", async () => {
    const error = await rejection(
      identity.getUser("00000000-0000-4000-8000-000000000000"),
    );
    expect(error.code).toBe("provider_unavailable");
  });
});
