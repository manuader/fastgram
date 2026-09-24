/**
 * YouTube y LinkedIn de punta a punta, sin red — `PU-LATER-001`, `PU-LATER-002`.
 *
 * Mismo montaje que `connections.int.test.ts`: la app entera, el adaptador real
 * de archivo y de cifrado en un `FASTGRAM_HOME` temporal, y `globalThis.fetch`
 * reemplazado por un doble que contesta **lo que documenta cada plataforma**
 * (URLs en `packages/adapters/src/oauth/{youtube,linkedin}.ts`). Lo que se fija:
 *
 *  - `authorize` arma la URL de Google (offline + consent) y la de LinkedIn, con
 *    o sin los scopes de Páginas según la app de la instalación.
 *  - YouTube conecta el canal; LinkedIn con Páginas ofrece elegir y la elección
 *    sólo se resuelve por su ruta (`/connections/linkedin/pages`), no por la de
 *    Facebook.
 *  - `POST /content/:id/schedule` acepta YouTube y LinkedIn con sus topes y
 *    crea el post de esa red (antes LinkedIn no era programable).
 *  - Ningún token sale por la API.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { JOB_QUEUES } from "@fastgram/core";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const PUBLIC_URL = "https://fg-tunnel.example.com";
const CUANDO = new Date("2026-10-01T15:00:00.000Z").getTime();

let api: ApiHarness;
let home: string;
const previousEnv = {
  home: process.env["FASTGRAM_HOME"],
  publicUrl: process.env["FASTGRAM_PUBLIC_URL"],
};

const routes = new Map<string, () => unknown>();
const fetchCalls: { url: string; body: string | undefined }[] = [];

let liScope = "openid profile w_member_social";

function resetRoutes() {
  routes.clear();
  // Google — https://developers.google.com/identity/protocols/oauth2/web-server
  routes.set("https://oauth2.googleapis.com/token", () => ({
    access_token: "YT-ACCESS-PLAINTEXT",
    expires_in: 3599,
    refresh_token: "YT-REFRESH-PLAINTEXT",
    scope:
      "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    token_type: "Bearer",
  }));
  // https://developers.google.com/youtube/v3/docs/channels
  routes.set("https://www.googleapis.com/youtube/v3/channels", () => ({
    items: [
      {
        id: "UC-marca-a",
        snippet: { title: "Marca A", customUrl: "@marca-a", thumbnails: {} },
      },
    ],
  }));
  // LinkedIn — authorization-code-flow, sign-in-with-linkedin-v2,
  // organization-access-control-by-role, organization-lookup-api.
  routes.set("https://www.linkedin.com/oauth/v2/accessToken", () => ({
    access_token: "LI-ACCESS-PLAINTEXT",
    expires_in: 5184000,
    scope: liScope,
  }));
  routes.set("https://api.linkedin.com/v2/userinfo", () => ({
    sub: "782bbtaQ",
    name: "John Doe",
  }));
  routes.set("https://api.linkedin.com/rest/organizationAcls", () => ({
    elements: [
      {
        role: "ADMINISTRATOR",
        organization: "urn:li:organization:2414183",
        state: "APPROVED",
        roleAssignee: "urn:li:person:782bbtaQ",
      },
    ],
    paging: { count: 10, start: 0, links: [] },
  }));
  routes.set("https://api.linkedin.com/rest/organizationsLookup", () => ({
    results: { "2414183": { localizedName: "Devtestco", id: 2414183 } },
    statuses: { "2414183": 200 },
    errors: {},
  }));
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fastgram-yt-li-int-"));
  process.env["FASTGRAM_HOME"] = home;
  process.env["FASTGRAM_PUBLIC_URL"] = PUBLIC_URL;
  resetRoutes();
  vi.stubGlobal("fetch", (input: string, init: { body?: string }) => {
    fetchCalls.push({ url: input, body: init.body });
    const key = [...routes.keys()]
      .filter((k) => input.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    const payload = routes.get(key)!();
    return Promise.resolve(
      payload instanceof Response ? payload : Response.json(payload),
    );
  });
  api = await startApi();
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await api?.close();
  await rm(home, { recursive: true, force: true });
  if (previousEnv.home === undefined) delete process.env["FASTGRAM_HOME"];
  else process.env["FASTGRAM_HOME"] = previousEnv.home;
  if (previousEnv.publicUrl === undefined) delete process.env["FASTGRAM_PUBLIC_URL"];
  else process.env["FASTGRAM_PUBLIC_URL"] = previousEnv.publicUrl;
});

async function configure(platform: string, body: Record<string, unknown>) {
  const res = await api.request({
    method: "PUT",
    path: `/api/v1/integrations/${platform}`,
    body,
  });
  expect(res.status).toBe(200);
  return dataOf(res) as { scopes: string[]; optionalScopesEnabled: boolean };
}

async function authorizeUrl(platform: string): Promise<URL> {
  const res = await api.request({
    method: "GET",
    path: `/api/v1/connections/${platform}/authorize`,
  });
  expect(res.status).toBe(200);
  return new URL((dataOf(res) as { url: string }).url);
}

async function callback(platform: string, url: URL, code: string) {
  return api.request({
    method: "POST",
    path: `/api/v1/connections/${platform}/callback`,
    body: { state: url.searchParams.get("state"), code },
  });
}

describe("YouTube · conectar el canal", () => {
  let connectionId = "";

  it("authorize: Google v2, offline + consent, upload + readonly", async () => {
    await configure("youtube", {
      clientId: "yt-client.apps.googleusercontent.com",
      clientSecret: "GOCSPX-0123456789",
    });
    const url = await authorizeUrl("youtube");
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${PUBLIC_URL}/api/fastgram/oauth/youtube/callback`,
    );
  });

  it("callback: conecta el canal con los tokens cifrados", async () => {
    const res = await callback("youtube", await authorizeUrl("youtube"), "4/0Ab");
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain("PLAINTEXT");
    const { kind, connection } = dataOf(res) as {
      kind: string;
      connection: {
        _id: string;
        platform: string;
        username: string;
        publishable: boolean;
      };
    };
    expect(kind).toBe("connected");
    expect(connection).toMatchObject({
      platform: "youtube",
      username: "marca-a",
      publishable: true,
    });
    connectionId = connection._id;
    const [row] = await api.handle.sql<
      { access_token: string; refresh_token: string; platform_user_id: string }[]
    >`select access_token, refresh_token, platform_user_id from connections where id = ${connectionId}`;
    expect(row?.platform_user_id).toBe("UC-marca-a");
    expect(row?.access_token).not.toContain("YT-ACCESS-PLAINTEXT");
    expect(row?.refresh_token).not.toContain("YT-REFRESH-PLAINTEXT");
  });

  it("refrescar ya: grant_type=refresh_token contra el token endpoint de Google", async () => {
    fetchCalls.length = 0;
    const res = await api.request({
      method: "POST",
      path: `/api/v1/connections/accounts/${connectionId}/refresh`,
    });
    expect(res.status).toBe(200);
    const call = fetchCalls.find((c) => c.url === "https://oauth2.googleapis.com/token");
    expect(new URLSearchParams(call?.body).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(call?.body).get("refresh_token")).toBe(
      "YT-REFRESH-PLAINTEXT",
    );
  });

  it("schedule: título ≤ 100 → 201 y encola publishing; 101 → 400", async () => {
    api.queue.reset();
    const ok = await api.request({
      method: "POST",
      path: `/api/v1/content/${api.data.a.contentId}/schedule`,
      body: {
        scheduledAtUtc: CUANDO,
        targets: [
          { platform: "youtube", connectionId, caption: "Short", description: "d" },
        ],
      },
    });
    expect(ok.status).toBe(201);
    expect(api.queue.forQueue(JOB_QUEUES.publishing)).toHaveLength(1);

    const tooLong = await api.request({
      method: "POST",
      path: `/api/v1/content/${api.data.a.contentId}/schedule`,
      body: {
        scheduledAtUtc: CUANDO,
        targets: [{ platform: "youtube", connectionId, caption: "a".repeat(101) }],
      },
    });
    expect(tooLong.status).toBe(400);
  });
});

describe("LinkedIn · perfil o Página", () => {
  it("sin los opcionales: pide sólo openid/profile/w_member_social y conecta el perfil", async () => {
    const saved = await configure("linkedin", {
      clientId: "li-client",
      clientSecret: "li-secret-0123456789",
    });
    expect(saved.optionalScopesEnabled).toBe(false);
    const url = await authorizeUrl("linkedin");
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://www.linkedin.com/oauth/v2/authorization",
    );
    expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");

    liScope = "openid profile w_member_social";
    const res = await callback("linkedin", url, "AQT-1");
    expect(res.status).toBe(200);
    const { kind, connection } = dataOf(res) as {
      kind: string;
      connection: { platformUserId: string; username: string };
    };
    expect(kind).toBe("connected");
    expect(connection).toMatchObject({
      platformUserId: "urn:li:person:782bbtaQ",
      username: "John Doe",
    });
  });

  it("sin túnel: LinkedIn exige https → 409 https_redirect_required", async () => {
    delete process.env["FASTGRAM_PUBLIC_URL"];
    try {
      const res = await api.request({
        method: "GET",
        path: "/api/v1/connections/linkedin/authorize",
      });
      expect(res.status).toBe(409);
      expect(errorOf(res).details).toMatchObject({ reason: "https_redirect_required" });
    } finally {
      process.env["FASTGRAM_PUBLIC_URL"] = PUBLIC_URL;
    }
  });

  let pageConnectionId = "";

  it("con los opcionales: ofrece perfil y Página, y se elige por la ruta de LinkedIn", async () => {
    const saved = await configure("linkedin", {
      clientId: "li-client",
      optionalScopes: true,
    });
    expect(saved.optionalScopesEnabled).toBe(true);
    const url = await authorizeUrl("linkedin");
    expect(url.searchParams.get("scope")).toBe(
      "openid profile w_member_social w_organization_social r_organization_admin",
    );

    liScope = "openid,profile,w_member_social,w_organization_social,r_organization_admin";
    const res = await callback("linkedin", url, "AQT-2");
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain("PLAINTEXT");
    const choose = dataOf(res) as {
      kind: string;
      selectionId: string;
      pages: { id: string; name: string }[];
    };
    expect(choose.kind).toBe("choose_page");
    expect(choose.pages).toEqual([
      { id: "urn:li:person:782bbtaQ", name: "John Doe", avatarUrl: null },
      { id: "urn:li:organization:2414183", name: "Devtestco", avatarUrl: null },
    ]);

    // La elección de LinkedIn no se resuelve por la ruta de Facebook.
    const wrongRoute = await api.request({
      method: "GET",
      path: `/api/v1/connections/facebook/pages/${choose.selectionId}`,
    });
    expect(wrongRoute.status).toBe(404);
    const cross = await api.request({
      method: "GET",
      path: `/api/v1/connections/linkedin/pages/${choose.selectionId}`,
      token: api.data.b.token,
    });
    expect(cross.status).toBe(404);

    const listed = await api.request({
      method: "GET",
      path: `/api/v1/connections/linkedin/pages/${choose.selectionId}`,
    });
    expect(dataOf(listed)).toMatchObject({ platform: "linkedin" });

    api.queue.reset();
    const picked = await api.request({
      method: "POST",
      path: "/api/v1/connections/linkedin/pages",
      body: { selectionId: choose.selectionId, pageId: "urn:li:organization:2414183" },
    });
    expect(picked.status).toBe(200);
    const page = dataOf(picked) as {
      _id: string;
      platform: string;
      username: string;
      publishable: boolean;
      tokenExpiresAt: number | null;
    };
    expect(page).toMatchObject({
      platform: "linkedin",
      username: "Devtestco",
      publishable: true,
    });
    // 60 días, como dice la respuesta del token.
    expect(page.tokenExpiresAt).not.toBeNull();
    expect(api.queue.forQueue(JOB_QUEUES.publishingSweep)).toHaveLength(1);
    pageConnectionId = page._id;

    const [row] = await api.handle.sql<
      { access_token: string; platform_user_id: string }[]
    >`
      select access_token, platform_user_id from connections where id = ${pageConnectionId}`;
    expect(row?.platform_user_id).toBe("urn:li:organization:2414183");
    expect(row?.access_token).not.toContain("LI-ACCESS-PLAINTEXT");
  });

  it("schedule: LinkedIn ya es programable, con commentary ≤ 3000", async () => {
    api.queue.reset();
    const ok = await api.request({
      method: "POST",
      path: `/api/v1/content/${api.data.a.contentId}/schedule`,
      body: {
        scheduledAtUtc: CUANDO,
        targets: [
          { platform: "linkedin", connectionId: pageConnectionId, caption: "Hola" },
        ],
      },
    });
    expect(ok.status).toBe(201);
    const [post] = await api.handle.sql<{ platform: string; caption: string }[]>`
      select platform, caption from posts where connection_id = ${pageConnectionId}`;
    expect(post).toEqual({ platform: "linkedin", caption: "Hola" });
    expect(api.queue.forQueue(JOB_QUEUES.publishing)).toHaveLength(1);

    const tooLong = await api.request({
      method: "POST",
      path: `/api/v1/content/${api.data.a.contentId}/schedule`,
      body: {
        scheduledAtUtc: CUANDO,
        targets: [
          {
            platform: "linkedin",
            connectionId: pageConnectionId,
            caption: "a".repeat(3001),
          },
        ],
      },
    });
    expect(tooLong.status).toBe(400);
  });

  it("la vista de integraciones nunca lleva el secret", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/integrations" });
    expect(res.raw).not.toContain("li-secret-0123456789");
    expect(res.raw).not.toContain("GOCSPX-0123456789");
    const apps = (dataOf(res) as { apps: { platform: string }[] }).apps.map(
      (a) => a.platform,
    );
    expect(apps).toEqual([
      "instagram",
      "tiktok",
      "x",
      "threads",
      "facebook",
      "youtube",
      "linkedin",
    ]);
  });
});
