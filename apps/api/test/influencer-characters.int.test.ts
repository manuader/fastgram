/**
 * Influencers con personaje de Higgsfield en la API — `PU-LATER-004`,
 * `FR-080`, `FR-081`.
 *
 * El registro de modelos y el gasto son los archivos reales en un
 * `FASTGRAM_HOME` temporal. Higgsfield es un **servidor HTTP local** que
 * contesta el estimador como lo documenta
 * `docs.higgsfield.ai/docs/concepts/billing-and-retention`; el adaptador real
 * (`HiggsfieldClient`) habla con él. Ninguna llamada real.
 *
 * Lo que se mide: el setup, crear con fotos del Media Bank (sólo de la marca,
 * sólo con Higgsfield, sólo con saldo), el estimador con `custom_reference_id`,
 * la reserva del tope y el job `image`, y el 404 cruzado.
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
const estimates: { path: string; auth: string | undefined; body: unknown }[] = [];
const SOUL = "3eb3ad49-775d-40bd-b5e5-38b105108780";

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
        res.end(JSON.stringify({ credits: "0.480", usd: "0.030" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  home = await mkdtemp(join(tmpdir(), "fastgram-api-influencers-"));
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

async function configureHiggsfield(): Promise<void> {
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
}

beforeEach(async () => {
  api.queue.reset();
  estimates.length = 0;
  await configureHiggsfield();
  await rm(join(home, "spend.json"), { force: true });
});

/** N imágenes `ready` en el Media Bank de una marca. */
async function seedPhotos(companyId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const key = `media/${companyId}/ref-${randomUUID()}.png`;
    const rows = await api.handle.sql`
      insert into media (company_id, media_type, filename, r2_url, storage_key,
                         status, size_mb, categories, origin)
      values (${companyId}::uuid, 'image', 'ref.png',
              ${`http://localhost:9000/fastgram/${key}`}, ${key}, 'ready', 0.001,
              '{}'::text[], 'manual_upload')
      returning media_id`;
    ids.push((rows[0] as unknown as { media_id: string }).media_id);
  }
  return ids;
}

async function seedReady(companyId: string, status = "ready"): Promise<string> {
  const rows = await api.handle.sql`
    insert into influencers (company_id, name, status, progress, provider, soul_id)
    values (${companyId}::uuid, 'Emily', ${status}::influencer_status, 100,
            'higgsfield', ${SOUL})
    returning id`;
  return (rows[0] as unknown as { id: string }).id;
}

describe("GET /influencers/setup", () => {
  it("con Higgsfield: configurado, se puede crear, costo de entrenamiento desconocido", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/influencers/setup" });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({
      configured: true,
      provider: "higgsfield",
      references: { min: 4, max: 20 },
      trainingCost: null,
      canCreate: true,
      budget: { budgetUsd: 30 },
    });
    expect(res.raw).not.toContain("key-secret");
  });

  it("sin Higgsfield: no configurado", async () => {
    await writeFile(join(home, "models.json"), JSON.stringify({ version: 1, tasks: {} }));
    const res = await api.request({ method: "GET", path: "/api/v1/influencers/setup" });
    expect(dataOf(res)).toMatchObject({ configured: false, canCreate: false });
  });
});

describe("POST /influencers con fotos de referencia", () => {
  it("201: crea la fila con las fotos y encola el pipeline", async () => {
    const photos = await seedPhotos(api.data.a.companyId, 4);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/influencers",
      idempotencyKey: randomUUID(),
      body: { name: "Emily", referenceMediaIds: photos },
    });
    expect(res.status).toBe(201);
    const inf = dataOf(res) as Record<string, unknown>;
    expect(inf).toMatchObject({
      name: "Emily",
      status: "generating_variations",
      progress: 0,
      referenceMediaIds: photos,
    });
    expect(inf["gender"]).toBeUndefined();
    expect(inf["baseImageUrl"]).toContain("/ref-");

    const jobs = api.queue.forQueue(JOB_QUEUES.influencerPipeline);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      companyId: api.data.a.companyId,
      influencerId: inf["_id"],
    });
    const row = (
      await api.handle.sql`
        select provider, cardinality(reference_media_ids) as n
          from influencers where id = ${inf["_id"] as string}::uuid`
    )[0] as unknown as { provider: string; n: number };
    expect(row).toEqual({ provider: "higgsfield", n: 4 });
  });

  it("400 con fotos de otra marca, y no encola", async () => {
    const mine = await seedPhotos(api.data.a.companyId, 3);
    const theirs = await seedPhotos(api.data.b.companyId, 1);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/influencers",
      idempotencyKey: randomUUID(),
      body: { name: "Emily", referenceMediaIds: [...mine, ...theirs] },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({
      field: "referenceMediaIds",
      missing: theirs,
    });
    expect(api.queue.forQueue(JOB_QUEUES.influencerPipeline)).toHaveLength(0);
  });

  it("409 not_configured sin Higgsfield", async () => {
    await writeFile(join(home, "models.json"), JSON.stringify({ version: 1, tasks: {} }));
    const photos = await seedPhotos(api.data.a.companyId, 4);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/influencers",
      idempotencyKey: randomUUID(),
      body: { name: "Emily", referenceMediaIds: photos },
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "not_configured" });
    expect(api.queue.forQueue(JOB_QUEUES.influencerPipeline)).toHaveLength(0);
  });

  it("402 budget_exceeded con el mes agotado", async () => {
    await api.request({
      method: "PUT",
      path: "/api/v1/models/budget",
      body: { budgetUsd: 0 },
    });
    const photos = await seedPhotos(api.data.a.companyId, 4);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/influencers",
      idempotencyKey: randomUUID(),
      body: { name: "Emily", referenceMediaIds: photos },
    });
    expect(res.status).toBe(402);
    expect(errorOf(res).details).toMatchObject({ reason: "budget_exceeded" });
  });
});

describe("imágenes del personaje", () => {
  const body = { prompt: "at the gym, selfie", aspectRatio: "9:16", count: 4 };

  it("estimate: SOUL V2 con custom_reference_id, y dice si entra", async () => {
    const id = await seedReady(api.data.a.companyId);
    const res = await api.request({
      method: "POST",
      path: `/api/v1/influencers/${id}/images/estimate`,
      body,
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({
      model: "higgsfield-ai/soul/v2/standard",
      estimate: { usd: 0.03, source: "provider" },
      fits: true,
    });
    expect(estimates).toEqual([
      {
        path: "/estimate/higgsfield-ai/soul/v2/standard",
        auth: "Key key-id-abc:key-secret-xyz",
        body: {
          prompt: "at the gym, selfie",
          aspect_ratio: "9:16",
          batch_size: 4,
          custom_reference_id: SOUL,
          custom_reference_strength: 1,
        },
      },
    ]);
  });

  it("202: reserva en el tope, crea la fila y encola op image; GET generations la lista", async () => {
    const id = await seedReady(api.data.a.companyId);
    const res = await api.request({
      method: "POST",
      path: `/api/v1/influencers/${id}/images`,
      body,
    });
    expect(res.status).toBe(202);
    const gen = dataOf(res) as { id: string; status: string };
    expect(gen).toMatchObject({ status: "queued", influencerId: id, count: 4 });

    const jobs = api.queue.forQueue(JOB_QUEUES.influencerPipeline);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      op: "image",
      companyId: api.data.a.companyId,
      influencerId: id,
      generationId: gen.id,
    });
    expect(jobs[0]?.options?.singletonKey).toBe(`influencer-image:${gen.id}`);

    const spend = JSON.parse(await readFile(join(home, "spend.json"), "utf8")) as {
      months: Record<string, Record<string, { usd: number; state: string }>>;
    };
    expect(spend.months["2026-09"]?.[gen.id]).toMatchObject({
      usd: 0.03,
      state: "reserved",
    });

    const list = await api.request({
      method: "GET",
      path: `/api/v1/influencers/${id}/generations`,
    });
    expect(list.status).toBe(200);
    expect((list.body?.["data"] as { id: string }[]).map((g) => g.id)).toEqual([gen.id]);
  });

  it("402 si pasa el tope, y no encola", async () => {
    await api.request({
      method: "PUT",
      path: "/api/v1/models/budget",
      body: { budgetUsd: 0.02 },
    });
    const id = await seedReady(api.data.a.companyId);
    const res = await api.request({
      method: "POST",
      path: `/api/v1/influencers/${id}/images`,
      body,
    });
    expect(res.status).toBe(402);
    expect(api.queue.forQueue(JOB_QUEUES.influencerPipeline)).toHaveLength(0);
  });

  it("409 not_ready con el personaje entrenando", async () => {
    const id = await seedReady(api.data.a.companyId, "training");
    const res = await api.request({
      method: "POST",
      path: `/api/v1/influencers/${id}/images`,
      body,
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "not_ready" });
    expect(estimates).toHaveLength(0);
  });

  it("404 (nunca 403) con el influencer de otra marca", async () => {
    const theirs = await seedReady(api.data.b.companyId);
    for (const path of [
      `/api/v1/influencers/${theirs}/images`,
      `/api/v1/influencers/${theirs}/images/estimate`,
    ]) {
      const res = await api.request({ method: "POST", path, body });
      expect(res.status).toBe(404);
    }
    const list = await api.request({
      method: "GET",
      path: `/api/v1/influencers/${theirs}/generations`,
    });
    expect(list.status).toBe(404);
    expect(estimates).toHaveLength(0);
  });

  it("400 con una relación que SOUL V2 no tiene", async () => {
    const id = await seedReady(api.data.a.companyId);
    const res = await api.request({
      method: "POST",
      path: `/api/v1/influencers/${id}/images`,
      body: { ...body, aspectRatio: "4:5" },
    });
    expect(res.status).toBe(400);
  });
});
