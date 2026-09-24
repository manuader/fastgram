/**
 * OAuth por marca de punta a punta, sin red — `PU-PUB-001`, `PU-PUB-002`,
 * `P3-OAUTH-002`, `P3-OAUTH-008`.
 *
 * La app entera (`startApi`) con el adaptador real de archivo y de cifrado en
 * un `FASTGRAM_HOME` temporal, y `globalThis.fetch` reemplazado por un doble
 * que contesta **lo que documenta cada plataforma** (las URLs están junto a
 * cada cliente en `packages/adapters/src/oauth/`). Lo que se fija:
 *
 *  - `authorize` arma la URL con los parámetros de cada plataforma, y exige
 *    credenciales y (TikTok) https.
 *  - El callback crea la conexión **de la marca que autorizó**, con los
 *    tokens cifrados en la base, y el `state` no se reusa ni cruza de marca.
 *  - Ningún token ni secret sale por la API.
 *  - Acceso cruzado → 404.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { JOB_QUEUES } from "@fastgram/core";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const PUBLIC_URL = "https://fg-tunnel.example.com";
const SECRETS = ["x-secret-0123456789", "tt-secret-0123456789", "fb-secret-0123456789"];

let api: ApiHarness;
let home: string;
const previousEnv = {
  home: process.env["FASTGRAM_HOME"],
  publicUrl: process.env["FASTGRAM_PUBLIC_URL"],
};

/** Respuestas documentadas, por prefijo de URL. Un test puede pisar alguna. */
const routes = new Map<string, () => unknown>();
const fetchCalls: { url: string; body: string | undefined }[] = [];

function resetRoutes() {
  routes.clear();
  // X — https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
  routes.set("https://api.x.com/2/oauth2/token", () => ({
    token_type: "bearer",
    expires_in: 7200,
    access_token: "X-ACCESS-PLAINTEXT",
    scope: "tweet.read tweet.write users.read media.write offline.access",
    refresh_token: "X-REFRESH-PLAINTEXT",
  }));
  routes.set("https://api.x.com/2/users/me", () => ({
    data: {
      id: "4242",
      name: "Brand A",
      username: "brand_a",
      profile_image_url: "https://pbs/x.jpg",
    },
  }));
  // Facebook — manual-flow, get-long-lived, /me/accounts.
  routes.set("https://graph.facebook.com/v25.0/oauth/access_token", () => ({
    access_token: "FB-USER-PLAINTEXT",
    token_type: "bearer",
    expires_in: 5184000,
  }));
  routes.set("https://graph.facebook.com/v25.0/me/accounts", () => ({
    data: [
      { id: "page-1", name: "Page One", access_token: "FB-PAGE1-PLAINTEXT" },
      { id: "page-2", name: "Page Two", access_token: "FB-PAGE2-PLAINTEXT" },
    ],
    paging: {},
  }));
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fastgram-oauth-int-"));
  process.env["FASTGRAM_HOME"] = home;
  process.env["FASTGRAM_PUBLIC_URL"] = PUBLIC_URL;
  resetRoutes();
  vi.stubGlobal("fetch", (input: string, init: { body?: string }) => {
    fetchCalls.push({ url: input, body: init.body });
    const key = [...routes.keys()].find((k) => input.startsWith(k));
    if (key === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    const payload = routes.get(key)!();
    return Promise.resolve(
      payload instanceof Response ? payload : Response.json(payload),
    );
  });
  api = await startApi();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await api?.close();
  await rm(home, { recursive: true, force: true });
  if (previousEnv.home === undefined) delete process.env["FASTGRAM_HOME"];
  else process.env["FASTGRAM_HOME"] = previousEnv.home;
  if (previousEnv.publicUrl === undefined) delete process.env["FASTGRAM_PUBLIC_URL"];
  else process.env["FASTGRAM_PUBLIC_URL"] = previousEnv.publicUrl;
});

async function configure(platform: string, clientId: string, clientSecret: string) {
  const res = await api.request({
    method: "PUT",
    path: `/api/v1/integrations/${platform}`,
    body: { clientId, clientSecret },
  });
  expect(res.status).toBe(200);
  return res;
}

async function authorize(platform: string, token?: string) {
  const res = await api.request({
    method: "GET",
    path: `/api/v1/connections/${platform}/authorize`,
    ...(token === undefined ? {} : { token }),
  });
  return res;
}

interface ConnRow {
  company_id: string;
  platform: string;
  access_token: string | null;
  refresh_token: string | null;
  publishable: boolean;
  status: string;
  status_reason: string | null;
}

/** La fila tal cual está en la base (superusuario: sin RLS, para mirar). */
async function rowById(id: string): Promise<ConnRow | undefined> {
  const rows = await api.handle.sql<ConnRow[]>`
    select company_id, platform, access_token, refresh_token, publishable, status, status_reason
    from connections where id = ${id}`;
  return rows[0];
}

