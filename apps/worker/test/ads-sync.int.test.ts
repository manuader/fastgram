/**
 * `ads-sync` contra Postgres — sprint 9 (R), `D-21`.
 *
 * Con RLS (`fastgram_app`), `app.ads_sync_brands()` real y el doble de Meta
 * (`FakeAdsPlatform`) con insights cargados por el test. Mide lo que es del
 * worker y no del caso de uso (que ya prueba `core`): qué marcas barre, que
 * descifra el token, que avisa por el notifier una sola vez, que una marca
 * rota no corta a las otras y que un token caído marca la cuenta `expired`.
 */
import { randomUUID } from "node:crypto";

import { FakeAdsPlatform } from "@fastgram/adapters/ads";
import type { NotificationDraft } from "@fastgram/core";
import {
  APP_ROLE,
  adAccounts,
  adCampaigns,
  adSets,
  ads,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";
import {
  AdsPlatformError,
  type AdInsightsQuery,
  type AdsAuth,
  type TokenCipher,
} from "@fastgram/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runAdsSync } from "../src/ads/sync-handler.js";
import type { BuildLogger } from "../src/content/build-handler.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silent: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = new Date("2026-09-28T15:00:00.000Z");

/** "Cifrado" reversible de test: lo que importa es que el worker lo descifre. */
const cipher: TokenCipher = {
  encrypt: (p) => Promise.resolve(`enc:${p}`),
  decrypt: (c) => Promise.resolve(c.replace(/^enc:/u, "")),
};

let handle: DbHandle;

beforeAll(() => {
  handle = openDb();
});

afterAll(async () => {
  await handle?.close();
});

async function seedAdsBrand(
  opts: { status?: "active" | "pending"; token?: string } = {},
) {
  const companyId = await seedCompany(handle);
  const platformCampaignId = `meta-c-${randomUUID()}`;
  const platformAdId = `meta-ad-${randomUUID()}`;
  const campaignId = await withoutCompany(handle.db, async (tx) => {
    const [account] = await tx
      .insert(adAccounts)
      .values({
        companyId,
        provider: "meta",
        status: opts.status ?? "active",
        accessToken: `enc:${opts.token ?? "tok-ok"}`,
        adAccountId: "act_123",
        currency: "USD",
        timezoneName: "UTC",
        pageId: "p-1",
      })
      .returning({ id: adAccounts.id });
    const [campaign] = await tx
      .insert(adCampaigns)
      .values({
        companyId,
        adAccountRowId: account?.id ?? "",
        name: "Reel test",
        objective: "OUTCOME_TRAFFIC",
        status: "ACTIVE",
        pausedReason: null,
        dailyCapMinor: 1_000,
        totalCapMinor: 5_000,
        currency: "USD",
        startDate: "2026-09-27",
        targeting: { countries: ["AR"] },
        platformCampaignId,
      })
      .returning({ id: adCampaigns.id });
    const [set] = await tx
      .insert(adSets)
      .values({
        companyId,
        campaignId: campaign?.id ?? "",
        name: "Reel test",
        dailyBudgetMinor: 1_000,
        platformAdSetId: `meta-as-${randomUUID()}`,
      })
      .returning({ id: adSets.id });
    await tx.insert(ads).values({
      companyId,
      campaignId: campaign?.id ?? "",
      adSetId: set?.id ?? "",
      name: "A",
      mediaKind: "video",
      message: "m",
      platformAdId,
      platformCreativeId: "cr",
    });
    return campaign?.id ?? "";
  });
  return { companyId, campaignId, platformCampaignId, platformAdId };
}

const row = (adId: string, spendMinor: number) => ({
  adId,
  date: "2026-09-28",
  spendMinor,
  impressions: 1000,
  clicks: 10,
  reach: null,
  actions: {},
  actionValuesMinor: {},
});

describe("ads-sync (worker)", () => {
  it("pausa la campaña que llegó al tope, avisa una vez y deja en paz a las otras marcas", async () => {
    const hit = await seedAdsBrand();
    const calm = await seedAdsBrand();
    const pending = await seedAdsBrand({ status: "pending" });

    const meta = new FakeAdsPlatform();
    const tokens = new Map<string, string>();
    const getInsights = meta.getInsights.bind(meta);
    meta.getInsights = (auth: AdsAuth, q: AdInsightsQuery) => {
      tokens.set(q.campaignId, auth.accessToken);
      return getInsights(auth, q);
    };
    meta.setInsights(hit.platformCampaignId, [row(hit.platformAdId, 1_200)]);
    meta.setInsights(calm.platformCampaignId, [row(calm.platformAdId, 300)]);

    const drafts: { companyId: string; draft: NotificationDraft }[] = [];
    const deps = {
      db: handle.db,
      appRole: APP_ROLE,
      clock: { now: () => NOW, nowMs: () => NOW.getTime() },
      logger: silent,
      cipher,
      platforms: { meta, fake: new FakeAdsPlatform() },
      notify: (companyId: string, draft: NotificationDraft) => {
        drafts.push({ companyId, draft });
        return Promise.resolve(true);
      },
    };

    const first = await runAdsSync(deps);
    // Negativo primero (trampa 35): la marca pendiente y la tranquila no se tocan.
    expect(drafts.some((d) => d.companyId === pending.companyId)).toBe(false);
    expect(drafts.some((d) => d.companyId === calm.companyId)).toBe(false);
    expect(meta.statusOf(calm.platformCampaignId)).toBeUndefined();

    expect(first.paused).toBeGreaterThanOrEqual(1);
    expect(tokens.get(hit.platformCampaignId)).toBe("tok-ok");
    expect(meta.statusOf(hit.platformCampaignId)).toBe("PAUSED");
    expect(drafts.filter((d) => d.companyId === hit.companyId)).toEqual([
      {
        companyId: hit.companyId,
        draft: expect.objectContaining({
          category: "ad_spend_cap",
          link: `/ads/${hit.campaignId}`,
        }) as unknown,
      },
    ]);

    const stored = await withoutCompany(handle.db, (tx) =>
      tx.query.adCampaigns.findFirst({ where: (c, { eq }) => eq(c.id, hit.campaignId) }),
    );
    expect(stored).toMatchObject({ status: "PAUSED", pausedReason: "daily_cap" });

    drafts.length = 0;
    await runAdsSync(deps);
    expect(drafts.filter((d) => d.companyId === hit.companyId)).toEqual([]);
  });

  it("un token caído marca la cuenta expired y la guardia igual evalúa lo guardado", async () => {
    const brand = await seedAdsBrand({ token: "tok-dead" });
    const meta = new FakeAdsPlatform();
    // Sólo a esta marca: la base del worker no se trunca y el barrido ve las
    // marcas de los otros tests (una falla "global" la consumiría otra).
    const getInsights = meta.getInsights.bind(meta);
    meta.getInsights = (auth: AdsAuth, q: AdInsightsQuery) =>
      q.campaignId === brand.platformCampaignId
        ? Promise.reject(new AdsPlatformError("unauthorized", "x", { source: "test" }))
        : getInsights(auth, q);
    await runAdsSync({
      db: handle.db,
      appRole: APP_ROLE,
      clock: { now: () => NOW, nowMs: () => NOW.getTime() },
      logger: silent,
      cipher,
      platforms: { meta, fake: new FakeAdsPlatform() },
      notify: () => Promise.resolve(true),
    });
    const account = await withoutCompany(handle.db, (tx) =>
      tx.query.adAccounts.findFirst({
        where: (a, { eq }) => eq(a.companyId, brand.companyId),
      }),
    );
    expect(account?.status).toBe("expired");
  });
});
