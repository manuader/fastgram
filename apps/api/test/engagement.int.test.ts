/**
 * `/engagement/*` contra Postgres real y un `fetch` falso que imita las
 * respuestas documentadas de Reddit. **Nunca** se llama a Reddit.
 *
 * Lo que más importa medir:
 * - "Send" no sale sin `confirm: true`, sin `Idempotency-Key`, con el ban
 *   meter en `danger` (calculado en código) ni con un borrador que nombra la
 *   marca sin divulgar — y en esos casos **no hay ninguna llamada a Reddit**.
 * - Los tokens quedan cifrados en la base y el secret de la app nunca vuelve.
 * - Cross-tenant es 404.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_QUEUES } from "@fastgram/core";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const SECRET = "reddit-secret-0123456789";
let api: ApiHarness;
let home: string;
const previousHome = process.env["FASTGRAM_HOME"];

interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
}
const calls: FetchCall[] = [];
const routes = new Map<string, () => Response>();

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function resetRoutes(): void {
  routes.clear();
  // wiki OAuth2: respuesta del access_token.
  routes.set("https://www.reddit.com/api/v1/access_token", () =>
    json({
      access_token: "REDDIT-ACCESS-PLAINTEXT",
      token_type: "bearer",
      expires_in: 3600,
      scope: "identity read submit",
      refresh_token: "REDDIT-REFRESH-PLAINTEXT",
    }),
  );
  routes.set("https://oauth.reddit.com/api/v1/me", () =>
    json({ id: "u123", name: "acme_founder" }),
  );
  routes.set("https://oauth.reddit.com/api/comment", () =>
    json({
      json: {
        errors: [],
        data: {
          things: [
            {
              kind: "t1",
              data: {
                name: "t1_newc",
                permalink: "/r/freelance/comments/abc123/x/newc/",
              },
            },
          ],
        },
      },
    }),
  );
  routes.set(
    "https://www.reddit.com/api/v1/revoke_token",
    () => new Response("", { status: 200 }),
  );
}

const redditCalls = (prefix: string) => calls.filter((c) => c.url.startsWith(prefix));

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fastgram-engagement-int-"));
  process.env["FASTGRAM_HOME"] = home;
  resetRoutes();
  vi.stubGlobal(
    "fetch",
    (
      input: string,
      init: { method?: string; body?: string; headers?: Record<string, string> },
    ) => {
      calls.push({
        url: input,
        method: init.method ?? "GET",
        body: init.body,
        headers: init.headers ?? {},
      });
      const key = [...routes.keys()].find((k) => input.startsWith(k));
      if (key === undefined) return Promise.resolve(json({}, 404));
      return Promise.resolve(routes.get(key)!());
    },
  );
  api = await startApi({ now: "2026-09-24T12:00:00.000Z" });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await api?.close();
  await rm(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env["FASTGRAM_HOME"];
  else process.env["FASTGRAM_HOME"] = previousHome;
});

beforeEach(() => {
  calls.length = 0;
  resetRoutes();
  api.queue.reset();
});

async function configureApp(): Promise<void> {
  const res = await api.request({
    method: "PUT",
    path: "/api/v1/engagement/reddit-app",
    body: {
      clientId: "reddit-client",
      clientSecret: SECRET,
      developerUsername: "u/acme_dev",
    },
  });
  expect(res.status).toBe(200);
}

async function connect(): Promise<void> {
  await configureApp();
  const auth = await api.request({
    method: "GET",
    path: "/api/v1/engagement/reddit/authorize",
  });
  const state = new URL(dataOf(auth)["url"] as string).searchParams.get("state")!;
  const res = await api.request({
    method: "POST",
    path: "/api/v1/engagement/reddit/callback",
    body: { state, code: "CODE" },
  });
  expect(res.status).toBe(200);
}

async function manualLead(postId = "abc123", token?: string): Promise<string> {
  const res = await api.request({
    method: "POST",
    path: "/api/v1/engagement/leads",
    body: {
      url: `https://www.reddit.com/r/freelance/comments/${postId}/how_do_you_invoice/`,
      title: "How do you invoice clients?",
      body: "Looking for a simple way.",
    },
    ...(token === undefined ? {} : { token }),
  });
  expect([200, 201]).toContain(res.status);
  return dataOf(res)["id"] as string;
}

async function saveDraft(leadId: string, text: string) {
  return api.request({
    method: "PUT",
    path: `/api/v1/engagement/leads/${leadId}/reply`,
    body: { text },
  });
}

async function send(
  leadId: string,
  text: string,
  key: string | null = randomUUID(),
  confirm: unknown = true,
) {
  return api.request({
    method: "POST",
    path: `/api/v1/engagement/leads/${leadId}/send`,
    body: { text, confirm },
    ...(key === null ? {} : { idempotencyKey: key }),
  });
}

/**
 * Mete respuestas etiquetadas directo en la base (superusuario) para mover el
 * medidor. Fechas como texto: `drizzle()` cambió los serializadores del cliente
 * compartido (trampa 18) y un `Date` crudo rompe `postgres.js`.
 */
