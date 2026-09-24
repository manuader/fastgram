/**
 * Cliente de Reddit contra un `fetch` falso que imita las respuestas
 * documentadas (wiki OAuth2, wiki JSON, /dev/api). **Nunca** red real.
 */
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPortError, PortError } from "@fastgram/ports";

import type { OAuthFetch } from "../oauth/http.js";
import { FileRedditAppStore } from "./app-store.js";
import { RedditApi, RedditOAuth, unescapeRedditText } from "./client.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | undefined;
}

function fakeFetch(
  responder: (call: Call) => {
    status?: number;
    body: unknown;
    headers?: Record<string, string>;
  },
): { fetch: OAuthFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: OAuthFetch = (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    calls.push(call);
    const r = responder(call);
    return Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json", ...(r.headers ?? {}) },
      }),
    );
  };
  return { fetch, calls };
}

const UA = "web:fastgram-engagement:0.1.0 (by /u/owner)";
const creds = { clientId: "cid", clientSecret: "csecret" };
const now = new Date("2026-09-24T12:00:00Z");

const t3 = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: "t3",
  data: {
    id,
    name: `t3_${id}`,
    subreddit: "freelance",
    title: "Invoices &amp; taxes?",
    selftext: "a &lt;b&gt; c",
    author: "someone",
    score: 5,
    num_comments: 2,
    created_utc: 1790000000.0,
    permalink: `/r/freelance/comments/${id}/x/`,
    over_18: false,
    locked: false,
    stickied: false,
    ...extra,
  },
});

describe("RedditOAuth (wiki OAuth2)", () => {
  it("authorize: code, duration=permanent y scopes separados por espacio", () => {
    const url = new URL(
      new RedditOAuth({ userAgent: UA }).authorizeUrl({
        clientId: "cid",
        redirectUri: "http://localhost:3000/engagement/reddit/callback",
        state: "st",
        scopes: ["identity", "read", "submit"],
      }),
    );
    expect(url.origin + url.pathname).toBe("https://www.reddit.com/api/v1/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid",
      response_type: "code",
      state: "st",
      redirect_uri: "http://localhost:3000/engagement/reddit/callback",
      duration: "permanent",
      scope: "identity read submit",
    });
  });

  it("exchange: Basic auth + User-Agent, luego /api/v1/me en oauth.reddit.com", async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.url.endsWith("/access_token")
        ? {
            body: {
              access_token: "AT",
              token_type: "bearer",
              expires_in: 3600,
              scope: "identity read submit",
              refresh_token: "RT",
            },
          }
        : { body: { id: "abc", name: "myuser" } },
    );
    const oauth = new RedditOAuth({ userAgent: UA, fetch, now: () => now });
    const r = await oauth.exchangeCode({
      credentials: creds,
      code: "CODE",
      redirectUri: "http://x/cb",
    });
    expect(r.identity).toEqual({ id: "abc", username: "myuser" });
    expect(r.tokens).toEqual({
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: new Date(now.getTime() + 3600_000),
      scopes: ["identity", "read", "submit"],
    });
    const [token, me] = calls;
    expect(token?.url).toBe("https://www.reddit.com/api/v1/access_token");
    expect(token?.headers["Authorization"]).toBe(
      `Basic ${Buffer.from("cid:csecret").toString("base64")}`,
    );
    expect(token?.headers["User-Agent"]).toBe(UA);
    expect(new URLSearchParams(token?.body)).toEqual(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: "CODE",
        redirect_uri: "http://x/cb",
      }),
    );
    expect(me?.url).toBe("https://oauth.reddit.com/api/v1/me");
    expect(me?.headers["Authorization"]).toBe("bearer AT");
  });

  it("refresh conserva el refresh token (la respuesta no lo trae)", async () => {
    const { fetch } = fakeFetch(() => ({
      body: {
        access_token: "AT2",
        token_type: "bearer",
        expires_in: 3600,
        scope: "read",
      },
    }));
    const t = await new RedditOAuth({ userAgent: UA, fetch, now: () => now }).refresh({
      credentials: creds,
      refreshToken: "RT",
    });
    expect(t.refreshToken).toBe("RT");
    expect(t.accessToken).toBe("AT2");
  });

  it("invalid_grant en un 200 → unauthorized, sin el cuerpo en el cause", async () => {
    const { fetch } = fakeFetch(() => ({ body: { error: "invalid_grant" } }));
    const err = await new RedditOAuth({ userAgent: UA, fetch })
      .exchangeCode({ credentials: creds, code: "old", redirectUri: "http://x/cb" })
      .catch((e: unknown) => e);
    expect(isPortError(err) && err.code).toBe("unauthorized");
  });

  it("expires_in como instante (lectura literal de la wiki) también vale", async () => {
    const { fetch } = fakeFetch(() => ({
      body: { access_token: "A", expires_in: 1790003600 },
    }));
    const t = await new RedditOAuth({ userAgent: UA, fetch }).refresh({
      credentials: creds,
      refreshToken: "R",
    });
    expect(t.expiresAt).toEqual(new Date(1790003600 * 1000));
  });
});

