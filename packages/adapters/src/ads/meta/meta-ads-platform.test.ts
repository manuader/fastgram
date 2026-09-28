/**
 * Marketing API de Meta contra un `fetch` falso. Cada respuesta tiene la
 * forma que muestra la doc citada al lado (consultada el 2026-09-28):
 *
 *  - creación de campaña / conjunto / anuncio → `{"id": "<ID>"}` (y
 *    `"success": true` en Ad) — referencias de Campaign, Ad Set y Ad;
 *  - `/me/adaccounts` → `{"data": [{"id": "act_…", …}]}` — Ad Account;
 *  - insights → `{"data": [{"date_start", "date_stop", "spend": "numeric
 *    string", …, "actions": [{"action_type", "value"}]}], "paging": {…}}` —
 *    Ad Account Insights ("Numeric metrics return as string");
 *  - error → `{"error": {"message", "type", "code", "error_subcode",
 *    "fbtrace_id"}}` — Graph API error handling + Marketing API error reference.
 */
import { describe, expect, it } from "vitest";
import { isAdsPlatformError, type AdsAuth, type AdsErrorReason } from "@fastgram/ports";

import { FakeFetch, bodyOf, type Reply } from "../../publishers/__tests__/fake-fetch.js";
import { MetaAdsPlatform } from "./meta-ads-platform.js";
import { regainSecondsOf } from "./meta-ads-errors.js";
import { exchangeMetaAdsCode, metaAdsAuthorizeUrl } from "./meta-ads-oauth.js";

const AUTH: AdsAuth = { accessToken: "user-token", adAccountId: "act_123" };
const G = "https://graph.facebook.com/v25.0";

const metaError = (code: number, subcode?: number, status = 400): Reply => ({
  status,
  json: {
    error: {
      message: "secret-ish message with act_123",
      type: "OAuthException",
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      fbtrace_id: "AbC",
    },
  },
});

function platform(routes: ConstructorParameters<typeof FakeFetch>[0]) {
  const fake = new FakeFetch(routes);
  return { fake, meta: new MetaAdsPlatform({ fetch: fake.fetch }) };
}

