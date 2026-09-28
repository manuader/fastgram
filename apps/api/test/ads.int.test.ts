/**
 * Anuncios de punta a punta — sprint 9 (R), `D-21`.
 *
 * Postgres de verdad (RLS con `fastgram_app`) y el **doble** de Meta del modo
 * demo (`DEMO_ADS_PLATFORM`), al que el test le carga insights. Ninguna
 * llamada a Meta. Lo que se mide, en orden:
 *
 *  1. sin cuenta publicitaria no se crea nada (409 `ads_not_connected`);
 *  2. campaña A/B con dos piezas → todo PAUSED en "Meta" y en la base,
 *     diario repartido, `ad_study` pedido;
 *  3. activar sin preview / con preview vencido / con topes cambiados → 409;
 *     con preview válido → ACTIVE (y el preview no se reusa);
 *  4. subir un tope de una campaña activa exige su propio preview;
 *  5. insights falsos → sync → dashboard (pago + A/B con ganador);
 *  6. gasto de hoy ≥ tope diario → sync pausa en "Meta", marca `daily_cap`,
 *     audita `cap_pause` y deja el aviso `ad_spend_cap` (una sola vez);
 *  7. otra marca no ve nada (404).
 */
import { contents, withoutCompany } from "@fastgram/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEMO_ADS_PLATFORM } from "../src/routes/v1/ads.js";
import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const NOW = "2026-09-28T15:00:00.000Z";
const TODAY = "2026-09-28";

let api: ApiHarness;
let pieceA: string;
let pieceB: string;

const reasonOf = (res: { body: Record<string, unknown> | undefined }): unknown =>
  (errorOf(res as never).details as Record<string, unknown> | undefined)?.["reason"];

beforeAll(async () => {
  api = await startApi({ now: NOW });
  const companyId = api.data.a.companyId;
  [pieceA, pieceB] = await withoutCompany(api.handle.db, async (tx) => {
    const rows = await tx
      .insert(contents)
      .values(
        ["a", "b"].map((k) => ({
          companyId,
          type: "green-screen" as const,
          status: "CREATED" as const,
          files: [`memory://fastgram/content/${companyId}/${k}.mp4`],
          thumbnailUrl: `memory://fastgram/content/${companyId}/${k}.jpg`,
        })),
      )
      .returning({ id: contents.id });
    return rows.map((r) => r.id) as [string, string];
  });
});

afterAll(async () => {
  await api.close();
});

const body = () => ({
  name: "Reel test",
  objective: "OUTCOME_TRAFFIC",
  contentIds: [pieceA, pieceB],
  message: "Try it today",
  destinationUrl: "https://acme.example.test/",
  targeting: { countries: ["AR"], ageMin: 18, ageMax: 45 },
  dailyCapMinor: 1_000,
  totalCapMinor: 3_000,
  abTest: { metric: "ctr" },
  isTest: true,
});

