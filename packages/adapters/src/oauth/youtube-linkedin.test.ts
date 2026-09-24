/**
 * YouTube (OAuth de Google) y LinkedIn contra un `fetch` que imita las
 * respuestas documentadas (`PU-LATER-001`, `PU-LATER-002`). Las URLs de la doc
 * están en la cabecera de `youtube.ts` y `linkedin.ts`. Sin red.
 */
import { describe, expect, it } from "vitest";
import { isPortError } from "@fastgram/ports";

import { LinkedInOAuthClient, linkedinPersonUrn } from "./linkedin.js";
import { YouTubeOAuthClient } from "./youtube.js";
import type { OAuthFetch } from "./http.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const creds = { clientId: "client-id", clientSecret: "client-secret" };
const redirectUri = "https://fg.example.com/api/fastgram/oauth/youtube/callback";

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
    // La clave más larga que matchea: `…/rest/organizationAcls` antes que `…/rest`.
    const key = Object.keys(routes)
      .filter((k) => input.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    const route = routes[key];
    const payload =
      typeof route === "function" ? (route as (c: Call) => unknown)(call) : route;
    if (payload instanceof Response) return Promise.resolve(payload);
    return Promise.resolve(Response.json(payload));
  };
  return { fetch, calls };
}

const form = (call: Call | undefined) =>
  Object.fromEntries(new URLSearchParams(call?.body));
const q = (url: string) => Object.fromEntries(new URL(url).searchParams);

/* ------------------------------------------------------------------------ *
 * YouTube
 * ------------------------------------------------------------------------ */

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const CHANNELS = "https://www.googleapis.com/youtube/v3/channels";
const YT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

/** Forma de https://developers.google.com/identity/protocols/oauth2/web-server */
const googleToken = {
  access_token: "ya29.PLAINTEXT",
  expires_in: 3599,
  refresh_token: "1//REFRESH-PLAINTEXT",
  scope: YT_SCOPES.join(" "),
  token_type: "Bearer",
};

/** Forma de https://developers.google.com/youtube/v3/docs/channels */
const channelList = {
  kind: "youtube#channelListResponse",
  items: [
    {
      kind: "youtube#channel",
      id: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      snippet: {
        title: "Marca A",
        customUrl: "@marca-a",
        thumbnails: { default: { url: "https://yt3.ggpht.com/a.jpg" } },
      },
    },
  ],
};

describe("YouTube · OAuth de Google", () => {
  it("authorize: endpoint v2, code, scopes con espacio, offline + consent", () => {
    const url = new YouTubeOAuthClient().authorizeUrl({
      credentials: creds,
      redirectUri,
      state: "st",
      scopes: YT_SCOPES,
    });
    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    expect(q(url)).toEqual({
      client_id: "client-id",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: YT_SCOPES.join(" "),
      state: "st",
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
    });
  });

  it("intercambio: form con grant_type y redirect exacta; identidad = el canal", async () => {
    const { fetch, calls } = fakeFetch({
      [GOOGLE_TOKEN]: googleToken,
      [CHANNELS]: channelList,
    });
    const client = new YouTubeOAuthClient({ fetch, now: () => NOW });
    const [account, ...rest] = await client.exchangeCode({
      credentials: creds,
      redirectUri,
      code: "4/0Ab",
    });
    expect(rest).toHaveLength(0);
    expect(account?.identity).toEqual({
      platformUserId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      username: "marca-a",
      displayName: "Marca A",
      avatarUrl: "https://yt3.ggpht.com/a.jpg",
    });
    expect(account?.tokens).toMatchObject({
      accessToken: "ya29.PLAINTEXT",
      refreshToken: "1//REFRESH-PLAINTEXT",
      scopes: YT_SCOPES,
    });
    expect(account?.tokens.expiresAt?.getTime()).toBe(NOW.getTime() + 3599_000);

    expect(form(calls[0])).toEqual({
      code: "4/0Ab",
      client_id: "client-id",
      client_secret: "client-secret",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const channelsCall = calls.find((c) => c.url.startsWith(CHANNELS));
    expect(q(channelsCall?.url ?? "https://x")).toEqual({
      part: "snippet",
      mine: "true",
    });
    expect(channelsCall?.headers["Authorization"]).toBe("Bearer ya29.PLAINTEXT");
  });

  it("una cuenta de Google sin canal no devuelve cuentas", async () => {
    const { fetch } = fakeFetch({
      [GOOGLE_TOKEN]: googleToken,
      [CHANNELS]: { kind: "youtube#channelListResponse", pageInfo: { totalResults: 0 } },
    });
    const accounts = await new YouTubeOAuthClient({ fetch }).exchangeCode({
      credentials: creds,
      redirectUri,
      code: "c",
    });
    expect(accounts).toEqual([]);
  });

  it("refresco: grant_type=refresh_token; sin refresh token nuevo se conserva el guardado", async () => {
    const { fetch, calls } = fakeFetch({
      [GOOGLE_TOKEN]: {
        access_token: "ya29.NEW",
        expires_in: 3599,
        token_type: "Bearer",
      },
    });
    const tokens = await new YouTubeOAuthClient({ fetch, now: () => NOW }).refresh({
      credentials: creds,
      accessToken: "old",
      refreshToken: "1//REFRESH",
    });
    expect(tokens.accessToken).toBe("ya29.NEW");
    expect(tokens.refreshToken).toBeUndefined();
    expect(form(calls[0])).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "1//REFRESH",
      grant_type: "refresh_token",
    });
  });

  it("invalid_grant (refresh revocado) → unauthorized", async () => {
    const { fetch } = fakeFetch({
      [GOOGLE_TOKEN]: new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
        { status: 400 },
      ),
    });
    const error: unknown = await new YouTubeOAuthClient({ fetch })
      .refresh({ credentials: creds, accessToken: "a", refreshToken: "r" })
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("unauthorized");
  });
});

