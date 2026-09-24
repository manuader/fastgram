/**
 * Los cinco clientes contra un `fetch` que imita las respuestas **tal como
 * están documentadas** (las URLs de la doc están junto a cada cliente). Sin red.
 */
import { describe, expect, it } from "vitest";
import { isPortError } from "@fastgram/ports";

import { createOAuthClients } from "./index.js";
import type { OAuthFetch } from "./http.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const creds = { clientId: "client-id", clientSecret: "client-secret" };
const redirectUri = "https://fg.example.com/api/fastgram/oauth/x/callback";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

function fakeFetch(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const fetch: OAuthFetch = (input, init) => {
    const call = {
      url: input,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => input.startsWith(k));
    if (key === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    const route = routes[key];
    const payload =
      typeof route === "function" ? (route as (c: Call) => unknown)(call) : route;
    if (payload instanceof Response) return Promise.resolve(payload);
    return Promise.resolve(Response.json(payload));
  };
  return { fetch, calls };
}

const q = (url: string) => new URL(url).searchParams;

describe("URLs de autorización", () => {
  const clients = createOAuthClients();
  const base = { credentials: creds, redirectUri, state: "st" };

  it("instagram", () => {
    const url = clients.instagram.authorizeUrl({ ...base, scopes: ["a", "b"] });
    expect(url.startsWith("https://www.instagram.com/oauth/authorize?")).toBe(true);
    expect(Object.fromEntries(q(url))).toEqual({
      client_id: "client-id",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "a,b",
      state: "st",
    });
  });

  it("tiktok usa client_key y scopes con coma", () => {
    const url = clients.tiktok.authorizeUrl({
      ...base,
      scopes: ["user.info.basic", "video.upload"],
    });
    expect(url.startsWith("https://www.tiktok.com/v2/auth/authorize/?")).toBe(true);
    expect(q(url).get("client_key")).toBe("client-id");
    expect(q(url).get("scope")).toBe("user.info.basic,video.upload");
  });

  it("x exige PKCE S256 y scopes con espacio", () => {
    expect(() => clients.x.authorizeUrl({ ...base, scopes: ["a"] })).toThrow();
    const url = clients.x.authorizeUrl({
      ...base,
      scopes: ["a", "b"],
      codeChallenge: "ch",
    });
    expect(url.startsWith("https://x.com/i/oauth2/authorize?")).toBe(true);
    expect(q(url).get("scope")).toBe("a b");
    expect(q(url).get("code_challenge_method")).toBe("S256");
    expect(q(url).get("code_challenge")).toBe("ch");
  });

  it("threads y facebook", () => {
    expect(clients.threads.authorizeUrl({ ...base, scopes: ["t"] })).toMatch(
      /^https:\/\/threads\.com\/oauth\/authorize\?/,
    );
    expect(clients.facebook.authorizeUrl({ ...base, scopes: ["p"] })).toMatch(
      /^https:\/\/www\.facebook\.com\/v25\.0\/dialog\/oauth\?/,
    );
  });
});

describe("intercambio del code", () => {
  it("instagram: corto → largo → /me", async () => {
    const { fetch, calls } = fakeFetch({
      "https://api.instagram.com/oauth/access_token": {
        data: [
          {
            access_token: "short",
            user_id: "app-scoped",
            permissions: "instagram_business_basic,instagram_business_content_publish",
          },
        ],
      },
      "https://graph.instagram.com/access_token": {
        access_token: "long",
        token_type: "bearer",
        expires_in: 5183944,
      },
      "https://graph.instagram.com/v25.0/me": {
        user_id: "17841400000000000",
        username: "brand",
        name: "Brand",
        profile_picture_url: "https://cdn.example/p.jpg",
      },
    });
    const [account] = await createOAuthClients({
      fetch,
      now: () => NOW,
    }).instagram.exchangeCode({
      credentials: creds,
      redirectUri,
      code: "the-code",
    });
    expect(account?.identity).toEqual({
      platformUserId: "17841400000000000",
      username: "brand",
      displayName: "Brand",
      avatarUrl: "https://cdn.example/p.jpg",
    });
    expect(account?.tokens.accessToken).toBe("long");
    expect(account?.tokens.expiresAt?.getTime()).toBe(NOW.getTime() + 5183944 * 1000);
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe(redirectUri);
    expect(q(calls[1]!.url).get("grant_type")).toBe("ig_exchange_token");
  });

  it("tiktok: token + user/info (con error.code ok)", async () => {
    const { fetch, calls } = fakeFetch({
      "https://open.tiktokapis.com/v2/oauth/token/": {
        access_token: "act",
        expires_in: 86400,
        open_id: "open-1",
        refresh_token: "rft",
        refresh_expires_in: 31536000,
        scope: "user.info.basic,video.upload",
        token_type: "Bearer",
      },
      "https://open.tiktokapis.com/v2/user/info/": {
        data: {
          user: { open_id: "open-1", display_name: "Brand TT", avatar_url: "https://a" },
        },
        error: { code: "ok", message: "", log_id: "x" },
      },
    });
    const [account] = await createOAuthClients({
      fetch,
      now: () => NOW,
    }).tiktok.exchangeCode({
      credentials: creds,
      redirectUri,
      code: "c",
    });
    expect(account?.identity).toMatchObject({
      platformUserId: "open-1",
      username: "Brand TT",
    });
    expect(account?.tokens).toMatchObject({
      accessToken: "act",
      refreshToken: "rft",
      scopes: ["user.info.basic", "video.upload"],
    });
    expect(new URLSearchParams(calls[0]!.body).get("client_key")).toBe("client-id");
    expect(calls[1]!.headers["Authorization"]).toBe("Bearer act");
  });

  it("x: Basic auth + code_verifier, y /2/users/me", async () => {
    const { fetch, calls } = fakeFetch({
      "https://api.x.com/2/oauth2/token": {
        token_type: "bearer",
        expires_in: 7200,
        access_token: "xat",
        scope: "tweet.read tweet.write users.read media.write offline.access",
        refresh_token: "xrt",
      },
      "https://api.x.com/2/users/me": {
        data: {
          id: "42",
          name: "Brand",
          username: "brand",
          profile_image_url: "https://i",
        },
      },
    });
    const [account] = await createOAuthClients({ fetch, now: () => NOW }).x.exchangeCode({
      credentials: creds,
      redirectUri,
      code: "c",
      codeVerifier: "v",
    });
    expect(account?.identity.username).toBe("brand");
    expect(calls[0]!.headers["Authorization"]).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(new URLSearchParams(calls[0]!.body).get("code_verifier")).toBe("v");
  });

  it("facebook: una cuenta por Página, tokens sin vencimiento", async () => {
    const { fetch } = fakeFetch({
      "https://graph.facebook.com/v25.0/oauth/access_token": (call: Call) =>
        q(call.url).get("grant_type") === "fb_exchange_token"
          ? { access_token: "user-long", token_type: "bearer", expires_in: 5184000 }
          : { access_token: "user-short", token_type: "bearer", expires_in: 3600 },
      "https://graph.facebook.com/v25.0/me/accounts": {
        data: [
          {
            id: "p1",
            name: "Page One",
            access_token: "pt1",
            picture: { data: { url: "https://p1" } },
          },
          { id: "p2", name: "Page Two", access_token: "pt2" },
        ],
        paging: {},
      },
    });
    const accounts = await createOAuthClients({ fetch }).facebook.exchangeCode({
      credentials: creds,
      redirectUri,
      code: "c",
    });
    expect(
      accounts.map((a) => [
        a.identity.platformUserId,
        a.tokens.accessToken,
        a.tokens.expiresAt,
      ]),
    ).toEqual([
      ["p1", "pt1", null],
      ["p2", "pt2", null],
    ]);
    expect(accounts[0]?.identity.avatarUrl).toBe("https://p1");
  });

  it("errores: invalid_grant → unauthorized; 5xx → provider_unavailable; y el cause no lleva cuerpo", async () => {
    const { fetch } = fakeFetch({
      "https://api.x.com/2/oauth2/token": new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "secret stuff" }),
        { status: 400 },
      ),
    });
    const err = await createOAuthClients({ fetch })
      .x.refresh({ credentials: creds, accessToken: "a", refreshToken: "r" })
      .catch((e: unknown) => e);
    expect(isPortError(err) && err.code).toBe("unauthorized");
    expect(JSON.stringify((err as Error).cause)).not.toContain("secret stuff");

    const down = fakeFetch({
      "https://graph.threads.net/refresh_access_token": new Response("oops", {
        status: 502,
      }),
    });
    const err2 = await createOAuthClients({ fetch: down.fetch })
      .threads.refresh({ credentials: creds, accessToken: "a" })
      .catch((e: unknown) => e);
    expect(isPortError(err2) && err2.code).toBe("provider_unavailable");
  });
});
