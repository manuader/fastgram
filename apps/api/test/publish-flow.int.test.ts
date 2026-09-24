/**
 * Sprint 7 — publish-flow contra Postgres real.
 *
 * Lo que mide:
 *  - `postNow`: agenda a `ahora + POST_NOW_LEAD_MS`, con el job en esa hora; sin
 *    `postNow` y sin hora → 400;
 *  - **caption siempre presente**: un target sin caption recibe la derivada de la
 *    pieza (X sin links); `""` explícito se respeta; el auto-slot también deriva;
 *  - `POST /posts/:id/retry`: FAILED → SCHEDULED con un job de clave nueva;
 *    no-FAILED → 409; entrega incierta sin confirmar → 409;
 *  - `PATCH /posts/:id`: caption (con tope por red) y hora (recrea el post);
 *  - `POST /content/:id/caption` con un LLM falso (servidor HTTP compatible con
 *    OpenAI apuntado desde un `models.json` temporal): improve, links fuera en X,
 *    sin modelo → 503 `llm_not_configured`, respuesta inservible → `caption_rejected`;
 *  - `enableCaptionGeneration` rellena sólo lo vacío;
 *  - `GET /content/:id/schedule-options`.
 */
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST_NOW_LEAD_MS } from "@fastgram/contracts";
import { JOB_QUEUES } from "@fastgram/core";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;
let llmServer: Server;
let llmReply: () => { status: number; body: unknown } = () => ({ status: 500, body: {} });
let llmCalls = 0;
let home: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "FASTGRAM_HOME",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_CONTEXT_WINDOW_TOKENS",
  "PUBLISH_X_ALLOW_LINKS",
];

const NOW = new Date("2026-09-21T12:00:00.000Z").getTime();
const COPY =
  "3 errores al hacer café.\n\nMirá https://ejemplo.com/oferta\n\nSeguinos #cafe";

let contentId: string;
let xConnectionId: string;
let igConnectionId: string;

const chat = (text: string) => ({
  status: 200,
  body: {
    id: "c1",
    model: "fake-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ text }) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
});

function writeRegistry(port: number): void {
  writeFileSync(
    join(home, "models.json"),
    JSON.stringify({
      version: 1,
      tasks: {
        text: {
          provider: "ollama",
          baseUrl: `http://127.0.0.1:${String(port)}/v1`,
          model: "fake-model",
          contextWindowTokens: 32768,
          updatedAt: "2026-09-21T12:00:00.000Z",
        },
      },
    }),
  );
}

function llmPort(): number {
  const address = llmServer.address();
  if (address === null || typeof address === "string") throw new Error("sin puerto");
  return address.port;
}

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  home = mkdtempSync(join(tmpdir(), "fg-publish-flow-"));
  process.env["FASTGRAM_HOME"] = home;

  llmServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      llmCalls += 1;
      const reply = llmReply();
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => llmServer.listen(0, "127.0.0.1", resolve));

  api = await startApi();
}, 180_000);

