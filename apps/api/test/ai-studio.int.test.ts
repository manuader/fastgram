/**
 * AI Studio de punta a punta en la API — `PU-LATER-005`, `PU-MODEL-005`.
 *
 * El registro de modelos, el gasto y las generaciones son los archivos reales
 * en un `FASTGRAM_HOME` temporal. Higgsfield es un **servidor HTTP local** que
 * contesta el estimador tal como lo documenta
 * `docs.higgsfield.ai/docs/concepts/billing-and-retention`
 * (`POST /estimate/{endpoint}` → `{"credits":"…","usd":"…"}`): la base URL del
 * registro apunta a él. Ninguna llamada real a Higgsfield ni a fal.
 *
 * Lo que se mide: qué encola la ruta, que reserva gasto y corta en el tope
 * (402), que valida contra la ficha del modelo (400 con campo), y que una
 * generación de otra marca **no existe** (404, nunca 403).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JOB_QUEUES, newGenerationRecord } from "@fastgram/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;
let home: string;
let server: Server;
let baseUrl: string;
const estimates: { path: string; auth: string | undefined; body: unknown }[] = [];
let previousHome: string | undefined;

/** Lo que devuelve el estimador falso. Se cambia por test. */
let usd = "0.120";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      if (req.method === "POST" && req.url?.startsWith("/estimate/")) {
        estimates.push({
          path: req.url,
          auth: req.headers.authorization,
          body: JSON.parse(raw) as unknown,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ credits: "2.000", usd }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  home = await mkdtemp(join(tmpdir(), "fastgram-api-ai-studio-"));
  previousHome = process.env["FASTGRAM_HOME"];
  // Las rutas arman sus dependencias de `process.env` al registrarse.
  process.env["FASTGRAM_HOME"] = home;
  api = await startApi({ now: "2026-09-24T12:00:00.000Z" });
}, 180_000);

afterAll(async () => {
  await api?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (previousHome === undefined) delete process.env["FASTGRAM_HOME"];
  else process.env["FASTGRAM_HOME"] = previousHome;
  if (home !== undefined) await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  api.queue.reset();
  estimates.length = 0;
  usd = "0.120";
  // Imagen con Higgsfield (contra el servidor local); video sin configurar.
  await writeFile(
    join(home, "models.json"),
    JSON.stringify({
      version: 1,
      tasks: {
        image: {
          provider: "higgsfield",
          baseUrl,
          model: "higgsfield-ai/soul/v2/standard",
          apiKey: "key-id-abc:key-secret-xyz",
        },
      },
    }),
  );
  await rm(join(home, "spend.json"), { force: true });
  await rm(join(home, "ai-studio"), { recursive: true, force: true });
});

const request = {
  kind: "image",
  prompt: "a neon skyline at dusk",
  aspectRatio: "9:16",
  count: 4,
};

describe("GET /ai-studio/options", () => {
  it("imagen configurada con su catálogo; video no; presupuesto default", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/ai-studio/options" });
    expect(res.status).toBe(200);
    const body = dataOf(res) as {
      image: {
        configured: boolean;
        provider: string;
        defaultModel: string;
        models: { id: string }[];
      };
      video: { configured: boolean; models: unknown[] };
      budget: { budgetUsd: number; chargedUsd: number };
    };
    expect(body.image).toMatchObject({
      configured: true,
      provider: "higgsfield",
      defaultModel: "higgsfield-ai/soul/v2/standard",
    });
    expect(body.image.models.map((m) => m.id)).toContain("z-image/turbo");
    expect(body.video).toMatchObject({ configured: false, models: [] });
    expect(body.budget).toMatchObject({ budgetUsd: 30, chargedUsd: 0 });
    // Nunca la credencial.
    expect(res.raw).not.toContain("key-secret");
  });
});

