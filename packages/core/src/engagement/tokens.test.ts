import { describe, expect, it } from "vitest";
import { PortError, type TokenCipher } from "@fastgram/ports";

import { resolveRedditAccessToken, type StoredRedditTokens } from "./tokens.js";

const cipher: TokenCipher = {
  encrypt: (p) => Promise.resolve(`enc(${p})`),
  decrypt: (c) => Promise.resolve(c.replace(/^enc\((.*)\)$/, "$1")),
};
const now = new Date("2026-09-24T12:00:00Z");
const row = (over: Partial<StoredRedditTokens> = {}): StoredRedditTokens => ({
  status: "active",
  accessToken: "enc(AT)",
  refreshToken: "enc(RT)",
  tokenExpiry: new Date(now.getTime() + 30 * 60_000),
  ...over,
});

function harness(
  refresh: () => Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
  }>,
) {
  const saved: unknown[] = [];
  const expired: string[] = [];
  return {
    saved,
    expired,
    deps: {
      cipher,
      now,
      refresh,
      save: (u: unknown) => {
        saved.push(u);
        return Promise.resolve();
      },
      markExpired: (r: string) => {
        expired.push(r);
        return Promise.resolve();
      },
    },
  };
}

describe("resolveRedditAccessToken", () => {
  it("vigente: descifra sin refrescar", async () => {
    const h = harness(() => Promise.reject(new Error("no debería refrescar")));
    expect(await resolveRedditAccessToken({ ...h.deps, row: row() })).toEqual({
      ok: true,
      accessToken: "AT",
      refreshed: false,
    });
  });

  it("por vencer: refresca, cifra y guarda (sin pisar el refresh si no cambió)", async () => {
    const h = harness(() =>
      Promise.resolve({ accessToken: "AT2", refreshToken: "RT", expiresAt: null }),
    );
    const r = await resolveRedditAccessToken({
      ...h.deps,
      row: row({ tokenExpiry: new Date(now.getTime() + 60_000) }),
    });
    expect(r).toEqual({ ok: true, accessToken: "AT2", refreshed: true });
    expect(h.saved).toEqual([{ accessToken: "enc(AT2)", tokenExpiry: null }]);
  });

  it("refresh rechazado → expired y reconectar; caído → unavailable sin marcar", async () => {
    const h = harness(() =>
      Promise.reject(new PortError("unauthorized", "x", { source: "t" })),
    );
    expect(
      await resolveRedditAccessToken({ ...h.deps, row: row({ tokenExpiry: null }) }),
    ).toEqual({
      ok: false,
      reason: "reconnect_required",
    });
    expect(h.expired).toEqual(["refresh_unauthorized"]);
    const h2 = harness(() =>
      Promise.reject(new PortError("timeout", "x", { source: "t" })),
    );
    expect(
      await resolveRedditAccessToken({ ...h2.deps, row: row({ tokenExpiry: null }) }),
    ).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(h2.expired).toEqual([]);
  });

  it("sin cuenta o revocada: not_connected", async () => {
    const h = harness(() => Promise.reject(new Error("no")));
    expect((await resolveRedditAccessToken({ ...h.deps, row: null })).ok).toBe(false);
    expect(
      await resolveRedditAccessToken({ ...h.deps, row: row({ status: "revoked" }) }),
    ).toEqual({
      ok: false,
      reason: "not_connected",
    });
  });
});
