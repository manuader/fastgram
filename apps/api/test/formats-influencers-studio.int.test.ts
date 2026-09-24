/**
 * Sprint 7 (agente G) en la API: formatos generativos (`P4-FORMAT-001/002`) e
 * influencers (Configuration, templates, imagen base por texto, video,
 * regenerar).
 *
 * Mismo andamiaje que `ai-studio.int.test.ts`: registro, gasto y corridas son
 * archivos reales en un `FASTGRAM_HOME` temporal, y Higgsfield es un servidor
 * HTTP local que contesta el estimador (`POST /estimate/{endpoint}`). Ninguna
 * llamada real.
 *
 * Lo que NO cubre: el camino feliz de `POST /influencers/:id/videos`. Subir la
 * imagen a Higgsfield exige una `upload_url` https y el montaje por defecto no
 * deja inyectar el `fetch` de la subida; ese tramo se prueba en unidad
 * (`createProviderImageResolver`) y el handler del worker con dobles.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JOB_QUEUES } from "@fastgram/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;
let home: string;
let server: Server;
let baseUrl: string;
let previousHome: string | undefined;
const estimates: { path: string; body: Record<string, unknown> }[] = [];
let usd = "0.350";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      if (req.method === "POST" && req.url?.startsWith("/estimate/")) {
        estimates.push({
          path: req.url,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ credits: "5.000", usd }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  home = await mkdtemp(join(tmpdir(), "fastgram-api-formats-"));
  previousHome = process.env["FASTGRAM_HOME"];
  process.env["FASTGRAM_HOME"] = home;
  api = await startApi({ now: "2026-09-24T12:00:00.000Z", mode: "personal" });
}, 180_000);

afterAll(async () => {
  await api?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (previousHome === undefined) delete process.env["FASTGRAM_HOME"];
  else process.env["FASTGRAM_HOME"] = previousHome;
  if (home !== undefined) await rm(home, { recursive: true, force: true });
});

const KEY = "key-id-abc:key-secret-xyz";

beforeEach(async () => {
  api.queue.reset();
  estimates.length = 0;
  usd = "0.350";
  await writeFile(
    join(home, "models.json"),
    JSON.stringify({
      version: 1,
      tasks: {
        image: {
          provider: "higgsfield",
          baseUrl,
          model: "higgsfield-ai/soul/v2/standard",
          apiKey: KEY,
        },
        // El de Settings es image-to-video: los formatos tienen que caer en
        // un texto a video del mismo proveedor.
        video: {
          provider: "higgsfield",
          baseUrl,
          model: "kling-video/v2.6/pro/image-to-video",
          apiKey: KEY,
        },
      },
    }),
  );
  await rm(join(home, "spend.json"), { force: true });
  await rm(join(home, "ai-studio"), { recursive: true, force: true });
  await rm(join(home, "format-runs"), { recursive: true, force: true });
  await rm(join(home, "influencer-templates"), { recursive: true, force: true });
});

async function seedImage(companyId: string): Promise<string> {
  const key = `media/${companyId}/base-${randomUUID()}.png`;
  const rows = await api.handle.sql`
    insert into media (company_id, media_type, filename, r2_url, storage_key,
                       status, size_mb, categories, origin)
    values (${companyId}::uuid, 'image', 'base.png',
            ${`http://localhost:9000/fastgram/${key}`}, ${key}, 'ready', 0.001,
            '{}'::text[], 'manual_upload')
    returning media_id`;
  return (rows[0] as unknown as { media_id: string }).media_id;
}

describe("GET /ai-studio/formats", () => {
  it("los 17, siete disponibles, y sólo modelos de texto a video", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/ai-studio/formats" });
    expect(res.status).toBe(200);
    const body = dataOf(res) as {
      formats: { id: string; status: string; why: string | null }[];
      video: {
        configured: boolean;
        defaultModel: string;
        models: { imageInput: string }[];
      };
    };
    expect(body.formats).toHaveLength(17);
    expect(body.formats.filter((f) => f.status === "available")).toHaveLength(7);
    expect(body.formats.find((f) => f.id === "news-anchor")?.why).toMatch(/voice/);
    expect(body.video.configured).toBe(true);
    expect(body.video.models.every((m) => m.imageInput !== "required")).toBe(true);
    expect(body.video.defaultModel).not.toContain("image-to-video");
    expect(res.raw).not.toContain("key-secret");
  });
});

describe("formatos: estimar y arrancar", () => {
  const body = { overlayText: "Stop scrolling", topic: "a sunny park" };

  it("estima con el texto a video, 9:16, y la escena del formato", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/formats/on-a-walk/estimate",
      body,
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({
      provider: "higgsfield",
      durationSeconds: 5,
      estimate: { usd: 0.35, source: "provider" },
      fits: true,
    });
    expect(estimates[0]?.path).toContain("text-to-video");
    expect(estimates[0]?.body).toMatchObject({ aspect_ratio: "9:16", duration: 5 });
    expect(String(estimates[0]?.body["prompt"])).toContain("walking");
    expect(String(estimates[0]?.body["prompt"])).toContain("a sunny park");
  });

  it("202: corrida + generación con el mismo id, gasto reservado y job encolado", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/formats/cutting-fruit/runs",
      body,
    });
    expect(res.status).toBe(202);
    const run = dataOf(res) as { id: string; status: string; formatId: string };
    expect(run).toMatchObject({
      formatId: "cutting-fruit",
      status: "queued",
      contentId: null,
    });
    const jobs = api.queue.forQueue(JOB_QUEUES.aiStudioGeneration);
    expect(jobs.map((j) => j.payload)).toEqual([
      { companyId: api.data.a.companyId, generationId: run.id },
    ]);
    const onDisk = JSON.parse(
      await readFile(
        join(home, "format-runs", api.data.a.companyId, `${run.id}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(onDisk).toMatchObject({ overlayText: "Stop scrolling", source: "studio" });
    const spend = JSON.parse(await readFile(join(home, "spend.json"), "utf8")) as {
      months: Record<string, Record<string, { state: string }>>;
    };
    expect(spend.months["2026-09"]?.[run.id]?.state).toBe("reserved");

    const one = await api.request({
      method: "GET",
      path: `/api/v1/ai-studio/format-runs/${run.id}`,
    });
    expect(dataOf(one)).toMatchObject({ id: run.id, status: "queued" });
    // Otra marca: no existe.
    const theirs = await api.request({
      method: "GET",
      path: `/api/v1/ai-studio/format-runs/${run.id}`,
      token: api.data.b.token,
    });
    expect(theirs.status).toBe(404);
    const list = await api.request({
      method: "GET",
      path: "/api/v1/ai-studio/format-runs",
    });
    expect((dataOf(list) as unknown as unknown[]).length).toBe(1);
  });

  it("desde Blitz (`?source=blitz`) queda registrada la procedencia; otra fuente, 400", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/formats/cutting-fruit/runs?source=blitz",
      body,
    });
    expect(res.status).toBe(202);
    const run = dataOf(res) as { id: string };
    const onDisk = JSON.parse(
      await readFile(
        join(home, "format-runs", api.data.a.companyId, `${run.id}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(onDisk).toMatchObject({ source: "blitz" });
    const bad = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/formats/cutting-fruit/runs?source=nope",
      body,
    });
    expect(bad.status).toBe(400);
  });

  it("bloqueado 409, inexistente 404, sin texto 400, tope 402", async () => {
    const blocked = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/formats/talking-head-ugc/runs",
      body,
    });
    expect(blocked.status).toBe(409);
    expect(errorOf(blocked).details).toMatchObject({ reason: "format_unavailable" });
    const unknown = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/formats/nope/estimate",
      body,
    });
    expect(unknown.status).toBe(404);
    const empty = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/formats/lego/estimate",
      body: { overlayText: "" },
    });
    expect(empty.status).toBe(400);
    usd = "999.000";
    const tooMuch = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/formats/lego/runs",
      body,
    });
    expect(tooMuch.status).toBe(402);
    expect(errorOf(tooMuch).details).toMatchObject({ reason: "budget_exceeded" });
    expect(api.queue.forQueue(JOB_QUEUES.aiStudioGeneration)).toHaveLength(0);
  });

  it("sin modelo de video: 409 not_configured", async () => {
    await writeFile(join(home, "models.json"), JSON.stringify({ version: 1, tasks: {} }));
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/formats/felt/estimate",
      body,
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "not_configured" });
  });
});

describe("influencers: templates", () => {
  it("de fábrica → propios → de fábrica otra vez", async () => {
    const first = await api.request({
      method: "GET",
      path: "/api/v1/influencers/templates",
    });
    expect(dataOf(first)).toMatchObject({ customized: false });
    expect((dataOf(first) as { templates: unknown[] }).templates.length).toBeGreaterThan(
      0,
    );
    const put = await api.request({
      method: "PUT",
      path: "/api/v1/influencers/templates",
      body: { templates: [{ id: "mine", label: "Mine", prompt: "{subject} skiing" }] },
    });
    expect(put.status).toBe(200);
    expect(dataOf(put)).toEqual({
      customized: true,
      templates: [{ id: "mine", label: "Mine", prompt: "{subject} skiing" }],
    });
    // Otra marca sigue con los de fábrica.
    const b = await api.request({
      method: "GET",
      path: "/api/v1/influencers/templates",
      token: api.data.b.token,
    });
    expect(dataOf(b)).toMatchObject({ customized: false });
    const reset = await api.request({
      method: "PUT",
      path: "/api/v1/influencers/templates",
      body: { templates: null },
    });
    expect(dataOf(reset)).toMatchObject({ customized: false });
  });
});

describe("influencers: imagen base por texto", () => {
  it("estima y encola una generación de imagen con el prompt de la descripción", async () => {
    const description = { gender: "female", age: 27, details: "curly red hair" };
    const est = await api.request({
      method: "POST",
      path: "/api/v1/influencers/base-image/estimate",
      body: description,
    });
    expect(est.status).toBe(200);
    expect(String(estimates[0]?.body["prompt"])).toContain("27-year-old female");
    const res = await api.request({
      method: "POST",
      path: "/api/v1/influencers/base-image",
      body: { ...description, instructions: "in a coffee shop" },
    });
    expect(res.status).toBe(202);
    const g = dataOf(res) as { id: string; kind: string; status: string; prompt: string };
    expect(g).toMatchObject({ kind: "image", status: "queued" });
    expect(g.prompt).toContain("in a coffee shop");
    expect(api.queue.forQueue(JOB_QUEUES.aiStudioGeneration)).toHaveLength(1);
    // La web la sigue por AI Studio.
    const follow = await api.request({
      method: "GET",
      path: `/api/v1/ai-studio/generations/${g.id}`,
    });
    expect(follow.status).toBe(200);
  });

  it("400 sin nada que describir", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/influencers/base-image",
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe("influencers: crear desde la base generada y regenerar", () => {
  it("201 con una sola foto; regenerar guarda de quién salió", async () => {
    const base = await seedImage(api.data.a.companyId);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/influencers",
      idempotencyKey: randomUUID(),
      body: {
        name: "Ella v2",
        generatedBaseMediaId: base,
        regeneratedFromId: api.data.a.influencerId,
      },
    });
    expect(res.status).toBe(201);
    expect(dataOf(res)).toMatchObject({
      referenceMediaIds: [base],
      regeneratedFromId: api.data.a.influencerId,
    });
    // El viejo sigue ahí.
    const old = await api.request({
      method: "GET",
      path: `/api/v1/influencers/${api.data.a.influencerId}`,
    });
    expect(old.status).toBe(200);
  });

  it("400 si el regenerado es de otra marca o si mezcla caminos", async () => {
    const base = await seedImage(api.data.a.companyId);
    const foreign = await api.request({
      method: "POST",
      path: "/api/v1/influencers",
      idempotencyKey: randomUUID(),
      body: {
        name: "X",
        generatedBaseMediaId: base,
        regeneratedFromId: api.data.b.influencerId,
      },
    });
    expect(foreign.status).toBe(400);
    expect(errorOf(foreign).details).toMatchObject({ field: "regeneratedFromId" });
    const both = await api.request({
      method: "POST",
      path: "/api/v1/influencers",
      idempotencyKey: randomUUID(),
      body: {
        name: "X",
        generatedBaseMediaId: base,
        referenceMediaIds: [base, base, base, base],
      },
    });
    expect(both.status).toBe(400);
  });
});

describe("influencers: Configuration (FR-083)", () => {
  it("lee opciones de la marca, guarda y rechaza ids ajenos", async () => {
    const path = `/api/v1/influencers/${api.data.a.influencerId}/config`;
    const first = await api.request({ method: "GET", path });
    expect(first.status).toBe(200);
    const view = dataOf(first) as {
      config: { angleIds: string[] };
      options: {
        angles: { id: string }[];
        accounts: { connectionId: string; platform: string }[];
      };
    };
    expect(view.config.angleIds).toEqual([]);
    expect(view.options.angles.map((a) => a.id)).toContain(api.data.a.angleId);
    expect(view.options.angles.map((a) => a.id)).not.toContain(api.data.b.angleId);

    const account = view.options.accounts[0];
    const saved = await api.request({
      method: "PUT",
      path,
      body: {
        angleIds: [api.data.a.angleId],
        ...(account === undefined
          ? {}
          : {
              publishingAccounts: [
                {
                  platform: account.platform,
                  connectionId: account.connectionId,
                  enabled: true,
                },
              ],
            }),
      },
    });
    expect(saved.status).toBe(200);
    expect(dataOf(saved)).toMatchObject({ config: { angleIds: [api.data.a.angleId] } });
    const again = await api.request({ method: "GET", path });
    expect(dataOf(again)).toMatchObject({ config: { angleIds: [api.data.a.angleId] } });

    const foreign = await api.request({
      method: "PUT",
      path,
      body: { angleIds: [api.data.b.angleId] },
    });
    expect(foreign.status).toBe(400);
    expect(errorOf(foreign).details).toMatchObject({ field: "angleIds" });

    const crossTenant = await api.request({
      method: "GET",
      path: `/api/v1/influencers/${api.data.b.influencerId}/config`,
    });
    expect(crossTenant.status).toBe(404);
  });
});

describe("influencers: video (validación)", () => {
  it("imagen inexistente 400, influencer ajeno 404, modelo sin imagen 400", async () => {
    const image = await seedImage(api.data.a.companyId);
    const req = {
      sourceMediaId: randomUUID(),
      model: "kling-video/v2.6/pro/image-to-video",
      durationSeconds: 5,
    };
    const missing = await api.request({
      method: "POST",
      path: `/api/v1/influencers/${api.data.a.influencerId}/videos/estimate`,
      body: req,
    });
    expect(missing.status).toBe(400);
    expect(errorOf(missing).details).toMatchObject({ field: "sourceMediaId" });
    const foreign = await api.request({
      method: "POST",
      path: `/api/v1/influencers/${api.data.b.influencerId}/videos`,
      body: { ...req, sourceMediaId: image },
    });
    expect(foreign.status).toBe(404);
    const t2v = await api.request({
      method: "POST",
      path: `/api/v1/influencers/${api.data.a.influencerId}/videos/estimate`,
      body: { ...req, sourceMediaId: image, model: "kling-video/v2.6/pro/text-to-video" },
    });
    expect(t2v.status).toBe(400);
    expect(errorOf(t2v).details).toMatchObject({ field: "model" });
  });

  it("setup ofrece los image-to-video de Higgsfield", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/influencers/setup" });
    const setup = dataOf(res) as {
      videoModels: { id: string }[];
      canGenerateBase: boolean;
    };
    expect(setup.canGenerateBase).toBe(true);
    expect(setup.videoModels.map((m) => m.id)).toEqual([
      "kling-video/v2.6/pro/image-to-video",
      "bytedance/seedance-2.0/image-to-video",
    ]);
  });
});