describe("MetaAdsPlatform — crear siempre en PAUSED", () => {
  it("campaña: objetivo, special_ad_categories=[] y status=PAUSED", async () => {
    const { fake, meta } = platform([
      {
        method: "POST",
        match: `${G}/act_123/campaigns`,
        replies: [{ json: { id: "c-1" } }],
      },
    ]);
    const out = await meta.createCampaign(AUTH, {
      name: "Reel test",
      objective: "OUTCOME_TRAFFIC",
    });
    expect(out).toEqual({ id: "c-1" });
    const body = bodyOf(fake.calls[0]);
    expect(body).toMatchObject({
      name: "Reel test",
      objective: "OUTCOME_TRAFFIC",
      status: "PAUSED",
      special_ad_categories: "[]",
      access_token: "user-token",
    });
    // Sin presupuesto ni spend_cap de campaña: el tope total es nuestro.
    expect(body).not.toHaveProperty("spend_cap");
    expect(body).not.toHaveProperty("daily_budget");
  });

  it("conjunto: daily_budget en unidades mínimas, targeting y PAUSED", async () => {
    const { fake, meta } = platform([
      {
        method: "POST",
        match: `${G}/act_123/adsets`,
        replies: [{ json: { id: "as-1" } }],
      },
    ]);
    await meta.createAdSet(AUTH, {
      campaignId: "c-1",
      name: "A",
      dailyBudgetMinor: 500,
      objective: "OUTCOME_TRAFFIC",
      targeting: {
        countries: ["AR", "UY"],
        ageMin: 18,
        ageMax: 34,
        interestIds: ["6003"],
      },
      endTime: new Date("2026-10-05T00:00:00.000Z"),
    });
    const body = bodyOf(fake.calls[0]);
    expect(body).toMatchObject({
      campaign_id: "c-1",
      daily_budget: "500",
      status: "PAUSED",
      billing_event: "IMPRESSIONS",
      optimization_goal: "LINK_CLICKS",
      end_time: "2026-10-05T00:00:00.000Z",
    });
    expect(JSON.parse(body["targeting"] as string)).toEqual({
      geo_locations: { countries: ["AR", "UY"] },
      age_min: 18,
      age_max: 34,
      flexible_spec: [{ interests: [{ id: "6003" }] }],
    });
  });

  it("anuncio: creative={creative_id} y PAUSED", async () => {
    const { fake, meta } = platform([
      {
        method: "POST",
        match: `${G}/act_123/ads`,
        replies: [{ json: { id: "ad-1", success: true } }],
      },
    ]);
    await meta.createAd(AUTH, { adSetId: "as-1", creativeId: "cr-1", name: "A" });
    const body = bodyOf(fake.calls[0]);
    expect(body).toMatchObject({ adset_id: "as-1", status: "PAUSED" });
    expect(JSON.parse(body["creative"] as string)).toEqual({ creative_id: "cr-1" });
  });

  it("un objetivo que necesita promoted_object no llega a Meta", async () => {
    const { fake, meta } = platform([]);
    await expect(
      meta.createAdSet(AUTH, {
        campaignId: "c",
        name: "x",
        dailyBudgetMinor: 100,
        objective: "OUTCOME_SALES",
        targeting: { countries: ["AR"] },
      }),
    ).rejects.toMatchObject({ reason: "invalid_parameter" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("MetaAdsPlatform — media y creativo", () => {
  it("video por file_url y creativo con video_data + instagram_user_id", async () => {
    const { fake, meta } = platform([
      {
        method: "POST",
        match: `${G}/act_123/advideos`,
        replies: [{ json: { id: "v-9", success: true } }],
      },
      {
        method: "POST",
        match: `${G}/act_123/adcreatives`,
        replies: [{ json: { id: "cr-1" } }],
      },
    ]);
    const { videoId } = await meta.uploadVideo(AUTH, {
      fileUrl: "https://tunnel.example/public-media/tok",
      name: "piece",
    });
    expect(videoId).toBe("v-9");
    expect(bodyOf(fake.calls[0])).toMatchObject({
      file_url: "https://tunnel.example/public-media/tok",
    });
    await meta.createCreative(AUTH, {
      name: "A",
      pageId: "p-1",
      instagramUserId: "ig-1",
      media: { kind: "video", videoId, thumbnailUrl: "https://tunnel.example/thumb" },
      message: "caption",
      link: "https://acme.test",
    });
    const spec = JSON.parse(
      bodyOf(fake.calls[1])["object_story_spec"] as string,
    ) as Record<string, unknown>;
    expect(spec).toEqual({
      page_id: "p-1",
      instagram_user_id: "ig-1",
      video_data: {
        video_id: "v-9",
        message: "caption",
        image_url: "https://tunnel.example/thumb",
        call_to_action: { type: "LEARN_MORE", value: { link: "https://acme.test" } },
      },
    });
  });

  it("imagen: bytes en base64 y el hash de images{}", async () => {
    const { fake, meta } = platform([
      {
        method: "POST",
        match: `${G}/act_123/adimages`,
        replies: [
          { json: { images: { "piece.jpg": { hash: "h4sh", url: "https://x/y.jpg" } } } },
        ],
      },
    ]);
    const out = await meta.uploadImage(AUTH, {
      bytes: new Uint8Array([1, 2, 3]),
      filename: "piece.jpg",
    });
    expect(out).toEqual({ imageHash: "h4sh" });
    expect(bodyOf(fake.calls[0])["bytes"]).toBe("AQID");
  });

  it("creativo de imagen sin link no llega a Meta", async () => {
    const { fake, meta } = platform([]);
    await expect(
      meta.createCreative(AUTH, {
        name: "A",
        pageId: "p",
        media: { kind: "image", imageHash: "h" },
        message: "m",
      }),
    ).rejects.toMatchObject({ reason: "invalid_parameter" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("MetaAdsPlatform — operar y leer", () => {
  it("setStatus y presupuesto: POST /{id}", async () => {
    const { fake, meta } = platform([
      { method: "POST", match: `${G}/c-1`, replies: [{ json: { success: true } }] },
      { method: "POST", match: `${G}/as-1`, replies: [{ json: { success: true } }] },
    ]);
    await meta.setStatus(AUTH, "c-1", "PAUSED");
    await meta.updateAdSetDailyBudget(AUTH, "as-1", 700);
    expect(bodyOf(fake.calls[0])).toMatchObject({ status: "PAUSED" });
    expect(bodyOf(fake.calls[1])).toMatchObject({ daily_budget: "700" });
  });

  it("split test en /{owner}/ad_studies con celdas y tiempos unix", async () => {
    const { fake, meta } = platform([
      {
        method: "POST",
        match: `${G}/u-1/ad_studies`,
        replies: [{ json: { id: "st-1" } }],
      },
    ]);
    await meta.createSplitTest(AUTH, {
      ownerId: "u-1",
      name: "A/B",
      startTime: new Date("2026-09-28T00:00:00Z"),
      endTime: new Date("2026-10-05T00:00:00Z"),
      cells: [
        { name: "A", treatmentPercentage: 50, adSetIds: ["as-1"] },
        { name: "B", treatmentPercentage: 50, adSetIds: ["as-2"] },
      ],
    });
    const body = bodyOf(fake.calls[0]);
    expect(body).toMatchObject({
      type: "SPLIT_TEST",
      start_time: "1790553600",
      end_time: "1791158400",
    });
    expect(JSON.parse(body["cells"] as string)).toEqual([
      { name: "A", treatment_percentage: 50, adsets: ["as-1"] },
      { name: "B", treatment_percentage: 50, adsets: ["as-2"] },
    ]);
  });

  it("insights: strings numéricos → números, gasto a unidades mínimas, sigue paging.next", async () => {
    const next = `${G}/c-1/insights?after=QVFI&access_token=user-token`;
    const { fake, meta } = platform([
      {
        method: "GET",
        match: /\/c-1\/insights\?(?!after)/u,
        replies: [
          {
            json: {
              data: [
                {
                  ad_id: "ad-1",
                  date_start: "2026-09-27",
                  date_stop: "2026-09-27",
                  spend: "12.34",
                  impressions: "1500",
                  clicks: "30",
                  reach: "1200",
                  actions: [
                    { action_type: "link_click", value: "25" },
                    { action_type: "post_engagement", value: "40" },
                  ],
                  action_values: [{ action_type: "purchase", value: "99.5" }],
                },
              ],
              paging: { cursors: { after: "QVFI" }, next },
            },
          },
        ],
      },
      {
        method: "GET",
        match: "after=QVFI",
        replies: [
          {
            json: {
              data: [
                {
                  ad_id: "ad-2",
                  date_start: "2026-09-27",
                  date_stop: "2026-09-27",
                  spend: "0.5",
                  impressions: "100",
                  clicks: "1",
                },
              ],
              paging: { cursors: { before: "x" } },
            },
          },
        ],
      },
    ]);
    const rows = await meta.getInsights(AUTH, {
      campaignId: "c-1",
      since: "2026-09-25",
      until: "2026-09-28",
      currency: "USD",
    });
    expect(rows).toEqual([
      {
        adId: "ad-1",
        date: "2026-09-27",
        spendMinor: 1234,
        impressions: 1500,
        clicks: 30,
        reach: 1200,
        actions: { link_click: 25, post_engagement: 40 },
        actionValuesMinor: { purchase: 9950 },
      },
      {
        adId: "ad-2",
        date: "2026-09-27",
        spendMinor: 50,
        impressions: 100,
        clicks: 1,
        reach: null,
        actions: {},
        actionValuesMinor: {},
      },
    ]);
    const url = new URL(fake.calls[0]?.url ?? "");
    expect(url.searchParams.get("level")).toBe("ad");
    expect(url.searchParams.get("time_increment")).toBe("1");
    expect(JSON.parse(url.searchParams.get("time_range") ?? "")).toEqual({
      since: "2026-09-25",
      until: "2026-09-28",
    });
  });

  it("insights en JPY no multiplica por 100", async () => {
    const { meta } = platform([
      {
        method: "GET",
        match: "/insights",
        replies: [
          {
            json: {
              data: [
                { ad_id: "a", date_start: "2026-09-27", spend: "1500", impressions: "1" },
              ],
            },
          },
        ],
      },
    ]);
    const rows = await meta.getInsights(AUTH, {
      campaignId: "c",
      since: "2026-09-27",
      until: "2026-09-27",
      currency: "JPY",
    });
    expect(rows[0]?.spendMinor).toBe(1500);
  });

  it("un paging.next de otro host no se sigue (llevaría el token afuera)", async () => {
    const { meta } = platform([
      {
        method: "GET",
        match: "/insights",
        replies: [{ json: { data: [], paging: { next: "https://evil.test/x" } } }],
      },
    ]);
    await expect(
      meta.getInsights(AUTH, {
        campaignId: "c",
        since: "a",
        until: "b",
        currency: "USD",
      }),
    ).rejects.toMatchObject({ reason: "unexpected_response" });
  });

  it("cuentas publicitarias de /me/adaccounts", async () => {
    const { meta } = platform([
      {
        method: "GET",
        match: `${G}/me/adaccounts`,
        replies: [
          {
            json: {
              data: [
                {
                  id: "act_123",
                  name: "Acme",
                  currency: "USD",
                  timezone_name: "America/Argentina/Buenos_Aires",
                  account_status: 1,
                },
              ],
            },
          },
        ],
      },
    ]);
    expect(await meta.listAdAccounts("t")).toEqual([
      {
        id: "act_123",
        name: "Acme",
        currency: "USD",
        timezoneName: "America/Argentina/Buenos_Aires",
        accountStatus: 1,
      },
    ]);
  });

  it("Páginas con su IG profesional", async () => {
    const { meta } = platform([
      {
        method: "GET",
        match: `${G}/me/accounts`,
        replies: [
          {
            json: {
              data: [
                {
                  id: "p-1",
                  name: "Acme",
                  instagram_business_account: { id: "ig-1", username: "acme" },
                },
                { id: "p-2", name: "Sin IG" },
              ],
            },
          },
        ],
      },
    ]);
    expect(await meta.listPages("t")).toEqual([
      { id: "p-1", name: "Acme", instagramUserId: "ig-1", instagramUsername: "acme" },
      { id: "p-2", name: "Sin IG", instagramUserId: null, instagramUsername: null },
    ]);
  });
});

describe("MetaAdsPlatform — errores → motivos estables", () => {
  const cases: [string, Reply, AdsErrorReason][] = [
    ["190 token inválido", metaError(190, 460), "unauthorized"],
    ["10 sin permiso", metaError(10, undefined, 403), "permission_missing"],
    ["294 sin ads_management", metaError(294), "permission_missing"],
    ["17 límite de usuario", metaError(17), "rate_limited"],
    ["80004 BUC ads_management", metaError(80004), "rate_limited"],
    ["1885272 presupuesto bajo", metaError(100, 1885272), "budget_too_low"],
    ["1404163 acceso revocado", metaError(368, 1404163), "account_disabled"],
    ["3858258 imagen no descargable", metaError(100, 3858258), "media_rejected"],
    ["100 parámetro inválido", metaError(100), "invalid_parameter"],
    ["100/33 no existe", metaError(100, 33), "not_found"],
    ["500", { status: 500, json: { error: { code: 2 } } }, "provider_unavailable"],
    ["HTML en vez de JSON", { status: 502 }, "provider_unavailable"],
  ];
  for (const [what, reply, reason] of cases) {
    it(`${what} → ${reason}`, async () => {
      const { meta } = platform([
        { method: "POST", match: "/campaigns", replies: [reply] },
      ]);
      const error = await meta
        .createCampaign(AUTH, { name: "x", objective: "OUTCOME_TRAFFIC" })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(isAdsPlatformError(error)).toBe(true);
      expect(error).toMatchObject({ reason });
      // El mensaje de Meta no sale.
      expect((error as Error).message).not.toContain("act_123");
    });
  }

  it("rate_limited lleva cuándo volver (header BUC, en minutos)", async () => {
    const { meta } = platform([
      {
        method: "GET",
        match: "/insights",
        replies: [
          {
            ...metaError(80000),
            headers: {
              "x-business-use-case-usage": JSON.stringify({
                "123": [
                  {
                    type: "ads_insights",
                    call_count: 100,
                    total_cputime: 30,
                    total_time: 40,
                    estimated_time_to_regain_access: 7,
                  },
                ],
              }),
            },
          },
        ],
      },
    ]);
    const error = await meta
      .getInsights(AUTH, { campaignId: "c", since: "a", until: "b", currency: "USD" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      reason: "rate_limited",
      retryAfterSeconds: 420,
      code: "rate_limited",
    });
    expect((error as { isRetryable: boolean }).isRetryable).toBe(true);
  });

  it("sin red → provider_unavailable", async () => {
    const { meta } = platform([
      {
        method: "POST",
        match: "/campaigns",
        replies: [{ throws: new Error("ECONNRESET") }],
      },
    ]);
    await expect(
      meta.createCampaign(AUTH, { name: "x", objective: "OUTCOME_TRAFFIC" }),
    ).rejects.toMatchObject({ reason: "provider_unavailable" });
  });

  it("regainSecondsOf cae a Retry-After", () => {
    expect(regainSecondsOf(new Headers({ "retry-after": "30" }))).toBe(30);
    expect(regainSecondsOf(new Headers({}))).toBeUndefined();
  });
});

describe("OAuth de anuncios", () => {
  it("la URL pide los permisos de ads, aparte de los de publicar", () => {
    const url = new URL(
      metaAdsAuthorizeUrl({ clientId: "app", redirectUri: "https://x/cb", state: "s" }),
    );
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v25.0/dialog/oauth");
    expect(url.searchParams.get("scope")?.split(",")).toEqual(
      expect.arrayContaining(["ads_management", "ads_read", "pages_manage_ads"]),
    );
    expect(url.searchParams.get("scope")).not.toContain("pages_manage_posts");
  });

  it("code → corto → largo, con vencimiento", async () => {
    const fake = new FakeFetch([
      {
        method: "GET",
        match: /oauth\/access_token\?(?!grant_type)/u,
        replies: [
          { json: { access_token: "short", token_type: "bearer", expires_in: 3600 } },
        ],
      },
      {
        method: "GET",
        match: "grant_type=fb_exchange_token",
        replies: [
          { json: { access_token: "long", token_type: "bearer", expires_in: 5183944 } },
        ],
      },
    ]);
    const now = new Date("2026-09-28T00:00:00Z");
    const out = await exchangeMetaAdsCode(
      {
        credentials: { clientId: "app", clientSecret: "sec" },
        redirectUri: "https://x/cb",
        code: "c0de",
        now,
      },
      { fetch: fake.fetch as never },
    );
    expect(out.accessToken).toBe("long");
    expect(out.expiresAt?.getTime()).toBe(now.getTime() + 5183944 * 1000);
  });
});
