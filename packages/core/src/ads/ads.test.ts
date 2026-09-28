import { describe, expect, it } from "vitest";
import {
  AdsPlatformError,
  type AdInsightRow,
  type AdsAuth,
  type AdsPlatform,
  type AdRunStatus,
} from "@fastgram/ports";

import {
  ACTIVATION_PREVIEW_TTL_MS,
  checkConfirmation,
  type StoredActivationPreview,
} from "./activation.js";
import {
  budgetChangeAllowed,
  capsIncrease,
  maxPossibleSpend,
  splitDailyBudget,
  validateCaps,
} from "./caps.js";
import {
  AB_MIN_IMPRESSIONS,
  evaluateAbTest,
  twoProportionZ,
  type AbVariantStats,
} from "./experiment.js";
import {
  capBreachOf,
  dateInZone,
  syncAndGuard,
  type AdsSyncStore,
  type CapBreach,
  type GuardCampaign,
  type StoredInsight,
} from "./guard.js";
import { derivedAdMetrics, sumAdInsights } from "./metrics.js";
import { currencyOffset, majorToMinor } from "./money.js";
import { describeAdCapEvent } from "./notification.js";

const NOW = new Date("2026-09-28T15:00:00.000Z");
const caps = { dailyCapMinor: 1_000, totalCapMinor: 5_000 };

describe("plata", () => {
  it("offset 1 para las monedas sin decimales de la doc, 100 para el resto", () => {
    expect(currencyOffset("JPY")).toBe(1);
    expect(currencyOffset("clp")).toBe(1);
    expect(currencyOffset("USD")).toBe(100);
    expect(currencyOffset("ARS")).toBe(100);
  });

  it("el gasto de los insights (string en unidades mayores) pasa a mínimas", () => {
    expect(majorToMinor("1500.50", "USD")).toBe(150050);
    expect(majorToMinor("12.345", "USD")).toBe(1235);
    expect(majorToMinor("1500", "JPY")).toBe(1500);
    expect(majorToMinor("abc", "USD")).toBeNull();
    expect(majorToMinor("", "USD")).toBeNull();
  });
});

describe("topes", () => {
  it("diario ≤ total, los dos > 0 y enteros", () => {
    expect(validateCaps(caps)).toEqual({ ok: true });
    expect(validateCaps({ dailyCapMinor: 0, totalCapMinor: 10 })).toEqual({
      ok: false,
      problem: "daily_not_positive",
    });
    expect(validateCaps({ dailyCapMinor: 10, totalCapMinor: 0 })).toEqual({
      ok: false,
      problem: "total_not_positive",
    });
    expect(validateCaps({ dailyCapMinor: 11, totalCapMinor: 10 })).toEqual({
      ok: false,
      problem: "daily_exceeds_total",
    });
    expect(validateCaps({ dailyCapMinor: 1.5, totalCapMinor: 10 })).toEqual({
      ok: false,
      problem: "not_integer",
    });
  });

  it("el diario se reparte entre variantes y suma exacto", () => {
    expect(splitDailyBudget(1001, 2)).toEqual([501, 500]);
    expect(splitDailyBudget(1, 2)).toBeNull();
  });

  it("gasto máximo sin fin = lo que queda del total", () => {
    expect(
      maxPossibleSpend({
        caps,
        spentTotalMinor: 1_200,
        spentTodayMinor: 200,
        now: NOW,
        endTime: null,
      }),
    ).toEqual({
      maxMinor: 3_800,
      remainingTotalMinor: 3_800,
      daysLeft: null,
      bindingCap: "total",
    });
  });

  it("con fin cercano manda el diario × días (hoy cuenta lo que le queda)", () => {
    const out = maxPossibleSpend({
      caps,
      spentTotalMinor: 0,
      spentTodayMinor: 300,
      now: NOW,
      endTime: new Date(NOW.getTime() + 2 * 86_400_000),
    });
    // hoy: 1000 − 300 = 700; mañana: 1000.
    expect(out).toMatchObject({
      maxMinor: 1_700,
      daysLeft: 2,
      bindingCap: "daily_until_end",
    });
  });

  it("con fin lejano el total manda", () => {
    const out = maxPossibleSpend({
      caps,
      spentTotalMinor: 0,
      spentTodayMinor: 0,
      now: NOW,
      endTime: new Date(NOW.getTime() + 30 * 86_400_000),
    });
    expect(out).toMatchObject({ maxMinor: 5_000, bindingCap: "total" });
  });

  it("subir cualquiera de los dos topes pide confirmación; bajar no", () => {
    expect(capsIncrease(caps, { ...caps, dailyCapMinor: 1_001 })).toBe(true);
    expect(capsIncrease(caps, { ...caps, totalCapMinor: 6_000 })).toBe(true);
    expect(capsIncrease(caps, { dailyCapMinor: 900, totalCapMinor: 4_000 })).toBe(false);
  });

  it("Meta deja cambiar el presupuesto de un conjunto 4 veces por hora", () => {
    const at = (min: number) => new Date(NOW.getTime() - min * 60_000);
    expect(budgetChangeAllowed([at(5), at(10), at(20)], NOW)).toBe(true);
    expect(budgetChangeAllowed([at(5), at(10), at(20), at(59)], NOW)).toBe(false);
    expect(budgetChangeAllowed([at(5), at(10), at(20), at(61)], NOW)).toBe(true);
  });
});