/* ------------------------------------------------------------------------ *
 * LinkedIn
 * ------------------------------------------------------------------------ */

const LI_TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO = "https://api.linkedin.com/v2/userinfo";
const ACLS = "https://api.linkedin.com/rest/organizationAcls";
const LOOKUP = "https://api.linkedin.com/rest/organizationsLookup";

/** https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow */
const liToken = (scope: string) => ({
  access_token: "AQV-PLAINTEXT",
  expires_in: 5184000,
  scope,
});

/** https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2 */
const userinfo = {
  sub: "782bbtaQ",
  name: "John Doe",
  given_name: "John",
  family_name: "Doe",
  picture: "https://media.licdn.com/dms/image/C5F03.jpg",
  locale: "en-US",
};

describe("LinkedIn · 3-legged OAuth", () => {
  it("authorize: response_type=code y scopes separados por espacio", () => {
    const url = new LinkedInOAuthClient().authorizeUrl({
      credentials: creds,
      redirectUri,
      state: "st",
      scopes: ["openid", "profile", "w_member_social"],
    });
    expect(url.startsWith("https://www.linkedin.com/oauth/v2/authorization?")).toBe(true);
    expect(q(url)).toEqual({
      response_type: "code",
      client_id: "client-id",
      redirect_uri: redirectUri,
      state: "st",
      scope: "openid profile w_member_social",
    });
  });

  it("sólo perfil: una cuenta con el Person URN de `sub`; sin llamar a organizationAcls", async () => {
    const { fetch, calls } = fakeFetch({
      [LI_TOKEN]: liToken("openid,profile,w_member_social"),
      [USERINFO]: userinfo,
    });
    const accounts = await new LinkedInOAuthClient({
      fetch,
      now: () => NOW,
    }).exchangeCode({
      credentials: creds,
      redirectUri,
      code: "AQT",
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.identity).toEqual({
      platformUserId: linkedinPersonUrn("782bbtaQ"),
      username: "John Doe",
      displayName: "John Doe",
      avatarUrl: "https://media.licdn.com/dms/image/C5F03.jpg",
    });
    expect(accounts[0]?.tokens.expiresAt?.getTime()).toBe(NOW.getTime() + 5184000_000);
    expect(accounts[0]?.tokens.refreshToken).toBeUndefined();
    expect(form(calls[0])).toEqual({
      grant_type: "authorization_code",
      code: "AQT",
      client_id: "client-id",
      client_secret: "client-secret",
      redirect_uri: redirectUri,
    });
    expect(calls.some((c) => c.url.startsWith(ACLS))).toBe(false);
  });

  it("con los scopes de Páginas: perfil + una cuenta por Página con rol que publica", async () => {
    const { fetch, calls } = fakeFetch({
      [LI_TOKEN]: liToken(
        "openid profile w_member_social w_organization_social r_organization_admin",
      ),
      [USERINFO]: userinfo,
      // Forma de organization-access-control-by-role: `organization` en un
      // ejemplo y `organizationTarget` en otros.
      [ACLS]: {
        elements: [
          {
            role: "ADMINISTRATOR",
            organization: "urn:li:organization:2414183",
            state: "APPROVED",
            roleAssignee: "urn:li:person:782bbtaQ",
          },
          {
            role: "CONTENT_ADMINISTRATOR",
            organizationTarget: "urn:li:organization:79988552",
            state: "APPROVED",
            roleAssignee: "urn:li:person:782bbtaQ",
          },
          {
            role: "ANALYST",
            organization: "urn:li:organization:111",
            state: "APPROVED",
            roleAssignee: "urn:li:person:782bbtaQ",
          },
        ],
        paging: { count: 10, start: 0, links: [] },
      },
      [LOOKUP]: {
        results: {
          "2414183": { localizedName: "Devtestco", id: 2414183 },
          "79988552": { localizedName: "FirstDemoCompany", id: 79988552 },
        },
        statuses: { "2414183": 200, "79988552": 200 },
        errors: {},
      },
    });
    const accounts = await new LinkedInOAuthClient({ fetch }).exchangeCode({
      credentials: creds,
      redirectUri,
      code: "AQT",
    });
    expect(accounts.map((a) => [a.identity.platformUserId, a.identity.username])).toEqual(
      [
        ["urn:li:person:782bbtaQ", "John Doe"],
        ["urn:li:organization:2414183", "Devtestco"],
        ["urn:li:organization:79988552", "FirstDemoCompany"],
      ],
    );
    const acl = calls.find((c) => c.url.startsWith(ACLS));
    expect(acl?.headers["LinkedIn-Version"]).toBe("202609");
    expect(acl?.headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
    expect(q(acl?.url ?? "https://x")).toEqual({ q: "roleAssignee", state: "APPROVED" });
    const lookup = calls.find((c) => c.url.startsWith(LOOKUP));
    expect(lookup?.url).toBe(`${LOOKUP}?ids=List(2414183,79988552)`);
  });

  it("si organizationAcls falla, queda el perfil (el code ya se gastó)", async () => {
    const { fetch } = fakeFetch({
      [LI_TOKEN]: liToken(
        "openid profile w_member_social w_organization_social r_organization_admin",
      ),
      [USERINFO]: userinfo,
      [ACLS]: new Response(JSON.stringify({ status: 403 }), { status: 403 }),
    });
    const accounts = await new LinkedInOAuthClient({ fetch }).exchangeCode({
      credentials: creds,
      redirectUri,
      code: "AQT",
    });
    expect(accounts.map((a) => a.identity.platformUserId)).toEqual([
      "urn:li:person:782bbtaQ",
    ]);
  });

  it("refresco programático: grant_type=refresh_token; 400 invalid_request → bad_request", async () => {
    const ok = fakeFetch({
      [LI_TOKEN]: {
        access_token: "AQV-NEW",
        expires_in: 5184000,
        refresh_token: "AQW-R",
        refresh_token_expires_in: 439200,
        scope: "r_basicprofile",
      },
    });
    const tokens = await new LinkedInOAuthClient({
      fetch: ok.fetch,
      now: () => NOW,
    }).refresh({
      credentials: creds,
      accessToken: "old",
      refreshToken: "AQW-R",
    });
    expect(tokens.refreshExpiresAt?.getTime()).toBe(NOW.getTime() + 439200_000);
    expect(form(ok.calls[0])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "AQW-R",
      client_id: "client-id",
      client_secret: "client-secret",
    });

    const bad = fakeFetch({
      [LI_TOKEN]: new Response(
        JSON.stringify({
          error: "invalid_request",
          error_description:
            "The provided authorization grant or refresh token is invalid, expired or revoked",
        }),
        { status: 400 },
      ),
    });
    const error: unknown = await new LinkedInOAuthClient({ fetch: bad.fetch })
      .refresh({ credentials: creds, accessToken: "a", refreshToken: "r" })
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("bad_request");
  });
});