afterAll(async () => {
  await api?.close();
  await new Promise<void>((resolve) => llmServer?.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(async () => {
  api.queue.reset();
  llmCalls = 0;
  writeRegistry(llmPort());
  const sql = api.handle.sql;
  const companyId = api.data.a.companyId;
  // El post sembrado por el fixture (`data.a.postId`) se conserva: lo usa el 409.
  await sql`delete from posts where company_id = ${companyId} and id <> ${api.data.a.postId}`;
  await sql`delete from connections where company_id = ${companyId} and platform in ('x', 'instagram')`;
  const [content] = await sql<{ id: string }[]>`
    insert into contents (company_id, type, status, generated_text)
    values (${companyId}, 'slideshow', 'CREATED', ${COPY}) returning id`;
  const [x] = await sql<{ id: string }[]>`
    insert into connections (company_id, platform, platform_user_id, platform_username, scopes, publishable)
    values (${companyId}, 'x', 'x-a', 'marca_x', ${["tweet.write"]}, true) returning id`;
  const [ig] = await sql<{ id: string }[]>`
    insert into connections (company_id, platform, platform_user_id, platform_username, scopes, publishable)
    values (${companyId}, 'instagram', 'ig-a', 'marca_ig', ${["instagram_content_publish"]}, true) returning id`;
  if (content === undefined || x === undefined || ig === undefined)
    throw new Error("seed");
  contentId = content.id;
  xConnectionId = x.id;
  igConnectionId = ig.id;
});

const schedule = (body: Record<string, unknown>) =>
  api.request({ method: "POST", path: `/api/v1/content/${contentId}/schedule`, body });

async function failedPost(errorCode: string | null = "unknown"): Promise<string> {
  const [row] = await api.handle.sql<{ id: string }[]>`
    insert into posts (company_id, content_id, platform, account_type, connection_id,
                       scheduled_at_utc, status, caption, error_code, error_message)
    values (${api.data.a.companyId}, ${contentId}, 'x', 'oauth', ${xConnectionId},
            ${new Date(NOW - 3_600_000).toISOString()}, 'FAILED', 'hola', ${errorCode},
            'We couldn''t reach the platform to publish this post.')
    returning id`;
  if (row === undefined) throw new Error("seed");
  return row.id;
}

describe("POST /content/:id/schedule · postNow y caption", () => {
  it("postNow agenda a ahora + margen, con el job a esa hora", async () => {
    const res = await schedule({
      postNow: true,
      targets: [{ platform: "x", connectionId: xConnectionId, caption: "ya" }],
    });
    expect(res.status).toBe(201);
    const [post] = dataOf(res) as unknown as { scheduledAtUtc: number }[];
    expect(post?.scheduledAtUtc).toBe(NOW + POST_NOW_LEAD_MS);
    expect(api.queue.enqueued[0]?.queue).toBe(JOB_QUEUES.publishing);
    expect(api.queue.enqueued[0]?.options?.startAfter?.getTime()).toBe(
      NOW + POST_NOW_LEAD_MS,
    );
  });

  it("sin postNow y sin hora → 400, y una hora pasada también", async () => {
    const sin = await schedule({
      targets: [{ platform: "x", connectionId: xConnectionId }],
    });
    expect(sin.status).toBe(400);
    const pasada = await schedule({
      scheduledAtUtc: NOW - 1,
      targets: [{ platform: "x", connectionId: xConnectionId }],
    });
    expect(pasada.status).toBe(400);
    expect(api.queue.enqueued).toHaveLength(0);
  });

  it("caption omitida → la derivada de la pieza (X sin links); '' explícito se respeta", async () => {
    const res = await schedule({
      scheduledAtUtc: NOW + 86_400_000,
      targets: [
        { platform: "x", connectionId: xConnectionId },
        { platform: "instagram", connectionId: igConnectionId, caption: "" },
      ],
    });
    expect(res.status).toBe(201);
    const rows = dataOf(res) as unknown as { platform: string; caption: string }[];
    const x = rows.find((r) => r.platform === "x");
    const ig = rows.find((r) => r.platform === "instagram");
    expect(x?.caption).toContain("3 errores al hacer café.");
    expect(x?.caption).toContain("#cafe");
    expect(x?.caption).not.toMatch(/https?:\/\//);
    expect(ig?.caption).toBe("");
  });

  it("el auto-slot crea posts con caption derivada (ya no vacía)", async () => {
    await api.handle
      .sql`delete from brand_strategies where company_id = ${api.data.a.companyId}`;
    const res = await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/autoschedule`,
      body: { networks: ["instagram"] },
    });
    // La estrategia por defecto puede no tener Instagram activo: lo que se mide
    // es que **si** se crea un post, lleve caption.
    if (res.status === 201) {
      const out = dataOf(res) as unknown as { posts: { caption: string }[] };
      for (const post of out.posts) expect(post.caption.length).toBeGreaterThan(0);
    } else {
      expect([409]).toContain(res.status);
    }
  });

  it("enableCaptionGeneration rellena sólo lo vacío, con el modelo", async () => {
    llmReply = () => chat("Caption de la IA #cafe");
    const res = await schedule({
      scheduledAtUtc: NOW + 86_400_000,
      enableCaptionGeneration: true,
      targets: [
        { platform: "x", connectionId: xConnectionId },
        { platform: "instagram", connectionId: igConnectionId, caption: "la mía" },
      ],
    });
    expect(res.status).toBe(201);
    const rows = dataOf(res) as unknown as { platform: string; caption: string }[];
    expect(rows.find((r) => r.platform === "x")?.caption).toBe("Caption de la IA #cafe");
    expect(rows.find((r) => r.platform === "instagram")?.caption).toBe("la mía");
    expect(llmCalls).toBe(1);
  });
});

describe("POST /posts/:id/retry", () => {
  it("un FAILED vuelve a SCHEDULED con un job nuevo de clave propia", async () => {
    const id = await failedPost();
    const res = await api.request({ method: "POST", path: `/api/v1/posts/${id}/retry` });
    expect(res.status).toBe(200);
    const post = dataOf(res) as unknown as {
      status: string;
      scheduledAtUtc: number;
      errorCode?: string;
    };
    expect(post.status).toBe("SCHEDULED");
    expect(post.scheduledAtUtc).toBe(NOW + POST_NOW_LEAD_MS);
    expect(post.errorCode).toBeUndefined();
    const job = api.queue.enqueued[0];
    expect(job?.queue).toBe(JOB_QUEUES.publishing);
    expect(job?.options?.singletonKey).toBe(
      `${JOB_QUEUES.publishing}:${id}:manual:${String(NOW + POST_NOW_LEAD_MS)}`,
    );
    expect(job?.payload).toEqual({ companyId: api.data.a.companyId, postId: id });
  });

  it("con scheduledAtUtc es el Reschedule de un fallido", async () => {
    const id = await failedPost();
    const at = NOW + 7_200_000;
    const res = await api.request({
      method: "POST",
      path: `/api/v1/posts/${id}/retry`,
      body: { scheduledAtUtc: at },
    });
    expect(res.status).toBe(200);
    expect((dataOf(res) as unknown as { scheduledAtUtc: number }).scheduledAtUtc).toBe(
      at,
    );
  });

  it("un post que no está FAILED → 409 y no encola", async () => {
    const res = await api.request({
      method: "POST",
      path: `/api/v1/posts/${api.data.a.postId}/retry`,
    });
    expect(res.status).toBe(409);
    expect(api.queue.enqueued).toHaveLength(0);
  });

  it("entrega incierta: sin confirmar 409, confirmando 200", async () => {
    const id = await failedPost("delivery_unconfirmed");
    const sin = await api.request({ method: "POST", path: `/api/v1/posts/${id}/retry` });
    expect(sin.status).toBe(409);
    const con = await api.request({
      method: "POST",
      path: `/api/v1/posts/${id}/retry`,
      body: { confirmNotPublished: true },
    });
    expect(con.status).toBe(200);
  });

  it("el post de otra marca da 404", async () => {
    const res = await api.request({
      method: "POST",
      path: `/api/v1/posts/${api.data.b.postId}/retry`,
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /posts/:id", () => {
  async function scheduled(): Promise<{ _id: string; scheduledAtUtc: number }> {
    const res = await schedule({
      scheduledAtUtc: NOW + 86_400_000,
      targets: [{ platform: "x", connectionId: xConnectionId, caption: "vieja" }],
    });
    const [post] = dataOf(res) as unknown as { _id: string; scheduledAtUtc: number }[];
    if (post === undefined) throw new Error("no se programó");
    api.queue.reset();
    return post;
  }

  it("edita la caption en el lugar", async () => {
    const post = await scheduled();
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/posts/${post._id}`,
      body: { caption: "nueva" },
    });
    expect(res.status).toBe(200);
    const out = dataOf(res) as unknown as { _id: string; caption: string };
    expect(out._id).toBe(post._id);
    expect(out.caption).toBe("nueva");
  });

  it("caption de más para la red → 400", async () => {
    const post = await scheduled();
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/posts/${post._id}`,
      body: { caption: "a".repeat(281) },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("bad_request");
  });

  it("cambiar la hora recrea el post con su job", async () => {
    const post = await scheduled();
    const to = NOW + 2 * 86_400_000;
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/posts/${post._id}`,
      body: { scheduledAtUtc: to, caption: "movida" },
    });
    expect(res.status).toBe(200);
    const out = dataOf(res) as unknown as {
      _id: string;
      scheduledAtUtc: number;
      caption: string;
    };
    expect(out._id).not.toBe(post._id);
    expect(out.scheduledAtUtc).toBe(to);
    expect(out.caption).toBe("movida");
    expect(api.queue.enqueued).toHaveLength(1);
    const [old] = await api.handle.sql<{ status: string }[]>`
      select status from posts where id = ${post._id}`;
    expect(old?.status).toBe("CANCELLED");
  });

  it("un post FAILED no se edita (409)", async () => {
    const id = await failedPost();
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/posts/${id}`,
      body: { caption: "x" },
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /content/:id/caption (LLM falso)", () => {
  const caption = (body: Record<string, unknown>) =>
    api.request({ method: "POST", path: `/api/v1/content/${contentId}/caption`, body });

  it("improve devuelve el texto del modelo, sin escribir nada", async () => {
    llmReply = () => chat("Mejorada #cafe");
    const res = await caption({
      platform: "instagram",
      mode: "improve",
      text: "mi caption",
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({
      platform: "instagram",
      field: "caption",
      text: "Mejorada #cafe",
      model: "fake-model",
    });
    expect(llmCalls).toBe(1);
  });

  it("X pierde los links y se recorta al tope", async () => {
    llmReply = () => chat(`Mirá https://ejemplo.com ${"a".repeat(400)}`);
    const res = await caption({ platform: "x", mode: "regenerate" });
    expect(res.status).toBe(200);
    const text = (dataOf(res) as unknown as { text: string }).text;
    expect(text).not.toContain("https://");
    expect([...text].length).toBeLessThanOrEqual(280);
  });

  it("sin modelo configurado → 503 llm_not_configured", async () => {
    unlinkSync(join(home, "models.json"));
    expect(existsSync(join(home, "models.json"))).toBe(false);
    const res = await caption({ platform: "instagram", mode: "regenerate" });
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe("service_unavailable");
    expect(res.raw).toContain("llm_not_configured");
  });

  it("el modelo falla → 503 llm_failed, sin el error crudo", async () => {
    llmReply = () => ({
      status: 500,
      body: { error: { message: "SECRETO-DEL-PROVEEDOR" } },
    });
    const res = await caption({ platform: "instagram", mode: "regenerate" });
    expect(res.status).toBe(503);
    expect(res.raw).toContain("llm_failed");
    expect(res.raw).not.toContain("SECRETO-DEL-PROVEEDOR");
  });

  it("respuesta inservible → 503 caption_rejected", async () => {
    llmReply = () => chat("   ");
    const res = await caption({ platform: "instagram", mode: "regenerate" });
    expect(res.status).toBe(503);
    expect(res.raw).toContain("caption_rejected");
  });

  it("Reddit, descripción en Instagram e improve sin texto → 400", async () => {
    expect((await caption({ platform: "reddit", mode: "regenerate" })).status).toBe(400);
    expect(
      (await caption({ platform: "instagram", field: "description", mode: "regenerate" }))
        .status,
    ).toBe(400);
    expect((await caption({ platform: "instagram", mode: "improve" })).status).toBe(400);
    expect(llmCalls).toBe(0);
  });

  it("contenido de otra marca → 404", async () => {
    const res = await api.request({
      method: "POST",
      path: `/api/v1/content/${api.data.b.contentId}/caption`,
      body: { platform: "instagram", mode: "regenerate" },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /content/:id/schedule-options", () => {
  it("captions por red, conexiones y zona horaria", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/content/${contentId}/schedule-options`,
    });
    expect(res.status).toBe(200);
    const out = dataOf(res) as unknown as {
      timezone: string;
      xAllowLinks: boolean;
      networks: {
        network: string;
        caption: string | null;
        connections: { connectionId: string }[];
      }[];
    };
    expect(out.timezone).toBe("UTC");
    expect(out.xAllowLinks).toBe(false);
    const x = out.networks.find((n) => n.network === "x");
    expect(x?.connections.map((c) => c.connectionId)).toEqual([xConnectionId]);
    expect(x?.caption).not.toMatch(/https?:/);
    const tiktok = out.networks.find((n) => n.network === "tiktok");
    expect(tiktok?.caption).toBe("3 errores al hacer café.");
  });

  it("de otra marca → 404", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.b.contentId}/schedule-options`,
    });
    expect(res.status).toBe(404);
  });
});