describe("confirmación antes de gastar (D-21)", () => {
  const preview = (
    over: Partial<StoredActivationPreview> = {},
  ): StoredActivationPreview => ({
    campaignId: "c1",
    action: "activate",
    caps,
    maxSpendMinor: 5_000,
    expiresAt: new Date(NOW.getTime() + ACTIVATION_PREVIEW_TTL_MS),
    consumedAt: null,
    ...over,
  });
  const check = { campaignId: "c1", action: "activate" as const, caps, now: NOW };

  it("sin preview → preview_required", () => {
    expect(checkConfirmation(null, check)).toEqual({
      ok: false,
      reason: "preview_required",
    });
  });

  it("vencido → preview_expired (el borde exacto ya venció)", () => {
    expect(checkConfirmation(preview({ expiresAt: NOW }), check)).toEqual({
      ok: false,
      reason: "preview_expired",
    });
  });

  it("usado → preview_used", () => {
    expect(checkConfirmation(preview({ consumedAt: NOW }), check)).toEqual({
      ok: false,
      reason: "preview_used",
    });
  });

  it("otra campaña, otra acción o topes cambiados → preview_mismatch", () => {
    expect(checkConfirmation(preview({ campaignId: "c2" }), check).ok).toBe(false);
    expect(checkConfirmation(preview({ action: "budget_increase" }), check).ok).toBe(
      false,
    );
    expect(
      checkConfirmation(preview(), { ...check, caps: { ...caps, dailyCapMinor: 2_000 } }),
    ).toEqual({ ok: false, reason: "preview_mismatch" });
  });

  it("válido y reciente → ok con el máximo que se mostró", () => {
    expect(checkConfirmation(preview(), check)).toEqual({
      ok: true,
      maxSpendMinor: 5_000,
    });
  });
});

describe("métricas derivadas", () => {
  it("CPM, CTR, CPC, CPA y ROAS de los totales", () => {
    expect(
      derivedAdMetrics({
        spendMinor: 2_000,
        impressions: 4_000,
        clicks: 80,
        results: 4,
        resultValueMinor: 6_000,
      }),
    ).toEqual({ cpmMinor: 500, ctr: 0.02, cpcMinor: 25, cpaMinor: 500, roas: 3 });
  });

  it("denominador 0 = null, no 0", () => {
    expect(
      derivedAdMetrics({
        spendMinor: 0,
        impressions: 0,
        clicks: 0,
        results: null,
        resultValueMinor: null,
      }),
    ).toEqual({ cpmMinor: null, ctr: null, cpcMinor: null, cpaMinor: null, roas: null });
  });

  it("suma filas diarias contando el action_type de resultado", () => {
    const row = (spend: number, link: number) => ({
      spendMinor: spend,
      impressions: 100,
      clicks: 5,
      actions: { link_click: link, post_engagement: 50 },
      actionValuesMinor: {},
    });
    expect(sumAdInsights([row(100, 3), row(50, 2)], "link_click")).toEqual({
      spendMinor: 150,
      impressions: 200,
      clicks: 10,
      results: 5,
      resultValueMinor: 0,
    });
    expect(sumAdInsights([row(100, 3)], null).results).toBeNull();
  });
});

