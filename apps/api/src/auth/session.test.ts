/**
 * La costura de sesión sin base: lectura del header, clasificación de fallos
 * del proveedor y el orden de `resolveScope`. Lo que necesita Postgres y Better
 * Auth de verdad está en `test/auth.int.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { PortError, type IdentityPrincipal } from "@fastgram/ports";
import type { Database } from "@fastgram/db";
import { systemClock } from "@fastgram/adapters";

import { resolveScope } from "./scope.js";
import {
  createSessionResolver,
  readSessionHeader,
  type SessionResolver,
} from "./session.js";

/** Una base que no se puede tocar: estos caminos no deberían llegar a ella. */
const noDb = new Proxy(
  {},
  {
    get() {
      throw new Error("este camino no debería tocar la base");
    },
  },
) as Database;

describe("readSessionHeader", () => {
  it("lee sólo x-fastgram-session; ausente, vacío y repetido se distinguen", () => {
    expect(readSessionHeader({})).toEqual({ kind: "absent" });
    expect(readSessionHeader({ "x-fastgram-session": "  " })).toEqual({ kind: "absent" });
    expect(readSessionHeader({ "x-fastgram-session": " tok " })).toEqual({
      kind: "present",
      token: "tok",
    });
    expect(readSessionHeader({ "x-fastgram-session": ["a", "b"] })).toEqual({
      kind: "malformed",
    });
    // Nunca de una cookie.
    expect(readSessionHeader({ cookie: "x-fastgram-session=tok" })).toEqual({
      kind: "absent",
    });
  });
});

describe("createSessionResolver", () => {
  const rejecting = (error: unknown) => ({
    verifySessionToken: (): Promise<IdentityPrincipal> => Promise.reject(error),
  });

  it("unauthorized del proveedor es `invalid`", async () => {
    const resolver = createSessionResolver({
      identity: rejecting(new PortError("unauthorized", "no", { source: "t" })),
      db: noDb,
    });
    expect(await resolver.resolve({ headers: { "x-fastgram-session": "t" } })).toEqual({
      kind: "invalid",
    });
  });

  it("cualquier otro fallo es `unavailable`, sin arrastrar el error entero", async () => {
    const resolver = createSessionResolver({
      identity: rejecting(new Error("connect ECONNREFUSED token=secreto")),
      db: noDb,
    });
    const out = await resolver.resolve({ headers: { "x-fastgram-session": "secreto" } });
    expect(out).toEqual({ kind: "unavailable", reason: "Error" });
  });

  it("sin header no llama al proveedor", async () => {
    const resolver = createSessionResolver({
      identity: {
        verifySessionToken: () => Promise.reject(new Error("no debía llamarse")),
      },
      db: noDb,
    });
    expect(await resolver.resolve({ headers: {} })).toEqual({ kind: "absent" });
  });
});

describe("resolveScope — el orden", () => {
  const spy = (): SessionResolver & { calls: number } => {
    const s = {
      calls: 0,
      async resolve() {
        s.calls++;
        return {
          kind: "valid" as const,
          principal: {
            userId: "u",
            email: "e",
            emailVerified: false,
            sessionId: "s",
            expiresAt: new Date(),
          },
          companyId: "c",
        };
      },
    };
    return s;
  };

  it("un Authorization mal formado no cae a una sesión válida", async () => {
    const sessions = spy();
    const out = await resolveScope(
      { db: noDb, clock: systemClock, sessions },
      { authorization: "Basic abc", "x-fastgram-session": "tok" },
    );
    expect(out.ok).toBe(false);
    expect(sessions.calls).toBe(0);
  });

  it("sin Authorization, la sesión válida autoriza con su companyId", async () => {
    const sessions = spy();
    const out = await resolveScope(
      { db: noDb, clock: systemClock, sessions },
      { "x-fastgram-session": "tok" },
    );
    expect(out).toEqual({
      ok: true,
      auth: { companyId: "c", kind: "session", userId: "u" },
    });
  });

  it("sesión sin workspace → session_without_workspace; invalid → session_invalid", async () => {
    const withoutWorkspace: SessionResolver = {
      resolve: async () => ({
        kind: "valid",
        principal: {
          userId: "u",
          email: "e",
          emailVerified: false,
          sessionId: "s",
          expiresAt: new Date(),
        },
        companyId: null,
      }),
    };
    const invalid: SessionResolver = { resolve: async () => ({ kind: "invalid" }) };
    const clock = systemClock;
    expect(
      await resolveScope({ db: noDb, clock, sessions: withoutWorkspace }, {}),
    ).toEqual({ ok: false, reason: "session_without_workspace" });
    expect(await resolveScope({ db: noDb, clock, sessions: invalid }, {})).toEqual({
      ok: false,
      reason: "session_invalid",
    });
  });
});