async function seedReplies(leadId: string, tones: readonly string[]): Promise<void> {
  const companyId = api.data.a.companyId;
  for (const tone of tones) {
    await api.handle.sql`
      insert into engagement_replies (company_id, lead_id, text, channel, sent_at, tone)
      values (${companyId}, ${leadId}, 'x', 'manual', ${"2026-09-23T12:00:00Z"}::timestamptz, ${tone})`;
  }
}

describe("overview y configuración", () => {
  it("sin nada configurado: defaults, sin app, sin cuenta, medidor safe", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/engagement/overview" });
    expect(res.status).toBe(200);
    const o = dataOf(res);
    expect(o["configured"]).toBe(false);
    expect(o["account"]).toBeNull();
    expect(o["redditApp"]).toMatchObject({
      configured: false,
      scopes: ["identity", "read", "submit"],
      redirectUri: "http://localhost:3000/engagement/reddit/callback",
    });
    expect(o["banMeter"]).toMatchObject({ level: "safe", sendBlocked: false });
  });

  it("settings: rechaza subreddits inválidos con motivo estable; normaliza los válidos", async () => {
    const bad = await api.request({
      method: "PUT",
      path: "/api/v1/engagement/settings",
      body: {
        subreddits: ["freelance", "not valid!"],
        keywords: [],
        replyTone: "casual",
        customRules: "",
        allowLinks: false,
        discoveryEnabled: true,
      },
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad).details).toMatchObject({
      reason: "invalid_subreddits",
      invalid: ["not valid!"],
    });

    const ok = await api.request({
      method: "PUT",
      path: "/api/v1/engagement/settings",
      body: {
        subreddits: ["r/Freelance", "https://www.reddit.com/r/smallbusiness/"],
        keywords: [" Invoice ", "invoice"],
        replyTone: "professional",
        customRules: "Never promise results.",
        allowLinks: false,
        discoveryEnabled: true,
      },
    });
    expect(ok.status).toBe(200);
    expect(dataOf(ok)).toMatchObject({
      subreddits: ["Freelance", "smallbusiness"],
      keywords: ["invoice"],
    });
  });
});