describe("regla del ganador del A/B", () => {
  const v = (id: string, impressions: number, clicks: number): AbVariantStats => ({
    variantId: id,
    impressions,
    clicks,
    results: 0,
    spendMinor: 1_000,
  });

  it("z de dos proporciones agrupado", () => {
    // 60/2000 vs 30/2000: p = 0,0225; se ≈ 0,004690; z ≈ 3,198.
    expect(twoProportionZ(60, 2000, 30, 2000)).toBeCloseTo(3.198, 2);
    expect(twoProportionZ(0, 0, 1, 10)).toBeNull();
  });

  it("con poca muestra no hay ganador aunque el CTR sea el doble", () => {
    const out = evaluateAbTest([v("a", 500, 20), v("b", 500, 10)], "ctr");
    expect(out.status).toBe("insufficient_data");
    expect(out.winnerVariantId).toBeNull();
    expect(out.leaderVariantId).toBe("a");
  });

  it("con muestra pero sin significancia → no_winner_yet", () => {
    const out = evaluateAbTest([v("a", 2000, 44), v("b", 2000, 36)], "ctr");
    expect(out.status).toBe("no_winner_yet");
    expect(out.minZ).not.toBeNull();
    expect(out.minZ as number).toBeLessThan(1.96);
  });

  it("con muestra y z ≥ 1,96 contra todas → winner", () => {
    const out = evaluateAbTest([v("a", 2000, 30), v("b", 2000, 60)], "ctr");
    expect(out).toMatchObject({ status: "winner", winnerVariantId: "b" });
  });

  it("el umbral de impresiones es por variante", () => {
    const out = evaluateAbTest(
      [v("a", AB_MIN_IMPRESSIONS - 1, 100), v("b", 5000, 20)],
      "ctr",
    );
    expect(out.status).toBe("insufficient_data");
  });

  it("CVR usa resultados, no clics", () => {
    const r = (id: string, results: number): AbVariantStats => ({
      variantId: id,
      impressions: 3000,
      clicks: 500,
      results,
      spendMinor: 1000,
    });
    expect(evaluateAbTest([r("a", 25), r("b", 70)], "cvr").winnerVariantId).toBe("b");
  });

  it("con una sola variante no hay experimento", () => {
    expect(evaluateAbTest([v("a", 5000, 100)], "ctr").status).toBe("insufficient_data");
  });
});

/* ------------------------------------------------------------------------ *
 * Guardia: dobles del store y de la plataforma
 * ------------------------------------------------------------------------ */

class MemoryStore implements AdsSyncStore {
  readonly insights = new Map<string, StoredInsight[]>();
  readonly paused: { id: string; breach: CapBreach }[] = [];
  readonly pauseFailures: { id: string; reason: string }[] = [];
  readonly syncErrors = new Map<string, string | null>();
  constructor(public campaigns: GuardCampaign[]) {}

  listCampaigns() {
    return Promise.resolve(this.campaigns);
  }
  saveInsights(campaignId: string, rows: readonly StoredInsight[]) {
    const byKey = new Map(
      (this.insights.get(campaignId) ?? []).map((r) => [`${r.adId}|${r.date}`, r]),
    );
    for (const r of rows) byKey.set(`${r.adId}|${r.date}`, r);
    this.insights.set(campaignId, [...byKey.values()]);
    return Promise.resolve();
  }
  spendOf(campaignId: string, today: string) {
    const rows = this.insights.get(campaignId) ?? [];
    return Promise.resolve({
      todayMinor: rows
        .filter((r) => r.date === today)
        .reduce((a, r) => a + r.spendMinor, 0),
      totalMinor: rows.reduce((a, r) => a + r.spendMinor, 0),
    });
  }
  markCapPaused(campaignId: string, breach: CapBreach) {
    const c = this.campaigns.find((x) => x.id === campaignId);
    if (c?.status !== "ACTIVE") return Promise.resolve(false);
    this.campaigns = this.campaigns.map((x) =>
      x.id === campaignId ? { ...x, status: "PAUSED" as const, pausedAt: NOW } : x,
    );
    this.paused.push({ id: campaignId, breach });
    return Promise.resolve(true);
  }
  recordPauseFailure(campaignId: string, _b: CapBreach, reason: string) {
    this.pauseFailures.push({ id: campaignId, reason });
    return Promise.resolve();
  }
  markSynced(campaignId: string, _at: Date, error: string | null) {
    this.syncErrors.set(campaignId, error);
    return Promise.resolve();
  }
}

