import { describe, expect, it } from "vitest";
import { isAdsPlatformError } from "@fastgram/ports";

import { FakeAdsPlatform } from "./fake-ads-platform.js";

const AUTH = { accessToken: "t", adAccountId: "act_0" };

describe("FakeAdsPlatform", () => {
  it("todo lo que crea nace PAUSED", async () => {
    const fake = new FakeAdsPlatform();
    const c = await fake.createCampaign(AUTH, {
      name: "c",
      objective: "OUTCOME_TRAFFIC",
    });
    const s = await fake.createAdSet(AUTH, {
      campaignId: c.id,
      name: "s",
      dailyBudgetMinor: 100,
      objective: "OUTCOME_TRAFFIC",
      targeting: { countries: ["AR"] },
    });
    const a = await fake.createAd(AUTH, { adSetId: s.id, creativeId: "cr", name: "a" });
    expect([c.id, s.id, a.id].map((id) => fake.statusOf(id))).toEqual([
      "PAUSED",
      "PAUSED",
      "PAUSED",
    ]);
  });

  it("fallas programadas con motivo estable, una por vez", async () => {
    const fake = new FakeAdsPlatform();
    fake.failNext("setStatus", "rate_limited");
    const e = await fake.setStatus(AUTH, "x", "ACTIVE").catch((err: unknown) => err);
    expect(isAdsPlatformError(e) && e.reason).toBe("rate_limited");
    await fake.setStatus(AUTH, "x", "ACTIVE");
    expect(fake.statusOf("x")).toBe("ACTIVE");
  });

  it("insights filtrados por rango", async () => {
    const fake = new FakeAdsPlatform();
    const row = (date: string) => ({
      adId: "a",
      date,
      spendMinor: 1,
      impressions: 1,
      clicks: 0,
      reach: null,
      actions: {},
      actionValuesMinor: {},
    });
    fake.setInsights("c", [row("2026-09-01"), row("2026-09-10")]);
    const rows = await fake.getInsights(AUTH, {
      campaignId: "c",
      since: "2026-09-05",
      until: "2026-09-30",
      currency: "USD",
    });
    expect(rows.map((r) => r.date)).toEqual(["2026-09-10"]);
  });
});