async function rowsOf(companyId: string): Promise<ConnRow[]> {
  return api.handle.sql<ConnRow[]>`
    select company_id, platform, access_token, refresh_token, publishable, status, status_reason
    from connections where company_id = ${companyId}`;
}

function stateOf(url: string): string {
  const state = new URL(url).searchParams.get("state");
  if (state === null) throw new Error("sin state");
  return state;
}

describe("integraciones (credenciales de las apps)", () => {
  it("authorize sin credenciales → 409 integration_not_configured", async () => {
    const res = await authorize("x");
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "integration_not_configured" });
  });

  it("guardar y leer nunca devuelve el secret; la redirect URI usa FASTGRAM_PUBLIC_URL", async () => {
    await configure("x", "x-client", SECRETS[0]!);
    await configure("tiktok", "tt-client-key", SECRETS[1]!);
    await configure("facebook", "fb-app-id", SECRETS[2]!);
    await configure("instagram", "ig-app-id", "ig-secret-0123456789");
    await configure("threads", "th-app-id", "th-secret-0123456789");
    const res = await api.request({ method: "GET", path: "/api/v1/integrations" });
    expect(res.status).toBe(200);
    for (const s of SECRETS) expect(res.raw).not.toContain(s);
    const overview = dataOf(res) as {
      apps: {
        platform: string;
        hasSecret: boolean;
        secretLast4: string;
        redirectUri: string;
      }[];
      redirectSource: string;
    };
    expect(overview.redirectSource).toBe("public_url");
    const x = overview.apps.find((a) => a.platform === "x")!;
    expect(x).toMatchObject({
      hasSecret: true,
      secretLast4: "6789",
      redirectUri: `${PUBLIC_URL}/api/fastgram/oauth/x/callback`,
    });
  });

  it("plataforma sin OAuth → 404", async () => {
    const res = await api.request({
      method: "PUT",
      path: "/api/v1/integrations/youtube",
      body: { clientId: "a" },
    });
    expect(res.status).toBe(404);
  });
});

describe("authorize: la URL de cada plataforma", () => {
  it("x: PKCE S256, scopes con espacio, redirect exacta", async () => {
    const res = await authorize("x");
    expect(res.status).toBe(200);
    const { url, redirectUri } = dataOf(res) as { url: string; redirectUri: string };
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe("https://x.com/i/oauth2/authorize");
    expect(u.searchParams.get("client_id")).toBe("x-client");
    expect(u.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("scope")).toBe(
      "tweet.read tweet.write users.read media.write offline.access",
    );
  });

  it("tiktok: client_key + video.upload; sin https → 409 https_redirect_required", async () => {
    const res = await authorize("tiktok");
    const u = new URL((dataOf(res) as { url: string }).url);
    expect(`${u.origin}${u.pathname}`).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(u.searchParams.get("client_key")).toBe("tt-client-key");
    expect(u.searchParams.get("scope")).toBe("user.info.basic,video.upload");

    delete process.env["FASTGRAM_PUBLIC_URL"];
    try {
      const local = await authorize("tiktok");
      expect(local.status).toBe(409);
      expect(errorOf(local).details).toMatchObject({ reason: "https_redirect_required" });
    } finally {
      process.env["FASTGRAM_PUBLIC_URL"] = PUBLIC_URL;
    }
  });

  it("instagram, threads y facebook", async () => {
    const ig = new URL((dataOf(await authorize("instagram")) as { url: string }).url);
    expect(`${ig.origin}${ig.pathname}`).toBe(
      "https://www.instagram.com/oauth/authorize",
    );
    expect(ig.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_content_publish",
    );
    const th = new URL((dataOf(await authorize("threads")) as { url: string }).url);
    expect(`${th.origin}${th.pathname}`).toBe("https://threads.com/oauth/authorize");
    const fb = new URL((dataOf(await authorize("facebook")) as { url: string }).url);
    expect(`${fb.origin}${fb.pathname}`).toBe(
      "https://www.facebook.com/v25.0/dialog/oauth",
    );
    expect(fb.searchParams.get("client_id")).toBe("fb-app-id");
  });
});