function platformWith(opts: {
  insights: AdInsightRow[];
  insightsError?: AdsPlatformError;
  pauseError?: AdsPlatformError;
}): AdsPlatform & { statusCalls: [string, AdRunStatus][] } {
  const statusCalls: [string, AdRunStatus][] = [];
  const nope = () => Promise.reject(new Error("no usado"));
  return {
    statusCalls,
    listAdAccounts: nope,
    listPages: nope,
    whoAmI: nope,
    createCampaign: nope,
    createAdSet: nope,
    uploadVideo: nope,
    uploadImage: nope,
    createCreative: nope,
    createAd: nope,
    createSplitTest: nope,
    updateAdSetDailyBudget: nope,
    getInsights: () =>
      opts.insightsError === undefined
        ? Promise.resolve(opts.insights)
        : Promise.reject(opts.insightsError),
    setStatus: (_auth: AdsAuth, id: string, status: AdRunStatus) => {
      if (opts.pauseError !== undefined) return Promise.reject(opts.pauseError);
      statusCalls.push([id, status]);
      return Promise.resolve();
    },
  };
}

const auth: AdsAuth = { accessToken: "t", adAccountId: "act_1" };
const campaign = (over: Partial<GuardCampaign> = {}): GuardCampaign => ({
  id: "c1",
  name: "Reel test",
  status: "ACTIVE",
  platformCampaignId: "meta-c1",
  caps,
  startDate: "2026-09-25",
  pausedAt: null,
  adIdByPlatformId: { "meta-ad-1": "ad1", "meta-ad-2": "ad2" },
  ...over,
});
const row = (adId: string, date: string, spendMinor: number): AdInsightRow => ({
  adId,
  date,
  spendMinor,
  impressions: 1000,
  clicks: 10,
  reach: null,
  actions: {},
  actionValuesMinor: {},
});

