/**
 * Los cuatro adaptadores de `SocialMetrics` contra un `fetch` falso con las
 * respuestas **con la forma que muestra la documentación** citada en cada
 * adaptador. Ningún test habla con una plataforma.
 */
import { isPortError, type PortError } from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import { FakeFetch, type Route } from "../publishers/__tests__/fake-fetch.js";
import {
  FacebookReelsMetrics,
  InstagramMetrics,
  META_INSIGHTS_CONCURRENCY,
  ThreadsMetrics,
  XMetrics,
  facebookLikes,
  facebookSocialAction,
} from "./index.js";

const ACCOUNT = { accessToken: "tok-secreto" };

/** `{"data":[{"name":…,"period":"lifetime","values":[{"value":…}]}]}` */
const insights = (values: Record<string, unknown>) => ({
  data: Object.entries(values).map(([name, value]) => ({
    name,
    period: "lifetime",
    values: [{ value }],
    title: name,
    id: `x/insights/${name}/lifetime`,
  })),
});

const graphError = (code: number, subcode?: number) => ({
  error: {
    message: "texto crudo de Meta que no debe salir",
    type: "OAuthException",
    code,
    ...(subcode === undefined ? {} : { error_subcode: subcode }),
    fbtrace_id: "trace",
  },
});

async function caught(p: Promise<unknown>): Promise<PortError> {
  try {
    await p;
  } catch (e) {
    if (isPortError(e)) return e;
    throw e;
  }
  throw new Error("se esperaba un PortError");
}

describe("InstagramMetrics", () => {
  const route = (match: string, ...replies: Route["replies"]): Route => ({
    method: "GET",
    match,
    replies,
  });

  it("pide views,likes,comments,shares por media con Bearer y mapea la respuesta", async () => {
    const f = new FakeFetch([
      route("/111/insights", {
        json: insights({ views: 1200, likes: 80, comments: 9, shares: 4 }),
      }),
    ]);
    const m = new InstagramMetrics({ fetch: f.fetch });
    const out = await m.fetch({ account: ACCOUNT, externalPostIds: ["111"] });

    expect(out).toEqual({
      items: [{ externalPostId: "111", views: 1200, likes: 80, comments: 9, shares: 4 }],
      missing: [],
      unavailable: [],
    });
    const call = f.calls[0];
    expect(call?.url).toBe(
      "https://graph.instagram.com/v26.0/111/insights?metric=views,likes,comments,shares",
    );
    expect(call?.headers["Authorization"]).toBe("Bearer tok-secreto");
  });

  it("una métrica que no vino queda ausente, no en cero (la doc: empty set en vez de 0)", async () => {
    const f = new FakeFetch([route("/111/insights", { json: insights({ likes: 0 }) })]);
    const out = await new InstagramMetrics({ fetch: f.fetch }).fetch({
      account: ACCOUNT,
      externalPostIds: ["111"],
    });
    expect(out.items[0]).toEqual({ externalPostId: "111", likes: 0 });
    expect(out.items[0]).not.toHaveProperty("views");
  });

  it("acepta total_value.value (la otra forma documentada)", async () => {
    const f = new FakeFetch([
      route("/111/insights", {
        json: {
          data: [{ name: "views", period: "lifetime", total_value: { value: 7 } }],
        },
      }),
    ]);
    const out = await new InstagramMetrics({ fetch: f.fetch }).fetch({
      account: ACCOUNT,
      externalPostIds: ["111"],
    });
    expect(out.items[0]).toEqual({ externalPostId: "111", views: 7 });
  });

  it("éxito parcial: un código 100 en un post no tira el lote", async () => {
    const f = new FakeFetch([
      route("/111/insights", { json: insights({ likes: 3 }) }),
      route("/222/insights", { status: 400, json: graphError(100) }),
    ]);
    const out = await new InstagramMetrics({ fetch: f.fetch }).fetch({
      account: ACCOUNT,
      externalPostIds: ["111", "222"],
    });
    expect(out.items.map((i) => i.externalPostId)).toEqual(["111"]);
    expect(out.unavailable).toEqual(["222"]);
  });

  it("sin permiso de insights (código 10) → forbidden, sin el mensaje de Meta", async () => {
    const f = new FakeFetch([route("/insights", { status: 403, json: graphError(10) })]);
    const e = await caught(
      new InstagramMetrics({ fetch: f.fetch }).fetch({
        account: ACCOUNT,
        externalPostIds: ["111"],
      }),
    );
    expect(e.code).toBe("forbidden");
    expect(e.message).not.toContain("Meta");
    expect(e.message).not.toContain("tok-secreto");
  });

  it("sesión vencida (190) → unauthorized; límite (4) → rate_limited reintentable", async () => {
    const auth = new FakeFetch([
      route("/insights", { status: 400, json: graphError(190) }),
    ]);
    expect(
      (
        await caught(
          new InstagramMetrics({ fetch: auth.fetch }).fetch({
            account: ACCOUNT,
            externalPostIds: ["1"],
          }),
        )
      ).code,
    ).toBe("unauthorized");

    const limit = new FakeFetch([
      route("/insights", { status: 400, json: graphError(4) }),
    ]);
    const e = await caught(
      new InstagramMetrics({ fetch: limit.fetch }).fetch({
        account: ACCOUNT,
        externalPostIds: ["1"],
      }),
    );
    expect(e.code).toBe("rate_limited");
    expect(e.isRetryable).toBe(true);
  });

  it("un 500 es provider_unavailable (leer nunca es entrega incierta)", async () => {
    const f = new FakeFetch([route("/insights", { status: 500, json: {} })]);
    const e = await caught(
      new InstagramMetrics({ fetch: f.fetch }).fetch({
        account: ACCOUNT,
        externalPostIds: ["1"],
      }),
    );
    expect(e.code).toBe("provider_unavailable");
    expect("deliveryUncertain" in e).toBe(false);
  });

  it("más de 100 ids es bad_request antes de llamar", async () => {
    const f = new FakeFetch([]);
    const ids = Array.from({ length: 101 }, (_, i) => String(i));
    const e = await caught(
      new InstagramMetrics({ fetch: f.fetch }).fetch({
        account: ACCOUNT,
        externalPostIds: ids,
      }),
    );
    expect(e.code).toBe("bad_request");
    expect(f.calls).toHaveLength(0);
  });

  it("un 2xx sin data[] es provider_contract_violation", async () => {
    const f = new FakeFetch([route("/insights", { json: { algo: 1 } })]);
    const e = await caught(
      new InstagramMetrics({ fetch: f.fetch }).fetch({
        account: ACCOUNT,
        externalPostIds: ["1"],
      }),
    );
    expect(e.code).toBe("provider_contract_violation");
  });

  it(`no tiene más de ${String(META_INSIGHTS_CONCURRENCY)} requests en vuelo`, async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = async (): Promise<Response> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return new Response(JSON.stringify(insights({ likes: 1 })), { status: 200 });
    };
    const ids = Array.from({ length: 20 }, (_, i) => String(i));
    const out = await new InstagramMetrics({ fetch: fetchImpl }).fetch({
      account: ACCOUNT,
      externalPostIds: ids,
    });
    expect(out.items).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(META_INSIGHTS_CONCURRENCY);
  });
});

