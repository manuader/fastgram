/**
 * Extractores sociales sin login — `PU-SCRAPE-001`, `PU-SCRAPE-002`.
 *
 * **Ninguna llamada real.** El `fetch` es un doble que contesta con los
 * fixtures de `__fixtures__/` (ver su README: de dónde sale cada forma) y
 * registra qué se pidió, para comprobar rutas, headers y cuántas llamadas hubo.
 */
import { readFileSync } from "node:fs";

import { PortError, type SocialReader } from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import { handleFrom } from "./handles.js";
import type { SocialFetch } from "./http.js";
import {
  businessDiscoveryFields,
  InstagramBusinessDiscoveryReader,
} from "./instagram-business-discovery-reader.js";
import { InstagramVisionReader } from "./instagram-vision-reader.js";
import { LadderSocialReader } from "./ladder-reader.js";
import { TikTokDtkReader } from "./tiktok-dtk-reader.js";
import { XFxTwitterReader } from "./x-fxtwitter-reader.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

type Route = (call: Call) => Response;

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakeFetch(route: Route): { fetch: SocialFetch; calls: Call[] } {
  const calls: Call[] = [];
  const f: SocialFetch = (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    };
    calls.push(call);
    return Promise.resolve(route(call));
  };
  return { fetch: f, calls };
}

async function rejection(p: Promise<unknown>): Promise<PortError> {
  try {
    await p;
  } catch (error: unknown) {
    if (error instanceof PortError) return error;
    throw error;
  }
  throw new Error("se esperaba un PortError");
}

// ───────────────────────────────────────────────────────────────────────────