describe("ads (D-21) de punta a punta con el doble de Meta", () => {
  let campaignId: string;
  let platformCampaignId: string;
  let adIds: string[];

  it("sin cuenta publicitaria → 409 ads_not_connected, y nada creado", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ads/campaigns",
      body: body(),
    });
    expect(res.status).toBe(409);
    expect(reasonOf(res)).toBe("ads_not_connected");
    expect(DEMO_ADS_PLATFORM.callsTo("createCampaign")).toHaveLength(0);

    const conn = dataOf(
      await api.request({ method: "GET", path: "/api/v1/ads/connection" }),
    );
    expect(conn["status"]).toBe("none");
  });

  it("modo demo conecta una cuenta sin gasto posible", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ads/connection/demo",
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({
      status: "active",
      demo: true,
      adAccount: { currency: "USD" },
    });
  });

  it("crea la campaña A/B con dos piezas: todo PAUSED, diario repartido, ad_study pedido", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ads/campaigns",
      body: body(),
    });
    expect(res.status).toBe(201);
    const detail = dataOf(res) as {
      campaign: { id: string; status: string; pausedReason: string; isTest: boolean };
      adSets: { variantLabel: string; dailyBudgetMinor: number }[];
      ads: unknown[];
      experiment: { status: string; platformStudy: boolean };
    };
    campaignId = detail.campaign.id;
    expect(detail.campaign).toMatchObject({
      status: "PAUSED",
      pausedReason: "created",
      isTest: true,
    });
    expect(detail.adSets.map((s) => [s.variantLabel, s.dailyBudgetMinor])).toEqual([
      ["A", 500],
      ["B", 500],
    ]);
    expect(detail.ads).toHaveLength(2);
    expect(detail.experiment).toMatchObject({
      status: "insufficient_data",
      platformStudy: true,
    });

    // En "Meta": todo lo creado está pausado.
    const created = [...DEMO_ADS_PLATFORM.objects.values()].filter((o) =>
      ["campaign", "adset", "ad"].includes(o.kind),
    );
    expect(created.length).toBe(5);
    expect(created.every((o) => o.status === "PAUSED")).toBe(true);
    platformCampaignId = created.find((o) => o.kind === "campaign")?.id ?? "";
    adIds = created.filter((o) => o.kind === "ad").map((o) => o.id);
    expect(DEMO_ADS_PLATFORM.callsTo("createSplitTest")).toHaveLength(1);
  });

  it("activar sin preview → 409 preview_required", async () => {
    const res = await api.request({
      method: "POST",
      path: `/api/v1/ads/campaigns/${campaignId}/activate`,
      body: { confirmationToken: "no-existe" },
    });
    expect(res.status).toBe(409);
    expect(reasonOf(res)).toBe("preview_required");
    expect(DEMO_ADS_PLATFORM.statusOf(platformCampaignId)).toBe("PAUSED");
  });

  it("el preview muestra el gasto máximo; vencido → 409 preview_expired", async () => {
    const preview = dataOf(
      await api.request({
        method: "POST",
        path: `/api/v1/ads/campaigns/${campaignId}/activation-preview`,
        body: { action: "activate" },
      }),
    ) as { token: string; maxSpendMinor: number; bindingCap: string; demo: boolean };
    expect(preview).toMatchObject({
      maxSpendMinor: 3_000,
      bindingCap: "total",
      demo: true,
    });

    api.clock.advanceMs(5 * 60_000 + 1);
    const res = await api.request({
      method: "POST",
      path: `/api/v1/ads/campaigns/${campaignId}/activate`,
      body: { confirmationToken: preview.token },
    });
    expect(res.status).toBe(409);
    expect(reasonOf(res)).toBe("preview_expired");
    api.clock.set(NOW);
  });

  it("topes cambiados después del preview → 409 preview_mismatch", async () => {
    const preview = dataOf(
      await api.request({
        method: "POST",
        path: `/api/v1/ads/campaigns/${campaignId}/activation-preview`,
        body: { action: "activate" },
      }),
    ) as { token: string };
    // Bajar un tope de una campaña pausada no pide confirmación.
    const lower = await api.request({
      method: "PATCH",
      path: `/api/v1/ads/campaigns/${campaignId}/budget`,
      body: { dailyCapMinor: 1_000, totalCapMinor: 2_500 },
    });
    expect(lower.status).toBe(200);
    const res = await api.request({
      method: "POST",
      path: `/api/v1/ads/campaigns/${campaignId}/activate`,
      body: { confirmationToken: preview.token },
    });
    expect(res.status).toBe(409);
    expect(reasonOf(res)).toBe("preview_mismatch");
  });

  it("con preview válido y reciente → ACTIVE en la base y en Meta", async () => {
    const preview = dataOf(
      await api.request({
        method: "POST",
        path: `/api/v1/ads/campaigns/${campaignId}/activation-preview`,
        body: { action: "activate" },
      }),
    ) as { token: string; maxSpendMinor: number };
    expect(preview.maxSpendMinor).toBe(2_500);
    const res = await api.request({
      method: "POST",
      path: `/api/v1/ads/campaigns/${campaignId}/activate`,
      body: { confirmationToken: preview.token },
    });
    expect(res.status).toBe(200);
    expect((dataOf(res) as { campaign: { status: string } }).campaign.status).toBe(
      "ACTIVE",
    );
    expect(DEMO_ADS_PLATFORM.statusOf(platformCampaignId)).toBe("ACTIVE");
    for (const id of adIds) expect(DEMO_ADS_PLATFORM.statusOf(id)).toBe("ACTIVE");

    const actions = (
      dataOf(res) as { actions: { kind: string; maxSpendMinor: number | null }[] }
    ).actions;
    expect(actions.find((a) => a.kind === "activate")?.maxSpendMinor).toBe(2_500);
  });

  it("subir un tope de una campaña activa exige su preview de budget_increase", async () => {
    const raise = { dailyCapMinor: 1_200, totalCapMinor: 3_000 };
    const denied = await api.request({
      method: "PATCH",
      path: `/api/v1/ads/campaigns/${campaignId}/budget`,
      body: raise,
    });
    expect(denied.status).toBe(409);
    expect(reasonOf(denied)).toBe("preview_required");

    const preview = dataOf(
      await api.request({
        method: "POST",
        path: `/api/v1/ads/campaigns/${campaignId}/activation-preview`,
        body: { action: "budget_increase", ...raise },
      }),
    ) as { token: string };
    const ok = await api.request({
      method: "PATCH",
      path: `/api/v1/ads/campaigns/${campaignId}/budget`,
      body: { ...raise, confirmationToken: preview.token },
    });
    expect(ok.status).toBe(200);
    const d = dataOf(ok) as { adSets: { dailyBudgetMinor: number }[] };
    expect(d.adSets.map((s) => s.dailyBudgetMinor)).toEqual([600, 600]);
    // Y el mismo token no sirve dos veces.
    const again = await api.request({
      method: "PATCH",
      path: `/api/v1/ads/campaigns/${campaignId}/budget`,
      body: {
        dailyCapMinor: 1_300,
        totalCapMinor: 3_000,
        confirmationToken: preview.token,
      },
    });
    expect(again.status).toBe(409);
    expect(["preview_used", "preview_mismatch"]).toContain(reasonOf(again));
  });

  it("desconectar con una campaña activa → 409 active_campaigns", async () => {
    const res = await api.request({ method: "DELETE", path: "/api/v1/ads/connection" });
    expect(res.status).toBe(409);
    expect(reasonOf(res)).toBe("active_campaigns");
  });

  it("insights falsos → sync → dashboard con pago y el A/B con ganador", async () => {
    const [adA, adB] = adIds as [string, string];
    const row = (adId: string, clicks: number, spendMinor: number) => ({
      adId,
      date: TODAY,
      spendMinor,
      impressions: 3_000,
      clicks,
      reach: 2_500,
      actions: { link_click: clicks },
      actionValuesMinor: {},
    });
    DEMO_ADS_PLATFORM.setInsights(platformCampaignId, [
      row(adA, 30, 400),
      row(adB, 90, 400),
    ]);

    const sync = await api.request({ method: "POST", path: "/api/v1/ads/sync" });
    expect(dataOf(sync)).toEqual({
      synced: 1,
      paused: 0,
      pauseFailed: 0,
      errors: 0,
      stoppedEarly: null,
    });

    const dash = dataOf(
      await api.request({ method: "GET", path: "/api/v1/ads/dashboard?days=7" }),
    ) as {
      paid: {
        metrics: { spendMinor: number; clicks: number; ctr: number; results: number };
      };
      experiments: { status: string; winnerLabel: string | null }[];
      organic: { posts: number };
      currency: string;
    };
    expect(dash.currency).toBe("USD");
    expect(dash.paid.metrics).toMatchObject({
      spendMinor: 800,
      clicks: 120,
      results: 120,
    });
    expect(dash.paid.metrics.ctr).toBeCloseTo(0.02, 5);
    expect(dash.experiments).toEqual([
      expect.objectContaining({ status: "winner", winnerLabel: "B" }),
    ]);
    expect(dash.organic.posts).toBeGreaterThanOrEqual(0);
  });

  it("gasto de hoy ≥ tope diario → la guardia pausa, audita y avisa una sola vez", async () => {
    const [adA, adB] = adIds as [string, string];
    const row = (adId: string, spendMinor: number) => ({
      adId,
      date: TODAY,
      spendMinor,
      impressions: 5_000,
      clicks: 50,
      reach: null,
      actions: {},
      actionValuesMinor: {},
    });
    DEMO_ADS_PLATFORM.setInsights(platformCampaignId, [row(adA, 650), row(adB, 600)]);

    const sync = dataOf(await api.request({ method: "POST", path: "/api/v1/ads/sync" }));
    expect(sync).toMatchObject({ synced: 1, paused: 1, pauseFailed: 0 });
    expect(DEMO_ADS_PLATFORM.statusOf(platformCampaignId)).toBe("PAUSED");

    const detail = dataOf(
      await api.request({ method: "GET", path: `/api/v1/ads/campaigns/${campaignId}` }),
    ) as {
      campaign: { status: string; pausedReason: string; spentTodayMinor: number };
      actions: { kind: string; actor: string; reason: string | null }[];
    };
    expect(detail.campaign).toMatchObject({
      status: "PAUSED",
      pausedReason: "daily_cap",
      spentTodayMinor: 1_250,
    });
    expect(detail.actions).toContainEqual(
      expect.objectContaining({ kind: "cap_pause", actor: "guard", reason: "daily_cap" }),
    );

    const again = dataOf(await api.request({ method: "POST", path: "/api/v1/ads/sync" }));
    expect(again).toMatchObject({ paused: 0 });

    // Query API relacional: `drizzle-orm` no es dependencia de `apps/api`.
    const rows = await withoutCompany(api.handle.db, (tx) =>
      tx.query.notifications.findMany({
        where: (n, { and, eq }) =>
          and(eq(n.companyId, api.data.a.companyId), eq(n.category, "ad_spend_cap")),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "warning", link: `/ads/${campaignId}` });
  });

  it("otra marca no ve la campaña ni su conexión", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/ads/campaigns/${campaignId}`,
      token: api.data.b.token,
    });
    expect(res.status).toBe(404);
    const list = dataOf(
      await api.request({
        method: "GET",
        path: "/api/v1/ads/campaigns",
        token: api.data.b.token,
      }),
    );
    expect(list).toEqual([]);
    const conn = dataOf(
      await api.request({
        method: "GET",
        path: "/api/v1/ads/connection",
        token: api.data.b.token,
      }),
    );
    expect(conn["status"]).toBe("none");
  });

  it("con todo pausado se puede desconectar (y el token se borra)", async () => {
    const res = await api.request({ method: "DELETE", path: "/api/v1/ads/connection" });
    expect(res.status).toBe(204);
    const conn = dataOf(
      await api.request({ method: "GET", path: "/api/v1/ads/connection" }),
    );
    expect(conn["status"]).toBe("revoked");
  });
});