describe("RedditApi", () => {
  it("listNew: listing documentado, texto desescapado, headers de tasa", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        kind: "Listing",
        data: { children: [t3("aaa"), { kind: "t1", data: {} }, t3("bbb")] },
      },
      headers: {
        "x-ratelimit-remaining": "58.0",
        "x-ratelimit-used": "2",
        "x-ratelimit-reset": "40",
      },
    }));
    const api = new RedditApi({ userAgent: UA, fetch, accessToken: "AT" });
    const r = await api.listNew("freelance", 500);
    expect(calls[0]?.url).toBe("https://oauth.reddit.com/r/freelance/new?limit=100");
    expect(calls[0]?.headers["User-Agent"]).toBe(UA);
    expect(r.data.map((p) => p.id)).toEqual(["aaa", "bbb"]);
    expect(r.data[0]?.title).toBe("Invoices & taxes?");
    expect(r.data[0]?.selftext).toBe("a <b> c");
    expect(r.rateLimit).toEqual({ used: 2, remaining: 58, resetSeconds: 40 });
  });

  it("429 → rate_limited con retryAfterSeconds del reset", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 429,
      body: { message: "Too Many Requests" },
      headers: { "x-ratelimit-reset": "17.2" },
    }));
    const err = await new RedditApi({ userAgent: UA, fetch, accessToken: "AT" })
      .listNew("x", 10)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect((err as PortError).code).toBe("rate_limited");
    expect((err as PortError).retryAfterSeconds).toBe(18);
  });

  it("401/403/404/5xx → códigos estables", async () => {
    for (const [status, code] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
      [503, "provider_unavailable"],
    ] as const) {
      const { fetch } = fakeFetch(() => ({ status, body: {} }));
      const err = await new RedditApi({ userAgent: UA, fetch, accessToken: "AT" })
        .listNew("x", 10)
        .catch((e: unknown) => e);
      expect((err as PortError).code).toBe(code);
    }
  });

  it("getThread: [link, comments], aplanado con replies anidadas", async () => {
    const { fetch } = fakeFetch(() => ({
      body: [
        { kind: "Listing", data: { children: [t3("aaa", { locked: true })] } },
        {
          kind: "Listing",
          data: {
            children: [
              {
                kind: "t1",
                data: {
                  name: "t1_c1",
                  parent_id: "t3_aaa",
                  author: "me",
                  body: "hi",
                  score: 1,
                  created_utc: 1,
                  replies: {
                    kind: "Listing",
                    data: {
                      children: [
                        {
                          kind: "t1",
                          data: {
                            name: "t1_c2",
                            parent_id: "t1_c1",
                            author: "[deleted]",
                            body: "x",
                          },
                        },
                      ],
                    },
                  },
                },
              },
              { kind: "more", data: { children: ["zz"] } },
            ],
          },
        },
      ],
    }));
    const r = await new RedditApi({ userAgent: UA, fetch, accessToken: "AT" }).getThread(
      "aaa",
      {
        limit: 50,
        depth: 3,
      },
    );
    expect(r.data.post.locked).toBe(true);
    expect(r.data.comments.map((c) => [c.name, c.parentId, c.author])).toEqual([
      ["t1_c1", "t3_aaa", "me"],
      ["t1_c2", "t1_c1", null],
    ]);
  });

  it("getThread con otra forma → provider_contract_violation", async () => {
    const { fetch } = fakeFetch(() => ({
      body: { kind: "Listing", data: { children: [] } },
    }));
    const err = await new RedditApi({ userAgent: UA, fetch, accessToken: "AT" })
      .getThread("aaa", { limit: 1, depth: 1 })
      .catch((e: unknown) => e);
    expect((err as PortError).code).toBe("provider_contract_violation");
  });

  it("postComment: form con api_type=json, thing_id y text", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        json: {
          errors: [],
          data: {
            things: [
              {
                kind: "t1",
                data: { name: "t1_new", permalink: "/r/x/comments/a/b/new/" },
              },
            ],
          },
        },
      },
    }));
    const r = await new RedditApi({
      userAgent: UA,
      fetch,
      accessToken: "AT",
    }).postComment("t3_aaa", "hello **world**");
    expect(r.data).toEqual({ name: "t1_new", permalink: "/r/x/comments/a/b/new/" });
    expect(calls[0]?.url).toBe("https://oauth.reddit.com/api/comment");
    expect(calls[0]?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({
      api_type: "json",
      thing_id: "t3_aaa",
      text: "hello **world**",
    });
  });

  it("postComment con errores → no finge éxito; sólo los códigos al cause", async () => {
    const { fetch } = fakeFetch(() => ({
      body: { json: { errors: [["THREAD_LOCKED", "that thread is locked", "parent"]] } },
    }));
    const err = await new RedditApi({ userAgent: UA, fetch, accessToken: "AT" })
      .postComment("t3_aaa", "x")
      .catch((e: unknown) => e);
    expect((err as PortError).code).toBe("bad_request");
    expect((err as PortError).cause).toEqual({ codes: ["THREAD_LOCKED"] });
  });

  it("postComment sin el comentario en la respuesta: enviado, id null", async () => {
    const { fetch } = fakeFetch(() => ({ body: { json: { errors: [] } } }));
    const r = await new RedditApi({
      userAgent: UA,
      fetch,
      accessToken: "AT",
    }).postComment("t3_a", "x");
    expect(r.data).toEqual({ name: null, permalink: null });
  });

  it("getRules: lee short_name/description; forma rara → sin reglas", async () => {
    const ok = fakeFetch(() => ({
      body: {
        rules: [{ short_name: "No self-promo", description: "Don&amp;t" }, { x: 1 }],
      },
    }));
    const r = await new RedditApi({
      userAgent: UA,
      fetch: ok.fetch,
      accessToken: "AT",
    }).getRules("x");
    expect(r.data).toEqual(["No self-promo: Don&t"]);
    const odd = fakeFetch(() => ({ body: { something: [] } }));
    const r2 = await new RedditApi({
      userAgent: UA,
      fetch: odd.fetch,
      accessToken: "AT",
    }).getRules("x");
    expect(r2.data).toEqual([]);
  });

  it("desescapa sólo lo documentado", () => {
    expect(unescapeRedditText("&lt;&gt;&amp;&quot;")).toBe("<>&&quot;");
  });
});

describe("FileRedditAppStore", () => {
  it("escribe 0600, relee, y borra", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fg-reddit-"));
    const path = join(dir, "reddit-app.json");
    const store = new FileRedditAppStore({ path, now: () => now });
    expect(await store.read()).toBeNull();
    await store.write({ clientId: "c", clientSecret: "s", developerUsername: "owner" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.read()).toEqual({
      clientId: "c",
      clientSecret: "s",
      developerUsername: "owner",
      updatedAt: now.toISOString(),
    });
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
    await store.write(null);
    expect(await store.read()).toBeNull();
  });
});
