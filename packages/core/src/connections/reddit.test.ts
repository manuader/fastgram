import { describe, expect, it } from "vitest";
import type { StateSigner } from "@fastgram/ports";

import {
  REDDIT_OAUTH,
  issueRedditState,
  normalizeRedditUsername,
  redditRedirectUri,
  redditTokenNeedsRefresh,
  redditUserAgent,
  verifyRedditState,
} from "./reddit.js";

const signer: StateSigner = {
  sign: (data) =>
    Promise.resolve(Buffer.from(`mac:${data}`).toString("base64url").slice(-24)),
};
const now = new Date("2026-09-24T12:00:00Z");
const brand = "11111111-1111-4111-8111-111111111111";

describe("OAuth de Reddit (F-190)", () => {
  it("scopes mínimos verificados y User-Agent del formato documentado", () => {
    expect(REDDIT_OAUTH.scopes).toEqual(["identity", "read", "submit"]);
    expect(redditUserAgent("someone")).toBe(
      "web:fastgram-engagement:0.1.0 (by /u/someone)",
    );
    expect(redditRedirectUri("http://localhost:3000/")).toBe(
      "http://localhost:3000/engagement/reddit/callback",
    );
    expect(normalizeRedditUsername("u/Some_User")).toBe("Some_User");
    expect(normalizeRedditUsername("a b")).toBeNull();
  });

  it("refresca dentro del margen de 5 min del token de 1 h", () => {
    expect(redditTokenNeedsRefresh(new Date(now.getTime() + 60 * 60 * 1000), now)).toBe(
      false,
    );
    expect(redditTokenNeedsRefresh(new Date(now.getTime() + 4 * 60 * 1000), now)).toBe(
      true,
    );
    expect(redditTokenNeedsRefresh(null, now)).toBe(true);
  });

  it("state: firma, marca y vencimiento", async () => {
    const { state } = await issueRedditState(signer, {
      companyId: brand,
      nonce: "n1",
      now,
    });
    expect(await verifyRedditState(signer, { state, companyId: brand, now })).toEqual({
      ok: true,
      nonce: "n1",
    });
    expect(
      await verifyRedditState(signer, {
        state,
        companyId: "22222222-2222-4222-8222-222222222222",
        now,
      }),
    ).toEqual({ ok: false, reason: "wrong_brand" });
    const later = new Date(now.getTime() + 11 * 60 * 1000);
    expect(
      await verifyRedditState(signer, { state, companyId: brand, now: later }),
    ).toEqual({
      ok: false,
      reason: "expired",
    });
    const [v, body] = state.split(".");
    expect(
      await verifyRedditState(signer, {
        state: `${v}.${body}.forged`,
        companyId: brand,
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(
      await verifyRedditState(signer, { state: "garbage", companyId: brand, now }),
    ).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