describe("guardia de topes (corte automático)", () => {
  it("dentro del tope no toca nada", async () => {
    const store = new MemoryStore([campaign()]);
    const platform = platformWith({ insights: [row("meta-ad-1", "2026-09-28", 400)] });
    const out = await syncAndGuard({
      store,
      platform,
      auth,
      now: NOW,
      timeZone: "UTC",
      currency: "USD",
    });
    expect(out.events).toEqual([]);
    expect(platform.statusCalls).toEqual([]);
    expect(out.synced).toBe(1);
  });

  it("gasto de hoy ≥ diario → pausa la campaña en Meta, la marca y avisa una vez", async () => {
    const store = new MemoryStore([campaign()]);
    const platform = platformWith({
      insights: [
        row("meta-ad-1", "2026-09-28", 600),
        row("meta-ad-2", "2026-09-28", 400),
      ],
    });
    const out = await syncAndGuard({
      store,
      platform,
      auth,
      now: NOW,
      timeZone: "UTC",
      currency: "USD",
    });
    expect(platform.statusCalls).toEqual([["meta-c1", "PAUSED"]]);
    expect(store.paused).toEqual([{ id: "c1", breach: "daily_cap" }]);
    expect(out.events).toEqual([
      {
        campaignId: "c1",
        campaignName: "Reel test",
        breach: "daily_cap",
        spentMinor: 1_000,
        capMinor: 1_000,
        paused: true,
        day: "2026-09-28",
      },
    ]);
    // La vuelta siguiente la ve pausada: no hay segundo aviso.
    const again = await syncAndGuard({
      store,
      platform,
      auth,
      now: NOW,
      timeZone: "UTC",
      currency: "USD",
    });
    expect(again.events).toEqual([]);
  });

  it("gasto total ≥ tope total gana sobre el diario", async () => {
    const store = new MemoryStore([campaign()]);
    const platform = platformWith({
      insights: ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"].map((d) =>
        row("meta-ad-1", d, 1_250),
      ),
    });
    const out = await syncAndGuard({
      store,
      platform,
      auth,
      now: NOW,
      timeZone: "UTC",
      currency: "USD",
    });
    expect(out.events[0]).toMatchObject({ breach: "total_cap", spentMinor: 5_000 });
  });

  it("si Meta rechaza la pausa, avisa igual (con paused=false) y la deja ACTIVE", async () => {
    const store = new MemoryStore([campaign()]);
    const platform = platformWith({
      insights: [row("meta-ad-1", "2026-09-28", 1_500)],
      pauseError: new AdsPlatformError("provider_unavailable", "x", { source: "t" }),
    });
    const out = await syncAndGuard({
      store,
      platform,
      auth,
      now: NOW,
      timeZone: "UTC",
      currency: "USD",
    });
    expect(out.events).toEqual([expect.objectContaining({ paused: false })]);
    expect(store.pauseFailures).toEqual([{ id: "c1", reason: "provider_unavailable" }]);
    expect(store.campaigns[0]?.status).toBe("ACTIVE");
  });

  it("un sync caído no apaga la guardia: evalúa con lo último guardado", async () => {
    const store = new MemoryStore([campaign()]);
    await store.saveInsights("c1", [{ ...row("x", "2026-09-28", 1_200), adId: "ad1" }]);
    const platform = platformWith({
      insights: [],
      insightsError: new AdsPlatformError("provider_unavailable", "x", { source: "t" }),
    });
    const out = await syncAndGuard({
      store,
      platform,
      auth,
      now: NOW,
      timeZone: "UTC",
      currency: "USD",
    });
    expect(out.errors).toEqual([{ campaignId: "c1", reason: "provider_unavailable" }]);
    expect(out.events).toEqual([expect.objectContaining({ paused: true })]);
  });

  it("token caído o límite de Meta cortan los syncs que siguen, no la guardia", async () => {
    const store = new MemoryStore([
      campaign(),
      campaign({ id: "c2", platformCampaignId: "m2" }),
    ]);
    const platform = platformWith({
      insights: [],
      insightsError: new AdsPlatformError("rate_limited", "x", { source: "t" }),
    });
    const out = await syncAndGuard({
      store,
      platform,
      auth,
      now: NOW,
      timeZone: "UTC",
      currency: "USD",
    });
    expect(out.stoppedEarly).toBe("rate_limited");
    expect(out.errors).toHaveLength(1);
  });

  it("anuncios que no son nuestros no se guardan", async () => {
    const store = new MemoryStore([campaign()]);
    const platform = platformWith({ insights: [row("ajeno", "2026-09-28", 50)] });
    await syncAndGuard({
      store,
      platform,
      auth,
      now: NOW,
      timeZone: "UTC",
      currency: "USD",
    });
    expect(store.insights.get("c1")).toEqual([]);
  });

  it("'hoy' es el de la zona de la cuenta", () => {
    // 15:00 UTC del 28 es la madrugada del 29 en Auckland.
    expect(dateInZone(NOW, "Pacific/Auckland")).toBe("2026-09-29");
    expect(dateInZone(NOW, "America/Argentina/Buenos_Aires")).toBe("2026-09-28");
    expect(dateInZone(NOW, "No/Existe")).toBe("2026-09-28");
  });

  it("capBreachOf: ≥ corta, < no", () => {
    expect(capBreachOf(caps, 999, 999)).toBeNull();
    expect(capBreachOf(caps, 1_000, 1_000)).toBe("daily_cap");
    expect(capBreachOf(caps, 0, 5_000)).toBe("total_cap");
  });

  it("el aviso: categoría ad_spend_cap, link a la campaña y clave por día", () => {
    const draft = describeAdCapEvent(
      "Acme",
      {
        campaignId: "c1",
        campaignName: "Reel test",
        breach: "daily_cap",
        spentMinor: 1_050,
        capMinor: 1_000,
        paused: true,
        day: "2026-09-28",
      },
      "USD",
    );
    expect(draft).toMatchObject({
      category: "ad_spend_cap",
      severity: "warning",
      link: "/ads/c1",
      dedupeKey: "ad_cap:c1:daily_cap:2026-09-28:paused",
    });
    expect(draft.body).toContain("$10.50");
  });
});