describe("OAuth de Reddit", () => {
  it("authorize sin app → 409; con app, el secret nunca vuelve y la URL pide permanent + scopes mínimos", async () => {
    const before = await api.request({
      method: "GET",
      path: "/api/v1/engagement/reddit/authorize",
    });
    expect(before.status).toBe(409);
    expect(errorOf(before).details).toMatchObject({
      reason: "reddit_app_not_configured",
    });

    await configureApp();
    const overview = await api.request({
      method: "GET",
      path: "/api/v1/engagement/overview",
    });
    expect(overview.raw).not.toContain(SECRET);
    expect(dataOf(overview)["redditApp"]).toMatchObject({
      configured: true,
      developerUsername: "acme_dev",
    });

    const auth = await api.request({
      method: "GET",
      path: "/api/v1/engagement/reddit/authorize",
    });
    const url = new URL(dataOf(auth)["url"] as string);
    expect(url.origin + url.pathname).toBe("https://www.reddit.com/api/v1/authorize");
    expect(url.searchParams.get("duration")).toBe("permanent");
    expect(url.searchParams.get("scope")).toBe("identity read submit");
  });

  it("callback: otra marca → 400 sin gastar; el bueno conecta con tokens cifrados; repetirlo → 400", async () => {
    await configureApp();
    const auth = await api.request({
      method: "GET",
      path: "/api/v1/engagement/reddit/authorize",
    });
    const state = new URL(dataOf(auth)["url"] as string).searchParams.get("state")!;

    const wrong = await api.request({
      method: "POST",
      path: "/api/v1/engagement/reddit/callback",
      body: { state, code: "CODE" },
      token: api.data.b.token,
    });
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).details).toMatchObject({ reason: "oauth_state_wrong_brand" });

    const ok = await api.request({
      method: "POST",
      path: "/api/v1/engagement/reddit/callback",
      body: { state, code: "CODE" },
    });
    expect(ok.status).toBe(200);
    expect(dataOf(ok)).toEqual({ username: "acme_founder" });
    const tokenCall = redditCalls("https://www.reddit.com/api/v1/access_token")[0];
    expect(tokenCall?.headers["User-Agent"]).toBe(
      "web:fastgram-engagement:0.1.0 (by /u/acme_dev)",
    );

    const rows = await api.handle.sql<{ access_token: string; refresh_token: string }[]>`
      select access_token, refresh_token from reddit_accounts where company_id = ${api.data.a.companyId}`;
    expect(rows[0]?.access_token).not.toContain("PLAINTEXT");
    expect(rows[0]?.refresh_token).not.toContain("PLAINTEXT");

    const replay = await api.request({
      method: "POST",
      path: "/api/v1/engagement/reddit/callback",
      body: { state, code: "CODE" },
    });
    expect(replay.status).toBe(400);
    expect(errorOf(replay).details).toMatchObject({ reason: "oauth_state_invalid" });
  });
});

describe("leads", () => {
  it("a mano: URL que no es de Reddit → 400; válida → 201 y juicio encolado; otra marca → 404", async () => {
    const bad = await api.request({
      method: "POST",
      path: "/api/v1/engagement/leads",
      body: { url: "https://evil.example/r/x/comments/abc/", title: "t" },
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad).details).toMatchObject({ reason: "invalid_reddit_url" });

    const id = await manualLead("m1");
    const jobs = api.queue.forQueue(JOB_QUEUES.redditLeadDiscovery);
    expect(jobs.map((j) => j.payload)).toEqual([
      { kind: "score", companyId: api.data.a.companyId, leadId: id },
    ]);

    const list = await api.request({
      method: "GET",
      path: "/api/v1/engagement/leads?view=all",
    });
    const items = dataOf(list)["items"] as Array<Record<string, unknown>>;
    expect(items.map((l) => l["id"])).toContain(id);
    expect(items.find((l) => l["id"] === id)).toMatchObject({
      source: "manual",
      scoreStatus: "pending",
      url: "https://www.reddit.com/r/freelance/comments/m1/how_do_you_invoice/",
    });

    // La negativa primero (trampa 35): otra marca no lo ve.
    const cross = await api.request({
      method: "GET",
      path: `/api/v1/engagement/leads/${id}`,
      token: api.data.b.token,
    });
    expect(cross.status).toBe(404);
    const crossDelete = await api.request({
      method: "DELETE",
      path: `/api/v1/engagement/leads/${id}`,
      token: api.data.b.token,
    });
    expect(crossDelete.status).toBe(404);

    const del = await api.request({
      method: "DELETE",
      path: `/api/v1/engagement/leads/${id}`,
    });
    expect(del.status).toBe(204);
    const gone = await api.request({
      method: "GET",
      path: `/api/v1/engagement/leads/${id}`,
    });
    expect(gone.status).toBe(404);
  });

  it("generar respuesta encola `reply` en reddit-lead-discovery y marca `generating`", async () => {
    const id = await manualLead("g1");
    api.queue.reset();
    const res = await api.request({
      method: "POST",
      path: `/api/v1/engagement/leads/${id}/reply/generate`,
      body: { regenerate: true },
    });
    expect(res.status).toBe(202);
    expect(dataOf(res)["replyStatus"]).toBe("generating");
    expect(
      api.queue.forQueue(JOB_QUEUES.redditLeadDiscovery).map((j) => j.payload),
    ).toEqual([
      { kind: "reply", companyId: api.data.a.companyId, leadId: id, regenerate: true },
    ]);
  });
});

