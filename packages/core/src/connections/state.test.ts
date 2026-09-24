import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  OAuthPendingAuthorization,
  OAuthStateLedger,
  StateSigner,
} from "@fastgram/ports";

import { OAUTH_STATE_TTL_MS, consumeOAuthState, issueOAuthState } from "./state.js";

const signerWith = (key: string): StateSigner => ({
  sign: (data) =>
    Promise.resolve(createHmac("sha256", key).update(data).digest("base64url")),
});

class MapLedger implements OAuthStateLedger {
  readonly entries = new Map<string, OAuthPendingAuthorization>();
  put(nonce: string, entry: OAuthPendingAuthorization) {
    this.entries.set(nonce, entry);
    return Promise.resolve();
  }
  take(nonce: string) {
    const e = this.entries.get(nonce) ?? null;
    this.entries.delete(nonce);
    return Promise.resolve(e);
  }
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-24T12:00:00.000Z");

function setup() {
  const deps = { signer: signerWith("k1"), ledger: new MapLedger() };
  return deps;
}

describe("state del OAuth", () => {
  it("ida y vuelta: la misma marca y plataforma lo aceptan y devuelven el verifier", async () => {
    const deps = setup();
    const state = await issueOAuthState(deps, {
      companyId: A,
      platform: "x",
      nonce: "n1",
      now: NOW,
      codeVerifier: "verifier-123",
    });
    const r = await consumeOAuthState(deps, {
      state,
      companyId: A,
      platform: "x",
      now: NOW,
    });
    expect(r).toEqual({ ok: true, codeVerifier: "verifier-123" });
  });

  it("no se reusa: el segundo callback con el mismo state se rechaza", async () => {
    const deps = setup();
    const state = await issueOAuthState(deps, {
      companyId: A,
      platform: "instagram",
      nonce: "n1",
      now: NOW,
    });
    const input = { state, companyId: A, platform: "instagram" as const, now: NOW };
    expect((await consumeOAuthState(deps, input)).ok).toBe(true);
    expect(await consumeOAuthState(deps, input)).toEqual({
      ok: false,
      reason: "already_used",
    });
  });

  it("expira", async () => {
    const deps = setup();
    const state = await issueOAuthState(deps, {
      companyId: A,
      platform: "tiktok",
      nonce: "n1",
      now: NOW,
    });
    const later = new Date(NOW.getTime() + OAUTH_STATE_TTL_MS);
    expect(
      await consumeOAuthState(deps, {
        state,
        companyId: A,
        platform: "tiktok",
        now: later,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("marca incorrecta → rechazo, y el nonce no se gasta", async () => {
    const deps = setup();
    const state = await issueOAuthState(deps, {
      companyId: A,
      platform: "threads",
      nonce: "n1",
      now: NOW,
    });
    expect(
      await consumeOAuthState(deps, {
        state,
        companyId: B,
        platform: "threads",
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "wrong_brand" });
    expect(
      (
        await consumeOAuthState(deps, {
          state,
          companyId: A,
          platform: "threads",
          now: NOW,
        })
      ).ok,
    ).toBe(true);
  });

  it("plataforma incorrecta → rechazo", async () => {
    const deps = setup();
    const state = await issueOAuthState(deps, {
      companyId: A,
      platform: "facebook",
      nonce: "n1",
      now: NOW,
    });
    expect(
      await consumeOAuthState(deps, { state, companyId: A, platform: "x", now: NOW }),
    ).toEqual({ ok: false, reason: "wrong_platform" });
  });

  it("alterado o firmado con otra clave → bad_signature; basura → malformed", async () => {
    const deps = setup();
    const state = await issueOAuthState(deps, {
      companyId: A,
      platform: "x",
      nonce: "n1",
      now: NOW,
    });
    const [v, payload, mac] = state.split(".") as [string, string, string];
    // Se cambia la marca del payload y se deja la firma vieja.
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        c: B,
      }),
    ).toString("base64url");
    expect(
      await consumeOAuthState(deps, {
        state: `${v}.${forged}.${mac}`,
        companyId: B,
        platform: "x",
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });

    const other = { signer: signerWith("otra"), ledger: deps.ledger };
    expect(
      await consumeOAuthState(other, { state, companyId: A, platform: "x", now: NOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });

    expect(
      await consumeOAuthState(deps, {
        state: "nope",
        companyId: A,
        platform: "x",
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
    // Nada de lo anterior gastó el nonce.
    expect(deps.ledger.entries.has("n1")).toBe(true);
  });
});