describe("POST /ai-studio/estimate", () => {
  it("pregunta al estimador con el cuerpo del modelo y la credencial, y dice si entra", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/estimate",
      body: request,
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({
      provider: "higgsfield",
      model: "higgsfield-ai/soul/v2/standard",
      estimate: { usd: 0.12, source: "provider" },
      fits: true,
    });
    expect(estimates).toEqual([
      {
        path: "/estimate/higgsfield-ai/soul/v2/standard",
        auth: "Key key-id-abc:key-secret-xyz",
        body: { prompt: "a neon skyline at dusk", aspect_ratio: "9:16", batch_size: 4 },
      },
    ]);
    expect(api.queue.forQueue(JOB_QUEUES.aiStudioGeneration)).toHaveLength(0);
  });

  it.each([
    [
      "relación no soportada por SOUL V2",
      { ...request, aspectRatio: "4:5" },
      "aspectRatio",
    ],
    ["cantidad no soportada", { ...request, count: 2 }, "count"],
    ["modelo fuera del catálogo", { ...request, model: "made/up" }, "model"],
    ["sin prompt", { ...request, prompt: " " }, "prompt"],
  ])("400: %s (campo %s) y no llama al proveedor", async (_, body, field) => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/estimate",
      body,
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({ field });
    expect(estimates).toHaveLength(0);
  });

  it("video sin configurar: 409 not_configured", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/estimate",
      body: {
        kind: "video",
        prompt: "x",
        aspectRatio: "9:16",
        count: 1,
        durationSeconds: 5,
      },
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "not_configured" });
  });
});

describe("POST /ai-studio/generations", () => {
  it("202 queued, reserva el gasto y encola un job con el companyId del token", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/generations",
      body: request,
    });
    expect(res.status).toBe(202);
    const gen = dataOf(res) as { id: string; status: string; estimate: { usd: number } };
    expect(gen).toMatchObject({ status: "queued", estimate: { usd: 0.12 } });

    const jobs = api.queue.forQueue(JOB_QUEUES.aiStudioGeneration);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      companyId: api.data.a.companyId,
      generationId: gen.id,
    });
    expect(jobs[0]?.options?.singletonKey).toBe(
      `ai-studio:${api.data.a.companyId}:${gen.id}`,
    );

    const spend = JSON.parse(await readFile(join(home, "spend.json"), "utf8")) as {
      months: Record<string, Record<string, { usd: number; state: string }>>;
    };
    expect(spend.months["2026-09"]?.[gen.id]).toMatchObject({
      usd: 0.12,
      state: "reserved",
    });

    const budget = dataOf(
      await api.request({ method: "GET", path: "/api/v1/models/budget" }),
    );
    expect(budget).toMatchObject({ reservedUsd: 0.12, remainingUsd: 29.88 });
  });

  it("402 payment_required con reason budget_exceeded al pasarse del tope, y no encola", async () => {
    await api.request({
      method: "PUT",
      path: "/api/v1/models/budget",
      body: { budgetUsd: 0.2 },
    });
    const first = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/generations",
      body: request,
    });
    expect(first.status).toBe(202);
    const second = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/generations",
      body: request,
    });
    expect(second.status).toBe(402);
    expect(errorOf(second)).toMatchObject({
      code: "payment_required",
      details: { reason: "budget_exceeded", estimateUsd: 0.12, budgetUsd: 0.2 },
    });
    expect(api.queue.forQueue(JOB_QUEUES.aiStudioGeneration)).toHaveLength(1);
  });

  it("en el borde exacto del tope sí entra", async () => {
    await api.request({
      method: "PUT",
      path: "/api/v1/models/budget",
      body: { budgetUsd: 0.24 },
    });
    for (let i = 0; i < 2; i++) {
      const res = await api.request({
        method: "POST",
        path: "/api/v1/ai-studio/generations",
        body: request,
      });
      expect(res.status).toBe(202);
    }
    const third = await api.request({
      method: "POST",
      path: "/api/v1/ai-studio/generations",
      body: request,
    });
    expect(third.status).toBe(402);
  });
});