describe("Send (D-11)", () => {
  it("sin confirm o sin Idempotency-Key → 400, y ninguna llamada a Reddit", async () => {
    await connect();
    const id = await manualLead("s0");
    calls.length = 0;
    expect((await send(id, "Helpful answer.", randomUUID(), false)).status).toBe(400);
    expect((await send(id, "Helpful answer.", null)).status).toBe(400);
    expect(redditCalls("https://oauth.reddit.com/api/comment")).toHaveLength(0);
  });

  it("nombrar la marca sin divulgar bloquea (detalle y send), sin llamar a Reddit", async () => {
    await connect();
    const id = await manualLead("s1");
    const draft = await saveDraft(id, "Just use acme, it's great.");
    expect(dataOf(draft)).toMatchObject({
      canSend: false,
      sendBlockedReason: "reply_blocked",
      draftIssues: ["brand_without_disclosure"],
    });
    calls.length = 0;
    const res = await send(id, "Just use acme, it's great.");
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({
      reason: "reply_blocked",
      issues: ["brand_without_disclosure"],
    });
    expect(redditCalls("https://oauth.reddit.com/api/comment")).toHaveLength(0);
  });

  it("feliz: publica en t3_<post>, registra, encola tono y seguimiento; el replay no vuelve a publicar", async () => {
    await connect();
    const id = await manualLead("abc123");
    api.queue.reset();
    calls.length = 0;
    const key = randomUUID();
    const text =
      "Full disclosure, I work on acme. A spreadsheet with due dates works too.";
    const res = await send(id, text, key);
    expect(res.status).toBe(201);
    const posted = redditCalls("https://oauth.reddit.com/api/comment");
    expect(posted).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(posted[0]?.body))).toEqual({
      api_type: "json",
      thing_id: "t3_abc123",
      text,
    });
    expect(posted[0]?.headers["Authorization"]).toBe("bearer REDDIT-ACCESS-PLAINTEXT");
    const out = dataOf(res);
    expect(out["reply"]).toMatchObject({ channel: "api", tone: null });
    expect(out["lead"]).toMatchObject({ replied: true, threadState: "tracking" });
    expect(
      api.queue.forQueue(JOB_QUEUES.banRiskComputation).map((j) => j.payload),
    ).toEqual([{ kind: "compute", companyId: api.data.a.companyId }]);
    expect(api.queue.forQueue(JOB_QUEUES.redditThreadMonitoring)).toHaveLength(1);

    const replay = await send(id, text, key);
    expect(replay.status).toBe(201);
    expect(redditCalls("https://oauth.reddit.com/api/comment")).toHaveLength(1);
  });

  it("errores de Reddit en el comentario: no finge éxito, no registra la respuesta", async () => {
    await connect();
    const id = await manualLead("locked1");
    routes.set("https://oauth.reddit.com/api/comment", () =>
      json({ json: { errors: [["THREAD_LOCKED", "that thread is locked", "parent"]] } }),
    );
    const res = await send(id, "Helpful answer.");
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "lead_locked" });
    const detail = await api.request({
      method: "GET",
      path: `/api/v1/engagement/leads/${id}`,
    });
    expect(dataOf(detail)["replies"]).toEqual([]);
  });

  it("token por vencer: refresca antes de publicar", async () => {
    await connect();
    await api.handle.sql`
      update reddit_accounts set token_expiry = ${"2026-09-24T12:01:00Z"}::timestamptz
      where company_id = ${api.data.a.companyId}`;
    const id = await manualLead("rf1");
    calls.length = 0;
    const res = await send(id, "Helpful answer.");
    expect(res.status).toBe(201);
    const token = redditCalls("https://www.reddit.com/api/v1/access_token");
    expect(token).toHaveLength(1);
    expect(new URLSearchParams(token[0]?.body).get("grant_type")).toBe("refresh_token");
  });

  it("ban meter en danger (calculado en código) bloquea Send y el detalle lo dice", async () => {
    await connect();
    const id = await manualLead("danger1");
    await seedReplies(id, [
      "value_add",
      "direct_promo",
      "direct_promo",
      "direct_promo",
      "direct_promo",
      "direct_promo",
    ]);
    const refresh = await api.request({
      method: "POST",
      path: "/api/v1/engagement/ban-meter/refresh",
    });
    expect(dataOf(refresh)).toMatchObject({
      level: "danger",
      sendBlocked: true,
      sampleSize: 6,
    });
    const detail = await api.request({
      method: "GET",
      path: `/api/v1/engagement/leads/${id}`,
    });
    expect(dataOf(detail)).toMatchObject({
      canSend: false,
      sendBlockedReason: "ban_meter_danger",
    });
    calls.length = 0;
    const res = await send(id, "Helpful answer.");
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "ban_meter_danger" });
    expect(redditCalls("https://oauth.reddit.com/api/comment")).toHaveLength(0);
    await api.handle.sql`delete from engagement_replies where lead_id = ${id}`;
  });
});