describe("handleFrom", () => {
  it.each([
    ["instagram", "https://instagram.com/mimarca", "mimarca"],
    ["instagram", "https://www.instagram.com/MiMarca/?igshid=x", "mimarca"],
    ["instagram", "@mimarca", "mimarca"],
    ["tiktok", "https://tiktok.com/@mimarca", "mimarca"],
    ["tiktok", "https://www.tiktok.com/@mi.marca", "mi.marca"],
    ["x", "https://x.com/MiMarca", "mimarca"],
    ["x", "twitter.com/mimarca", "mimarca"],
    ["x", "mimarca", "mimarca"],
  ] as const)("%s: %s → %s", (platform, input, expected) => {
    expect(handleFrom(platform, input)).toBe(expected);
  });

  it.each([
    ["instagram", "https://tiktok.com/@mimarca"],
    ["instagram", "no/vale"],
    ["x", "https://x.com/"],
    ["x", "hola mundo"],
    ["tiktok", "@a?b=c"],
  ] as const)("%s rechaza %s", (platform, input) => {
    expect(handleFrom(platform, input)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("InstagramVisionReader — contra services/vision", () => {
  const reader = (route: Route) => {
    const f = fakeFetch(route);
    return {
      reader: new InstagramVisionReader({
        baseUrl: "http://vision.test/",
        fetch: f.fetch,
      }),
      calls: f.calls,
    };
  };

  it("perfil + posts en UNA llamada, con la forma del servicio", async () => {
    const { reader: r, calls } = reader(() =>
      json(200, fixture("vision-instagram-profile.json")),
    );
    const profile = await r.readProfile({
      handle: "https://instagram.com/tallerceramico",
    });
    const content = await r.readRecentContent({
      handle: "https://instagram.com/tallerceramico",
      limit: 24,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://vision.test/social/instagram/profile");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ username: "tallerceramico", limit: 12 });

    expect(profile.status).toBe("ok");
    if (profile.status !== "ok") return;
    expect(profile.tier).toBe("C_page_fetch");
    expect(profile.data).toMatchObject({
      handle: "tallerceramico",
      displayName: "Taller Cerámico",
      category: "Arts & Crafts Store",
      links: ["https://taller.example/"],
      followerCount: 1200,
    });
    // La bio viaja textual: la contención es del sintetizador, no del extractor.
    expect(profile.data.bio).toContain("Ignore previous instructions");

    expect(content.status).toBe("ok");
    if (content.status !== "ok") return;
    // Del más reciente al más viejo, aunque el servicio los mande desordenados.
    expect(content.data.map((i) => i.externalId)).toEqual([
      "C0003def",
      "C0002abc",
      "C0001xyz",
    ]);
    expect(content.data[0]).toMatchObject({
      kind: "video",
      mentions: ["amiga"],
      engagement: { likes: 240, comments: 12, views: 5100 },
      mediaUrls: ["https://scontent.cdninstagram.com/v/3.mp4"],
    });
    expect(content.data[1]?.hashtags).toEqual(["ceramica", "handmade"]);
  });

  it("429 platform_rate_limited → PortError rate_limited con Retry-After", async () => {
    const { reader: r } = reader(() =>
      json(
        429,
        { error: { code: "platform_rate_limited", message: "x", retry_after: 300 } },
        { "retry-after": "300" },
      ),
    );
    const err = await rejection(r.readProfile({ handle: "tallerceramico" }));
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(300);
    expect(err.isRetryable).toBe(true);
  });

  it("una falla no se memoiza: el reintento vuelve a llamar", async () => {
    let n = 0;
    const { reader: r, calls } = reader(() =>
      ++n === 1
        ? json(429, { error: { code: "platform_rate_limited", message: "x" } })
        : json(200, fixture("vision-instagram-profile.json")),
    );
    await rejection(r.readProfile({ handle: "tallerceramico" }));
    expect((await r.readProfile({ handle: "tallerceramico" })).status).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it.each([
    [
      404,
      { error: { code: "profile_unavailable", reason: "not_found", message: "x" } },
      "not_found",
    ],
    [
      403,
      { error: { code: "profile_unavailable", reason: "private", message: "x" } },
      "private",
    ],
    [
      503,
      { error: { code: "extractor_unavailable", message: "x" } },
      "extractor_unavailable",
    ],
  ] as const)("%i %j → %s", async (status, body, outcome) => {
    const { reader: r } = reader(() => json(status, body));
    const out = await r.readProfile({ handle: "tallerceramico" });
    expect(out).toEqual({ status: outcome, attemptedTiers: ["C_page_fetch"] });
  });

  it("un perfil privado (200, is_private) es `private`", async () => {
    const base = fixture("vision-instagram-profile.json") as Record<
      string,
      Record<string, unknown>
    >;
    const { reader: r } = reader(() =>
      json(200, {
        ...base,
        profile: { ...base["profile"], is_private: true },
        posts: [],
      }),
    );
    expect((await r.readProfile({ handle: "tallerceramico" })).status).toBe("private");
  });

  it("502 → provider_unavailable; forma rara → provider_contract_violation", async () => {
    const a = reader(() =>
      json(502, { error: { code: "platform_unavailable", message: "x" } }),
    );
    expect((await rejection(a.reader.readProfile({ handle: "x" }))).code).toBe(
      "provider_unavailable",
    );
    const b = reader(() => json(200, { nada: true }));
    expect((await rejection(b.reader.readProfile({ handle: "x" }))).code).toBe(
      "provider_contract_violation",
    );
  });

  it("la red caída es provider_unavailable, sin el error crudo en el mensaje", async () => {
    const r = new InstagramVisionReader({
      baseUrl: "http://vision.test",
      fetch: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:8000")),
    });
    const err = await rejection(r.readProfile({ handle: "x" }));
    expect(err.code).toBe("provider_unavailable");
    expect(err.message).not.toContain("ECONNREFUSED");
  });

  it("un handle que no es de Instagram no gasta una llamada", async () => {
    const { reader: r, calls } = reader(() => json(200, {}));
    expect((await rejection(r.readProfile({ handle: "https://x.com/abc" }))).code).toBe(
      "bad_request",
    );
    expect(calls).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("TikTokDtkReader — contra el contenedor de Evil0ctal v5.1.1", () => {
  const route: Route = (call) => {
    const u = new URL(call.url);
    if (u.pathname === "/api/v1/tiktok/user")
      return json(200, fixture("dtk-tiktok-user.json"));
    if (u.pathname === "/api/v1/tiktok/user/posts") {
      return json(200, fixture("dtk-tiktok-user-posts.json"));
    }
    return json(404, {
      success: false,
      data: null,
      error: { code: "NOT_FOUND", message: "" },
    });
  };

  it("pide el perfil por URL y los posts por sec_uid, con X-API-Key y ?wait", async () => {
    const f = fakeFetch(route);
    const r = new TikTokDtkReader({
      baseUrl: "http://dtk.test",
      apiKey: "k-123",
      fetch: f.fetch,
    });
    const profile = await r.readProfile({ handle: "https://tiktok.com/@tallerceramico" });
    const content = await r.readRecentContent({
      handle: "https://tiktok.com/@tallerceramico",
    });

    expect(f.calls).toHaveLength(2);
    const [who, posts] = f.calls.map((c) => new URL(c.url));
    expect(who?.pathname).toBe("/api/v1/tiktok/user");
    expect(who?.searchParams.get("url")).toBe("https://www.tiktok.com/@tallerceramico");
    expect(who?.searchParams.get("wait")).toBe("25");
    expect(posts?.searchParams.get("sec_user_id")).toBe("MS4wLjABAAAA-fixture-secuid");
    expect(posts?.searchParams.get("count")).toBe("24");
    expect(f.calls[0]?.headers["x-api-key"]).toBe("k-123");

    expect(profile.status === "ok" && profile.data).toMatchObject({
      handle: "tallerceramico",
      displayName: "Taller Cerámico",
      followerCount: 3400,
      likeCount: 98000,
    });
    expect(content.status).toBe("ok");
    if (content.status !== "ok") return;
    expect(content.data.map((i) => i.externalId)).toEqual([
      "7400000000000000002",
      "7400000000000000001",
    ]);
    expect(content.data[0]).toMatchObject({
      kind: "carousel",
      // `statsV2` llega como strings: se leen como números.
      engagement: { likes: 310, comments: 9, views: 4500, shares: 2 },
      mediaUrls: [
        "https://p16-sign.tiktokcdn.com/p1.jpeg",
        "https://p16-sign.tiktokcdn.com/p2.jpeg",
      ],
    });
    expect(content.data[1]).toMatchObject({
      kind: "video",
      caption: "Torno a las 6 am\nasí arranca el día en el taller #ceramica #pottery",
      hashtags: ["ceramica", "pottery"],
      soundId: "7300000000000000009",
      permalink: "https://www.tiktok.com/@tallerceramico/video/7400000000000000001",
    });
  });

  it.each([
    ["CONTENT_PRIVATE", 403, "private"],
    ["NOT_FOUND", 404, "not_found"],
    ["UNAUTHENTICATED", 401, "extractor_unavailable"],
    ["NOT_CONFIGURED", 501, "extractor_unavailable"],
  ] as const)("%s → %s", async (code, status, outcome) => {
    const f = fakeFetch(() =>
      json(status, { success: false, data: null, error: { code, message: "m" } }),
    );
    const r = new TikTokDtkReader({ baseUrl: "http://dtk.test", fetch: f.fetch });
    expect((await r.readProfile({ handle: "@a" })).status).toBe(outcome);
  });

  it.each([
    ["RATE_LIMITED", 429, "rate_limited"],
    ["UPSTREAM_RISK_CONTROL", 502, "rate_limited"],
    ["IDENTITY_POOL_EXHAUSTED", 503, "rate_limited"],
    ["SIGNING_FAILED", 502, "provider_unavailable"],
    ["UPSTREAM_CHANGED", 502, "provider_contract_violation"],
  ] as const)("%s → PortError %s", async (code, status, portCode) => {
    const f = fakeFetch(() =>
      json(status, {
        success: false,
        data: null,
        error: { code, message: "m", retry_after: 12 },
      }),
    );
    const r = new TikTokDtkReader({ baseUrl: "http://dtk.test", fetch: f.fetch });
    const err = await rejection(r.readProfile({ handle: "@a" }));
    expect(err.code).toBe(portCode);
    if (portCode === "rate_limited") expect(err.retryAfterSeconds).toBe(12);
  });

  it("202 (no terminó a tiempo) es timeout: reintentable, no un error del perfil", async () => {
    const f = fakeFetch(() =>
      json(202, { success: true, data: { task_id: "t", state: "running" } }),
    );
    const r = new TikTokDtkReader({ baseUrl: "http://dtk.test", fetch: f.fetch });
    const err = await rejection(r.readProfile({ handle: "@a" }));
    expect(err.code).toBe("timeout");
    expect(err.isRetryable).toBe(true);
  });

  it("si fallan los posts, el perfil sirve igual y el contenido dice insufficient_content", async () => {
    const f = fakeFetch((call) =>
      new URL(call.url).pathname === "/api/v1/tiktok/user"
        ? json(200, fixture("dtk-tiktok-user.json"))
        : json(429, {
            success: false,
            data: null,
            error: { code: "RATE_LIMITED", message: "" },
          }),
    );
    const r = new TikTokDtkReader({ baseUrl: "http://dtk.test", fetch: f.fetch });
    expect((await r.readProfile({ handle: "@tallerceramico" })).status).toBe("ok");
    expect((await r.readRecentContent({ handle: "@tallerceramico" })).status).toBe(
      "insufficient_content",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("XFxTwitterReader — api.fxtwitter.com v2", () => {
  const route: Route = (call) => {
    const u = new URL(call.url);
    if (u.pathname === "/2/profile/tallerceramico")
      return json(200, fixture("fxtwitter-profile.json"));
    if (u.pathname === "/2/profile/tallerceramico/statuses") {
      return json(200, fixture("fxtwitter-statuses.json"));
    }
    return json(404, { code: 404, message: "User not found" });
  };

  it("perfil y tweets propios; los reposts no entran", async () => {
    const f = fakeFetch(route);
    const r = new XFxTwitterReader({
      baseUrl: "https://api.fxtwitter.test",
      fetch: f.fetch,
    });
    const profile = await r.readProfile({ handle: "https://x.com/TallerCeramico" });
    const content = await r.readRecentContent({
      handle: "https://x.com/TallerCeramico",
      limit: 24,
    });

    expect(f.calls.map((c) => new URL(c.url).pathname + new URL(c.url).search)).toEqual([
      "/2/profile/tallerceramico",
      "/2/profile/tallerceramico/statuses?count=24",
    ]);
    expect(f.calls[0]?.headers["user-agent"]).toContain("FastGram");
    expect(profile.status === "ok" && profile.data).toMatchObject({
      handle: "TallerCeramico",
      displayName: "Taller Cerámico",
      location: "Valencia",
      links: ["https://taller.example/"],
      followerCount: 530,
    });
    expect(content.status === "ok" && content.data).toEqual([
      {
        externalId: "1830000000000000002",
        kind: "image",
        permalink: "https://x.com/TallerCeramico/status/1830000000000000002",
        caption: "Abrimos el taller el sábado #ceramica",
        hashtags: ["ceramica"],
        mentions: [],
        postedAt: new Date(1790244000 * 1000),
        engagement: { likes: 40, comments: 5, views: 2100, shares: 3 },
        mediaUrls: ["https://pbs.twimg.com/media/a.jpg"],
      },
    ]);
  });

  it("404 del perfil es not_found; protected es private", async () => {
    const f = fakeFetch(() =>
      json(404, { code: 404, message: "User not found", reason: "suspended" }),
    );
    const r = new XFxTwitterReader({ baseUrl: "https://fx.test", fetch: f.fetch });
    expect((await r.readProfile({ handle: "nadie" })).status).toBe("not_found");

    const p = fixture("fxtwitter-profile.json") as { user: Record<string, unknown> };
    const g = fakeFetch(() => json(200, { ...p, user: { ...p.user, protected: true } }));
    const r2 = new XFxTwitterReader({ baseUrl: "https://fx.test", fetch: g.fetch });
    expect((await r2.readProfile({ handle: "tallerceramico" })).status).toBe("private");
  });

  it("timeline 404 es «vacío», no una falla", async () => {
    const f = fakeFetch((call) =>
      call.url.endsWith("/statuses?count=24")
        ? json(404, { code: 404, results: [], cursor: { top: null, bottom: null } })
        : json(200, fixture("fxtwitter-profile.json")),
    );
    const r = new XFxTwitterReader({ baseUrl: "https://fx.test", fetch: f.fetch });
    const content = await r.readRecentContent({ handle: "tallerceramico" });
    expect(content).toEqual({ status: "ok", tier: "C_page_fetch", data: [] });
  });

  it("429 → rate_limited", async () => {
    const f = fakeFetch(() => json(429, {}, { "retry-after": "60" }));
    const r = new XFxTwitterReader({ baseUrl: "https://fx.test", fetch: f.fetch });
    const err = await rejection(r.readProfile({ handle: "a" }));
    expect([err.code, err.retryAfterSeconds]).toEqual(["rate_limited", 60]);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("InstagramBusinessDiscoveryReader — Graph API oficial", () => {
  const creds = () =>
    Promise.resolve({ igUserId: "17841405309211844", accessToken: "tok-secreto" });

  it("pide los campos públicos de business_discovery y parsea la respuesta", async () => {
    const f = fakeFetch(() => json(200, fixture("business-discovery.json")));
    const r = new InstagramBusinessDiscoveryReader({
      credentials: creds,
      fetch: f.fetch,
    });
    const profile = await r.readProfile({
      handle: "https://instagram.com/tallerceramico",
    });
    const content = await r.readRecentContent({
      handle: "https://instagram.com/tallerceramico",
    });

    const u = new URL(f.calls[0]?.url ?? "");
    expect(u.origin + u.pathname).toBe(
      "https://graph.facebook.com/v26.0/17841405309211844",
    );
    expect(u.searchParams.get("fields")).toBe(
      businessDiscoveryFields("tallerceramico", 24),
    );
    expect(u.searchParams.get("access_token")).toBe("tok-secreto");

    expect(profile.status === "ok" && profile.tier).toBe("B_public_api");
    expect(profile.status === "ok" && profile.data).toEqual({
      handle: "tallerceramico",
      bio: "Tazas de cerámica hechas a mano en Valencia",
      links: ["https://taller.example/"],
      followerCount: 1200,
    });
    expect(
      content.status === "ok" && content.data.map((i) => [i.kind, i.hashtags]),
    ).toEqual([
      ["image", ["ceramica"]],
      ["carousel", []],
    ]);
    expect(content.status === "ok" && content.data[0]?.postedAt?.toISOString()).toBe(
      "2026-09-10T12:00:00.000Z",
    );
  });

  it("sin credencial: extractor_unavailable, sin llamar", async () => {
    const f = fakeFetch(() => json(200, {}));
    const r = new InstagramBusinessDiscoveryReader({
      credentials: () => Promise.resolve(null),
      fetch: f.fetch,
    });
    expect((await r.readProfile({ handle: "a" })).status).toBe("extractor_unavailable");
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    [
      400,
      { error: { code: 4, message: "Application request limit reached" } },
      "throw:rate_limited",
    ],
    [
      400,
      { error: { code: 190, message: "Error validating access token" } },
      "extractor_unavailable",
    ],
    [400, { error: { code: 110, message: "Invalid user id" } }, "not_found"],
    [
      500,
      { error: { code: 2, message: "Service temporarily unavailable" } },
      "throw:provider_unavailable",
    ],
  ] as const)("%i %j → %s", async (status, body, expected) => {
    const f = fakeFetch(() => json(status, body));
    const r = new InstagramBusinessDiscoveryReader({
      credentials: creds,
      fetch: f.fetch,
    });
    if (expected.startsWith("throw:")) {
      expect((await rejection(r.readProfile({ handle: "a" }))).code).toBe(
        expected.slice(6),
      );
    } else {
      expect((await r.readProfile({ handle: "a" })).status).toBe(expected);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("LadderSocialReader — decide el último que se intentó", () => {
  const visionOk = () =>
    new InstagramVisionReader({
      baseUrl: "http://vision.test",
      fetch: fakeFetch(() => json(200, fixture("vision-instagram-profile.json"))).fetch,
    });
  const vision429 = () =>
    new InstagramVisionReader({
      baseUrl: "http://vision.test",
      fetch: fakeFetch(() =>
        json(429, { error: { code: "platform_rate_limited", message: "x" } }),
      ).fetch,
    });
  const bd = (route: Route) =>
    new InstagramBusinessDiscoveryReader({
      credentials: () => Promise.resolve({ igUserId: "1", accessToken: "t" }),
      fetch: fakeFetch(route).fetch,
    });
  const bdOk = () => bd(() => json(200, fixture("business-discovery.json")));
  const bdNotBusiness = () => bd(() => json(400, { error: { code: 110, message: "x" } }));
  const bd429 = () => bd(() => json(400, { error: { code: 17, message: "x" } }));

  it("B → C: la cuenta no califica para Business Discovery → lee el anónimo", async () => {
    const ladder = new LadderSocialReader([bdNotBusiness(), visionOk()]);
    const out = await ladder.readProfile({ handle: "tallerceramico" });
    expect(out.status === "ok" && out.tier).toBe("C_page_fetch");
    // Los posts salen del mismo extractor que leyó el perfil.
    const content = await ladder.readRecentContent({ handle: "tallerceramico" });
    expect(content.status === "ok" && content.data).toHaveLength(3);
  });

  it("B lee: el anónimo ni se toca (menos 429)", async () => {
    let touched = false;
    const c = new InstagramVisionReader({
      baseUrl: "http://vision.test",
      fetch: () => {
        touched = true;
        return Promise.resolve(json(500, {}));
      },
    });
    const out = await new LadderSocialReader([bdOk(), c]).readProfile({
      handle: "tallerceramico",
    });
    expect(out.status === "ok" && out.tier).toBe("B_public_api");
    expect(touched).toBe(false);
  });

  it("IG anónimo 429 → Business Discovery (orden C → B) → lee", async () => {
    const out = await new LadderSocialReader([vision429(), bdOk()]).readProfile({
      handle: "tallerceramico",
    });
    expect(out.status === "ok" && out.tier).toBe("B_public_api");
  });

  it("IG anónimo 429 y Business Discovery también limitado → el error del último (→ D en el worker)", async () => {
    const err = await rejection(
      new LadderSocialReader([vision429(), bd429()]).readProfile({
        handle: "tallerceramico",
      }),
    );
    expect(err.code).toBe("rate_limited");
  });

  it("B no califica + C 429 → rate_limited", async () => {
    const err = await rejection(
      new LadderSocialReader([bdNotBusiness(), vision429()]).readProfile({ handle: "x" }),
    );
    expect(err.code).toBe("rate_limited");
  });

  it("B no califica + C sin instaloader → extractor_unavailable, con los dos tiers intentados", async () => {
    const noTool = new InstagramVisionReader({
      baseUrl: "http://vision.test",
      fetch: fakeFetch(() =>
        json(503, { error: { code: "extractor_unavailable", message: "x" } }),
      ).fetch,
    });
    const out = await new LadderSocialReader([bdNotBusiness(), noTool]).readProfile({
      handle: "x",
    });
    expect(out).toEqual({
      status: "extractor_unavailable",
      attemptedTiers: ["B_public_api", "C_page_fetch"],
    });
  });

  it("capacidades: tiers en orden, C activo si alguno lo está", () => {
    const caps = new LadderSocialReader([bdOk(), visionOk()]).capabilities();
    expect(caps.tiers).toEqual(["B_public_api", "C_page_fetch"]);
    expect(caps.renderedFetchEnabled).toBe(true);
    expect(caps.requiresConnection).toBe(false);
  });

  it("no mezcla plataformas", () => {
    const x: SocialReader = new XFxTwitterReader({ baseUrl: "https://fx.test" });
    expect(() => new LadderSocialReader([visionOk(), x])).toThrow();
  });
});
