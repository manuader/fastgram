import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { redditOutcomeFromApi, redditReturnPath } from "./callback";
import {
  percent,
  reasonKey,
  reasonOf,
  splitList,
  strongSignals,
  tierLabelKey,
} from "./present";

describe("present", () => {
  it("motivos conocidos → su copy; desconocidos → genérico", () => {
    expect(reasonKey("ban_meter_danger")).toBe("engagement.blocked.ban_meter_danger");
    expect(reasonKey("whatever")).toBe("engagement.error.generic");
    expect(reasonKey(null)).toBe("engagement.error.generic");
    const err = new ApiRequestError({
      code: "conflict",
      status: 409,
      details: { reason: "lead_locked" },
    });
    expect(reasonOf(err)).toBe("lead_locked");
    expect(reasonOf(new Error("x"))).toBeNull();
  });

  it("formatea, no decide: el ratio se muestra tal cual vino", () => {
    expect(percent(0.3)).toBe("30");
    expect(percent(null)).toBeNull();
  });

  it("etiquetas de tier", () => {
    expect(
      tierLabelKey({ tier: "top", scoreStatus: "scored", source: "discovery" }),
    ).toBe("engagement.tier.top");
    expect(tierLabelKey({ tier: null, scoreStatus: "pending", source: "manual" })).toBe(
      "engagement.tier.pending",
    );
    expect(
      tierLabelKey({ tier: null, scoreStatus: "no_judgment", source: "discovery" }),
    ).toBe("engagement.tier.unscored");
  });

  it("listas y señales", () => {
    expect(splitList("a, b\n\n c")).toEqual(["a", "b", "c"]);
    const s = strongSignals({
      buyingSignal: 0.2,
      fitToAudience: 0.9,
      hasProblem: 0.5,
      replyWelcome: 0.1,
      alreadyAnswered: 1,
    });
    expect(s[0]?.key).toBe("engagement.why.fitToAudience");
    expect(s.map((x) => x.key)).not.toContain("engagement.why.alreadyAnswered");
  });
});

describe("callback", () => {
  it("éxito → connected; error → sólo un código estable en la URL", () => {
    expect(redditOutcomeFromApi(200, { data: { username: "acme_founder" } })).toEqual({
      kind: "connected",
      username: "acme_founder",
    });
    expect(
      redditOutcomeFromApi(400, {
        error: { code: "bad_request", details: { reason: "oauth_state_wrong_brand" } },
      }),
    ).toEqual({ kind: "error", reason: "oauth_state_wrong_brand" });
    expect(redditOutcomeFromApi(502, { error: { code: "<script>" } })).toEqual({
      kind: "error",
      reason: "service_unavailable",
    });
    expect(redditReturnPath({ kind: "connected", username: "a_b" })).toBe(
      "/engagement/actions?reddit=connected&username=a_b",
    );
  });
});