describe("ThreadsMetrics", () => {
  it("token en la query, replies → comments, reposts+quotes+shares → shares", async () => {
    const f = new FakeFetch([
      {
        method: "GET",
        match: "/555/insights",
        replies: [
          {
            json: insights({
              views: 300,
              likes: 20,
              replies: 5,
              reposts: 2,
              quotes: 1,
              shares: 3,
            }),
          },
        ],
      },
    ]);
    const out = await new ThreadsMetrics({ fetch: f.fetch }).fetch({
      account: ACCOUNT,
      externalPostIds: ["555"],
    });
    expect(out.items).toEqual([
      { externalPostId: "555", views: 300, likes: 20, comments: 5, shares: 6 },
    ]);
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://graph.threads.net/v1.0/555/insights");
    expect(url.searchParams.get("metric")).toBe(
      "views,likes,replies,reposts,quotes,shares",
    );
    expect(url.searchParams.get("access_token")).toBe("tok-secreto");
  });

  it("un post sin ninguna de las de compartir deja shares ausente", async () => {
    const f = new FakeFetch([
      { method: "GET", match: "/insights", replies: [{ json: insights({ likes: 1 }) }] },
    ]);
    const out = await new ThreadsMetrics({ fetch: f.fetch }).fetch({
      account: ACCOUNT,
      externalPostIds: ["1"],
    });
    expect(out.items[0]).toEqual({ externalPostId: "1", likes: 1 });
  });
});