describe("callback", () => {
  let connectionId: string;

  it("crea la conexión de la marca que autorizó, con los tokens cifrados", async () => {
    const state = stateOf((dataOf(await authorize("x")) as { url: string }).url);
    fetchCalls.length = 0;
    const res = await api.request({
      method: "POST",
      path: "/api/v1/connections/x/callback",
      body: { state, code: "the-code" },
    });
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain("PLAINTEXT");
    const result = dataOf(res) as {
      kind: string;
      connection: { _id: string; username: string };
    };
    expect(result.kind).toBe("connected");
    expect(result.connection.username).toBe("brand_a");
    connectionId = result.connection._id;

    // El intercambio llevó el verifier guardado y la misma redirect URI.
    const tokenCall = fetchCalls.find((c) =>
      c.url.startsWith("https://api.x.com/2/oauth2/token"),
    );
    const form = new URLSearchParams(tokenCall?.body);
    expect(form.get("code")).toBe("the-code");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get("redirect_uri")).toBe(`${PUBLIC_URL}/api/fastgram/oauth/x/callback`);

    const row = await rowById(connectionId);
    expect(row?.company_id).toBe(api.data.a.companyId);
    expect(row?.platform).toBe("x");
    expect(row?.access_token).toMatch(/^v1\./);
    expect(row?.access_token).not.toContain("X-ACCESS-PLAINTEXT");
    expect(row?.refresh_token).not.toContain("X-REFRESH-PLAINTEXT");
    expect(row?.publishable).toBe(true);
  });

  it("el mismo state no se reusa", async () => {
    const state = stateOf((dataOf(await authorize("x")) as { url: string }).url);
    const first = await api.request({
      method: "POST",
      path: "/api/v1/connections/x/callback",
      body: { state, code: "c1" },
    });
    expect(first.status).toBe(200);
    const again = await api.request({
      method: "POST",
      path: "/api/v1/connections/x/callback",
      body: { state, code: "c1" },
    });
    expect(again.status).toBe(400);
    expect(errorOf(again).details).toMatchObject({ reason: "oauth_state_invalid" });
  });

  it("un state de otra marca se rechaza y no crea nada en ninguna", async () => {
    const state = stateOf((dataOf(await authorize("x")) as { url: string }).url);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/connections/x/callback",
      token: api.data.b.token,
      body: { state, code: "c" },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({ reason: "oauth_state_wrong_brand" });
    const bRows = await rowsOf(api.data.b.companyId);
    expect(bRows.every((r) => r.platform !== "x")).toBe(true);
  });

  it("permiso denegado → 400 oauth_denied (ERR-D04)", async () => {
    const state = stateOf((dataOf(await authorize("x")) as { url: string }).url);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/connections/x/callback",
      body: { state, error: "access_denied" },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({ reason: "oauth_denied" });
  });

  it("las cuentas de la marca no llevan tokens; la otra marca no las ve (y no puede tocarlas)", async () => {
    const mine = await api.request({
      method: "GET",
      path: "/api/v1/connections/accounts",
    });
    expect(mine.status).toBe(200);
    expect(mine.raw).not.toMatch(/PLAINTEXT|v1\.[A-Za-z0-9_-]{8,}\./);
    expect((dataOf(mine) as unknown as { _id: string }[]).map((c) => c._id)).toContain(
      connectionId,
    );

    const theirs = await api.request({
      method: "GET",
      path: "/api/v1/connections/accounts",
      token: api.data.b.token,
    });
    expect(
      (dataOf(theirs) as unknown as { _id: string }[]).map((c) => c._id),
    ).not.toContain(connectionId);

    for (const [method, path] of [
      ["DELETE", `/api/v1/connections/accounts/${connectionId}`],
      ["POST", `/api/v1/connections/accounts/${connectionId}/refresh`],
    ] as const) {
      const res = await api.request({ method, path, token: api.data.b.token });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("refresco rechazado por la plataforma → 409 connection_expired y la fila queda expired", async () => {
    routes.set(
      "https://api.x.com/2/oauth2/token",
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    try {
      const res = await api.request({
        method: "POST",
        path: `/api/v1/connections/accounts/${connectionId}/refresh`,
      });
      expect(res.status).toBe(409);
      expect(errorOf(res).details).toMatchObject({ reason: "connection_expired" });
      const row = await rowById(connectionId);
      expect(row).toMatchObject({ status: "expired", status_reason: "refresh_rejected" });
    } finally {
      resetRoutes();
    }

    // Reconectar la misma cuenta reactiva la misma fila.
    const state = stateOf((dataOf(await authorize("x")) as { url: string }).url);
    const again = await api.request({
      method: "POST",
      path: "/api/v1/connections/x/callback",
      body: { state, code: "c2" },
    });
    const conn = (dataOf(again) as { connection: { _id: string; status: string } })
      .connection;
    expect(conn).toMatchObject({ _id: connectionId, status: "active" });
  });

  it("facebook con dos Páginas: elegir una; la elección no cruza de marca", async () => {
    const state = stateOf((dataOf(await authorize("facebook")) as { url: string }).url);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/connections/facebook/callback",
      body: { state, code: "fb-code" },
    });
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain("PLAINTEXT");
    const choose = dataOf(res) as {
      kind: string;
      selectionId: string;
      pages: { id: string }[];
    };
    expect(choose.kind).toBe("choose_page");
    expect(choose.pages.map((p) => p.id)).toEqual(["page-1", "page-2"]);

    const cross = await api.request({
      method: "GET",
      path: `/api/v1/connections/facebook/pages/${choose.selectionId}`,
      token: api.data.b.token,
    });
    expect(cross.status).toBe(404);

    const picked = await api.request({
      method: "POST",
      path: "/api/v1/connections/facebook/pages",
      body: { selectionId: choose.selectionId, pageId: "page-2" },
    });
    expect(picked.status).toBe(200);
    const page = dataOf(picked) as {
      _id: string;
      username: string;
      tokenExpiresAt: null;
    };
    expect(page).toMatchObject({ username: "Page Two", tokenExpiresAt: null });
    const row = await rowById(page._id);
    expect(row?.company_id).toBe(api.data.a.companyId);
    expect(row?.access_token).not.toContain("FB-PAGE2-PLAINTEXT");

    // Ya usada.
    const reuse = await api.request({
      method: "POST",
      path: "/api/v1/connections/facebook/pages",
      body: { selectionId: choose.selectionId, pageId: "page-1" },
    });
    expect(reuse.status).toBe(404);
  });

  it("desconectar: 204, revoked y sin tokens", async () => {
    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/connections/accounts/${connectionId}`,
    });
    expect(res.status).toBe(204);
    const row = await rowById(connectionId);
    expect(row).toMatchObject({
      status: "revoked",
      access_token: null,
      refresh_token: null,
    });
  });
});

/**
 * Barrido al conectar — `PU-PUB-008`. Conectar, reconectar, elegir Página o
 * refrescar encola `publishing-sweep` con `{ companyId }` de la marca que
 * conectó, para que los posts en `AWAITING_RECONNECT` y los slots planificados
 * de la red se muevan ya y no a los 30 min (o nunca, en la primera conexión).
 */
describe("barrido de publicación al conectar", () => {
  const sweeps = () => api.queue.forQueue(JOB_QUEUES.publishingSweep);

  async function connectX(code: string): Promise<string> {
    const state = stateOf((dataOf(await authorize("x")) as { url: string }).url);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/connections/x/callback",
      body: { state, code },
    });
    expect(res.status).toBe(200);
    return (dataOf(res) as { connection: { _id: string } }).connection._id;
  }

  it("conectar encola un barrido de la marca que conectó", async () => {
    api.queue.reset();
    const id = await connectX("sweep-1");
    const jobs = sweeps();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ companyId: api.data.a.companyId });
    expect(jobs[0]?.options?.singletonKey).toContain(id);
  });

  it("reconectar la misma cuenta un rato después no se deduplica contra el barrido viejo", async () => {
    api.queue.reset();
    const first = await connectX("sweep-2");
    api.clock.advanceMs(1_000);
    const second = await connectX("sweep-3");
    expect(second).toBe(first);
    const jobs = sweeps();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.options?.singletonKey).not.toBe(jobs[1]?.options?.singletonKey);
  });

  it("un refresco exitoso también barre", async () => {
    const id = await connectX("sweep-4");
    api.queue.reset();
    api.clock.advanceMs(1_000);
    const res = await api.request({
      method: "POST",
      path: `/api/v1/connections/accounts/${id}/refresh`,
    });
    expect(res.status).toBe(200);
    expect(sweeps()).toHaveLength(1);
  });

  it("elegir la Página de Facebook barre; mostrar la lista no", async () => {
    const state = stateOf((dataOf(await authorize("facebook")) as { url: string }).url);
    api.queue.reset();
    const res = await api.request({
      method: "POST",
      path: "/api/v1/connections/facebook/callback",
      body: { state, code: "fb-sweep" },
    });
    const { selectionId } = dataOf(res) as { selectionId: string };
    expect(sweeps()).toHaveLength(0);
    const picked = await api.request({
      method: "POST",
      path: "/api/v1/connections/facebook/pages",
      body: { selectionId, pageId: "page-1" },
    });
    expect(picked.status).toBe(200);
    expect(sweeps()).toHaveLength(1);
    expect(sweeps()[0]?.payload).toEqual({ companyId: api.data.a.companyId });
  });

  it("un callback rechazado no barre; una cola caída no tumba la conexión", async () => {
    const state = stateOf((dataOf(await authorize("x")) as { url: string }).url);
    api.queue.reset();
    const denied = await api.request({
      method: "POST",
      path: "/api/v1/connections/x/callback",
      token: api.data.b.token,
      body: { state, code: "c" },
    });
    expect(denied.status).toBe(400);
    expect(sweeps()).toHaveLength(0);

    api.queue.failNext = true;
    const id = await connectX("sweep-5");
    expect((await rowById(id))?.status).toBe("active");
    // La ruta sí intentó encolar (se consumió el fallo) y no se llevó la conexión.
    expect(api.queue.failNext).toBe(false);
    expect(sweeps()).toHaveLength(0);
  });
});