describe("sin API de Reddit", () => {
  it("mark-sent registra la respuesta publicada a mano y encola la clasificación", async () => {
    await api.handle
      .sql`delete from reddit_accounts where company_id = ${api.data.a.companyId}`;
    const id = await manualLead("man1");
    api.queue.reset();
    const res = await api.request({
      method: "POST",
      path: `/api/v1/engagement/leads/${id}/mark-sent`,
      body: {
        text: "Helpful answer.",
        commentUrl: "https://www.reddit.com/r/freelance/comments/man1/x/c1/",
      },
    });
    expect(res.status).toBe(201);
    expect(dataOf(res)["reply"]).toMatchObject({
      channel: "manual",
      url: "https://www.reddit.com/r/freelance/comments/man1/x/c1/",
    });
    expect(api.queue.forQueue(JOB_QUEUES.banRiskComputation)).toHaveLength(1);
    const detail = await api.request({
      method: "GET",
      path: `/api/v1/engagement/leads/${id}`,
    });
    expect(dataOf(detail)).toMatchObject({
      canSend: false,
      sendBlockedReason: "reddit_not_connected",
    });
  });

  it("discover sin cuenta → 409 reddit_not_connected; desconectar deja la cuenta en null", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/engagement/discover",
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "reddit_not_connected" });
    await connect();
    const ok = await api.request({ method: "POST", path: "/api/v1/engagement/discover" });
    expect(ok.status).toBe(202);
    const del = await api.request({
      method: "DELETE",
      path: "/api/v1/engagement/reddit/account",
    });
    expect(del.status).toBe(204);
    const o = await api.request({ method: "GET", path: "/api/v1/engagement/overview" });
    expect(dataOf(o)["account"]).toBeNull();
  });
});