describe("FacebookReelsMetrics", () => {
  it("video_insights con las tres métricas de Reels y lectura defensiva de los objetos", async () => {
    const f = new FakeFetch([
      {
        method: "GET",
        match: "/vid9/video_insights",
        replies: [
          {
            json: insights({
              blue_reels_play_count: 900,
              post_video_likes_by_reaction_type: { REACTION_LIKE: 10, REACTION_LOVE: 2 },
              post_video_social_actions: { COMMENT: 4, SHARE: 3 },
            }),
          },
        ],
      },
    ]);
    const out = await new FacebookReelsMetrics({ fetch: f.fetch }).fetch({
      account: ACCOUNT,
      externalPostIds: ["vid9"],
    });
    expect(out.items).toEqual([
      { externalPostId: "vid9", views: 900, likes: 12, comments: 4, shares: 3 },
    ]);
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe(
      "https://graph.facebook.com/v26.0/vid9/video_insights",
    );
    expect(url.searchParams.get("access_token")).toBe("tok-secreto");
  });

  it("un número en social_actions no se parte: comments y shares quedan desconocidos", () => {
    expect(facebookLikes(7)).toBe(7);
    expect(facebookLikes({})).toBeUndefined();
    expect(facebookSocialAction(12, "COMMENT")).toBeUndefined();
    expect(facebookSocialAction({ comment: 2, share: 1 }, "SHARE")).toBe(1);
  });
});

describe("XMetrics", () => {
  const xRoute = (reply: Route["replies"][number]): Route => ({
    method: "GET",
    match: "/2/tweets?",
    replies: [reply],
  });

  it("un solo GET con ids y post.fields=public_metrics; éxito parcial por errors[]", async () => {
    const f = new FakeFetch([
      xRoute({
        json: {
          data: [
            {
              id: "1346889436626259968",
              text: "hola",
              public_metrics: {
                repost_count: 2,
                reply_count: 3,
                like_count: 10,
                quote_count: 1,
                bookmark_count: 0,
                impression_count: 500,
              },
            },
          ],
          errors: [
            {
              type: "https://api.x.com/2/problems/resource-not-found",
              title: "Not Found Error",
              detail: "Could not find tweet with ids: [99].",
              resource_type: "tweet",
              resource_id: "99",
            },
          ],
        },
      }),
    ]);
    const out = await new XMetrics({ fetch: f.fetch }).fetch({
      account: ACCOUNT,
      externalPostIds: ["1346889436626259968", "99", "99"],
    });
    expect(out.items).toEqual([
      {
        externalPostId: "1346889436626259968",
        views: 500,
        likes: 10,
        comments: 3,
        shares: 3,
      },
    ]);
    expect(out.missing).toEqual(["99"]);
    expect(out.unavailable).toEqual([]);
    expect(f.calls).toHaveLength(1);
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.searchParams.get("ids")).toBe("1346889436626259968,99");
    expect(url.searchParams.get("post.fields")).toBe("public_metrics");
    expect(f.calls[0]?.headers["Authorization"]).toBe("Bearer tok-secreto");
  });

  it("declara el costo de leer: 0,005 US$ por post", () => {
    expect(new XMetrics().capabilities().costPerPostReadUsd).toBe(0.005);
  });

  it("401 → unauthorized, 403 → forbidden, 429 → rate_limited con Retry-After", async () => {
    const codes: [number, string][] = [
      [401, "unauthorized"],
      [403, "forbidden"],
      [429, "rate_limited"],
      [503, "provider_unavailable"],
    ];
    for (const [status, code] of codes) {
      const f = new FakeFetch([
        xRoute({ status, json: { title: "x" }, headers: { "retry-after": "30" } }),
      ]);
      const e = await caught(
        new XMetrics({ fetch: f.fetch }).fetch({
          account: ACCOUNT,
          externalPostIds: ["1"],
        }),
      );
      expect(e.code, String(status)).toBe(code);
      if (status === 429) expect(e.retryAfterSeconds).toBe(30);
    }
  });

  it("un id que no vino ni en data ni en errors no se afirma: unavailable", async () => {
    const f = new FakeFetch([xRoute({ json: { data: [] } })]);
    const out = await new XMetrics({ fetch: f.fetch }).fetch({
      account: ACCOUNT,
      externalPostIds: ["7"],
    });
    expect(out).toEqual({ items: [], missing: [], unavailable: ["7"] });
  });

  it("sin ids no llama (no se paga una lectura vacía)", async () => {
    const f = new FakeFetch([]);
    const out = await new XMetrics({ fetch: f.fetch }).fetch({
      account: ACCOUNT,
      externalPostIds: [],
    });
    expect(out.items).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
});