describe("GET /ai-studio/generations — por marca", () => {
  it("la galería de una marca no ve la de otra; el detalle cruzado es 404", async () => {
    const created = dataOf(
      await api.request({
        method: "POST",
        path: "/api/v1/ai-studio/generations",
        body: request,
      }),
    ) as { id: string };

    const listA = await api.request({
      method: "GET",
      path: "/api/v1/ai-studio/generations",
    });
    expect((dataOf(listA) as unknown as { id: string }[]).map((g) => g.id)).toEqual([
      created.id,
    ]);

    const listB = await api.request({
      method: "GET",
      path: "/api/v1/ai-studio/generations",
      token: api.data.b.token,
    });
    expect(dataOf(listB)).toEqual([]);

    const cross = await api.request({
      method: "GET",
      path: `/api/v1/ai-studio/generations/${created.id}`,
      token: api.data.b.token,
    });
    expect(cross.status).toBe(404);
    expect(errorOf(cross).code).toBe("not_found");

    const own = await api.request({
      method: "GET",
      path: `/api/v1/ai-studio/generations/${created.id}`,
    });
    expect(own.status).toBe(200);
    expect(dataOf(own)).toMatchObject({ id: created.id, status: "queued", media: [] });

    const garbage = await api.request({
      method: "GET",
      path: "/api/v1/ai-studio/generations/not-a-uuid",
    });
    expect(garbage.status).toBe(404);
  });

  it("una generación lista trae su media del Media Bank (y sólo la de esta marca)", async () => {
    const a = api.data.a.companyId;
    const b = api.data.b.companyId;
    const insert = async (companyId: string, name: string): Promise<string> => {
      const rows = await api.handle.sql<{ media_id: string }[]>`
        insert into media (company_id, media_type, filename, r2_url, storage_key, status,
                           size_mb, categories, origin)
        values (${companyId}::uuid, 'image', ${name},
                ${`https://bucket.test/media/${companyId}/${name}`},
                ${`media/${companyId}/${name}`}, 'ready', 0.1,
                '{slideshow-image}'::text[], 'brand_kit'::media_origin)
        returning media_id::text
      `;
      return rows[0]?.media_id ?? "";
    };
    const own = await insert(a, `gen-${randomUUID()}.png`);
    const foreign = await insert(b, `gen-${randomUUID()}.png`);
    const record = {
      ...newGenerationRecord({
        id: randomUUID(),
        companyId: a,
        kind: "image",
        provider: "higgsfield",
        model: "higgsfield-ai/soul/v2/standard",
        prompt: "x",
        aspectRatio: "1:1",
        count: 1,
        durationSeconds: null,
        imageUrl: null,
        estimate: { usd: 0.1, source: "provider", basis: "b", sourceUrl: null },
        spendMonth: "2026-09",
        now: "2026-09-24T12:00:00.000Z",
      }),
      status: "ready" as const,
      mediaIds: [own, foreign],
    };
    const dir = join(home, "ai-studio", a);
    await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
    await writeFile(join(dir, `${record.id}.json`), JSON.stringify(record));

    const res = await api.request({
      method: "GET",
      path: `/api/v1/ai-studio/generations/${record.id}`,
    });
    const media = (dataOf(res) as { media: { mediaId: string; url: string }[] }).media;
    // La de otra marca no aparece aunque el id esté en el archivo.
    expect(media.map((m) => m.mediaId)).toEqual([own]);
    expect(media[0]?.url).toContain(`/media/${a}/`);
  });
});

describe("POST /ai-studio/generations sin cola", () => {
  let sinCola: ApiHarness;
  beforeAll(async () => {
    sinCola = await startApi({ now: "2026-09-24T12:00:00.000Z", withQueue: false });
  }, 180_000);
  afterAll(async () => {
    await sinCola?.close();
  });

  it("503 antes de estimar ni reservar", async () => {
    const res = await sinCola.request({
      method: "POST",
      path: "/api/v1/ai-studio/generations",
      body: request,
    });
    expect(res.status).toBe(503);
    expect(estimates).toHaveLength(0);
  });
});
