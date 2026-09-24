/**
 * Biblioteca de modelos del dueño — sprint 8 (agente K).
 *
 * Contra Postgres de verdad (RLS con `fastgram_app` en las rutas de marca),
 * `MemoryStorage` propio (para ver las copias a `models/{owner}/…`) y
 * Higgsfield como **servidor HTTP local** que contesta lo que documenta
 * `docs.higgsfield.ai` (`GET /v1/custom-references/{id}`, el estimador); el
 * adaptador real habla con él. Ninguna llamada real.
 *
 * El fixture siembra `a` y `b` con el **mismo dueño**; el dueño ajeno se
 * siembra acá. Lo que se mide:
 *
 *  - owner-level: la marca activa no cambia nada, y una cookie vieja no rompe;
 *  - importar por fotos (copia + job), por Soul ID (validado contra la API) y
 *    promoviendo un influencer (sin reentrenar);
 *  - asignar a marcas = fila de `influencers` `ready` con el Soul ID, sin
 *    entrenar; desasignar la desactiva; reasignar la reactiva (una fila);
 *  - UGC delegado en la marca (estimador con el Soul ID, cola, pieza);
 *  - marcas o modelos ajenos → 404, y `soulId` nunca sale.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import { companies, users, withoutCompany } from "@fastgram/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const SOUL = "3eb3ad49-775d-40bd-b5e5-38b105108780";
const SOUL_TRAINING = "7c2e2b7a-1f7d-4d59-9a0b-6f3f1b2a9c11";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER = "x-fastgram-workspace";

let api: ApiHarness;
let storage: MemoryStorage;
let home: string;
let server: Server;
let baseUrl: string;
let previousHome: string | undefined;
let foreignCompanyId: string;
let foreignOwnerId: string;
const estimates: { path: string; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === `/v1/custom-references/${SOUL}`) {
        return json(200, { id: SOUL, name: "Mia", status: "completed" });
      }
      if (req.method === "GET" && req.url === `/v1/custom-references/${SOUL_TRAINING}`) {
        return json(200, { id: SOUL_TRAINING, name: "Mia", status: "in_progress" });
      }
      if (req.method === "POST" && req.url?.startsWith("/estimate/")) {
        estimates.push({
          path: req.url,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        return json(200, { credits: "0.480", usd: "0.030" });
      }
      return json(404, { detail: "Not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  home = await mkdtemp(join(tmpdir(), "fastgram-api-models-"));
  previousHome = process.env["FASTGRAM_HOME"];
  process.env["FASTGRAM_HOME"] = home;
  const clock = new FixedClock("2026-09-24T12:00:00.000Z");
  storage = new MemoryStorage(clock);
  api = await startApi({ now: "2026-09-24T12:00:00.000Z", mode: "personal", storage });

  const foreign = await withoutCompany(api.handle.db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        externalIdentityId: `ext-${randomUUID()}`,
        email: `otro-${randomUUID()}@example.test`,
        fullName: "Otro dueño",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");
    const [company] = await tx
      .insert(companies)
      .values({
        name: "ajena",
        ownerUserId: user.id,
        status: "active",
        planId: "growth",
        billingAnchorDay: 1,
        timezone: "UTC",
      })
      .returning({ id: companies.id });
    if (company === undefined) throw new Error("no se creó la company");
    return { companyId: company.id, ownerId: user.id };
  });
  foreignCompanyId = foreign.companyId;
  foreignOwnerId = foreign.ownerId;
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
});

/** N imágenes `ready` en el Media Bank de una marca, con su objeto en el storage. */
async function seedPhotos(companyId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const key = `media/${companyId}/ref-${randomUUID()}.png`;
    await storage.put({ key, body: PNG, contentType: "image/png" });
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

async function importSoul(name = "Mia"): Promise<Record<string, unknown>> {
  const [portrait] = await seedPhotos(api.data.a.companyId, 1);
  const res = await api.request({
    method: "POST",
    path: "/api/v1/character-models",
    idempotencyKey: randomUUID(),
    body: {
      source: "soul_id",
      name,
      fromBrandId: api.data.a.companyId,
      soulId: SOUL,
      portraitMediaId: portrait,
      style: "streetwear",
    },
  });
  expect(res.status, res.raw).toBe(201);
  return dataOf(res);
}

async function assign(modelId: string, brandIds: string[]) {
  return api.request({
    method: "PUT",
    path: `/api/v1/character-models/${modelId}/brands`,
    body: { brandIds },
  });
}

async function linkedRows(modelId: string) {
  return (await api.handle.sql`
    select company_id, is_active, status, soul_id, name
      from influencers where model_id = ${modelId}::uuid
     order by company_id`) as unknown as {
    company_id: string;
    is_active: boolean;
    status: string;
    soul_id: string;
    name: string;
  }[];
}

describe("owner-level", () => {
  it("GET /character-models ignora la marca activa (misma lista con a, b o sin header)", async () => {
    await importSoul();
    const plain = await api.request({ method: "GET", path: "/api/v1/character-models" });
    const withB = await api.request({
      method: "GET",
      path: "/api/v1/character-models",
      headers: { [HEADER]: api.data.b.companyId },
    });
    expect(plain.status).toBe(200);
    expect(withB.raw).toBe(plain.raw);
  });

  it("una cookie de marca vieja (ajena) no la rompe: owner-level no valida el header", async () => {
    const res = await api.request({
      method: "GET",
      path: "/api/v1/character-models",
      headers: { [HEADER]: foreignCompanyId },
    });
    expect(res.status).toBe(200);
  });

  it("el modelo de otro dueño no existe acá", async () => {
    const rows = await api.handle.sql`
      insert into character_models (owner_user_id, name, source, status, progress, soul_id, portrait_url)
      values (${foreignOwnerId}::uuid, 'Ajeno', 'soul_id', 'ready', 100, ${SOUL}, 'http://x.test/p.png')
      returning id`;
    const id = (rows[0] as unknown as { id: string }).id;
    const res = await api.request({
      method: "GET",
      path: `/api/v1/character-models/${id}`,
    });
    expect(res.status).toBe(404);
    const list = dataOf(
      await api.request({ method: "GET", path: "/api/v1/character-models" }),
    ) as unknown as { id: string }[];
    expect(list.map((m) => m.id)).not.toContain(id);
  });
});

describe("importar", () => {
  it("fotos: copia a models/{owner}/…, nace training y encola model-train", async () => {
    const photos = await seedPhotos(api.data.a.companyId, 4);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/character-models",
      idempotencyKey: randomUUID(),
      body: {
        source: "photos",
        name: "Luz",
        fromBrandId: api.data.a.companyId,
        referenceMediaIds: photos,
        age: 27,
      },
    });
    expect(res.status, res.raw).toBe(201);
    const model = dataOf(res);
    expect(model).toMatchObject({
      name: "Luz",
      status: "training",
      source: "photos",
      age: 27,
      voice: null,
      brandIds: [],
    });
    expect(decodeURIComponent(model["portraitUrl"] as string)).toContain("/models/");
    expect(res.raw).not.toContain("soulId");

    const jobs = api.queue.forQueue(JOB_QUEUES.influencerPipeline);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({ op: "model-train", modelId: model["id"] });

    const row = (
      await api.handle.sql`
        select reference_keys from character_models where id = ${model["id"] as string}::uuid`
    )[0] as unknown as { reference_keys: string[] };
    expect(row.reference_keys).toHaveLength(4);
    for (const key of row.reference_keys) {
      expect(key.startsWith("models/")).toBe(true);
      expect(await storage.head(key)).not.toBeNull();
    }
  });

  it("fotos de otra marca que la declarada → 400, sin job", async () => {
    const mine = await seedPhotos(api.data.a.companyId, 3);
    const theirs = await seedPhotos(api.data.b.companyId, 1);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/character-models",
      idempotencyKey: randomUUID(),
      body: {
        source: "photos",
        name: "Luz",
        fromBrandId: api.data.a.companyId,
        referenceMediaIds: [...mine, ...theirs],
      },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({ missing: theirs });
    expect(api.queue.forQueue(JOB_QUEUES.influencerPipeline)).toHaveLength(0);
  });

  it("fromBrandId de otro dueño → 404", async () => {
    const photos = await seedPhotos(api.data.a.companyId, 4);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/character-models",
      idempotencyKey: randomUUID(),
      body: {
        source: "photos",
        name: "Luz",
        fromBrandId: foreignCompanyId,
        referenceMediaIds: photos,
      },
    });
    expect(res.status).toBe(404);
  });

  it("sin Higgsfield → 409 not_configured", async () => {
    await writeFile(join(home, "models.json"), JSON.stringify({ version: 1, tasks: {} }));
    const photos = await seedPhotos(api.data.a.companyId, 4);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/character-models",
      idempotencyKey: randomUUID(),
      body: {
        source: "photos",
        name: "Luz",
        fromBrandId: api.data.a.companyId,
        referenceMediaIds: photos,
      },
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "not_configured" });
  });

  it("Soul ID existente: se valida contra Higgsfield y nace ready", async () => {
    const model = await importSoul();
    expect(model).toMatchObject({
      status: "ready",
      source: "soul_id",
      style: "streetwear",
    });
  });

  it("Soul ID que no está en la cuenta → 400; uno que todavía entrena → 400 not_ready", async () => {
    const [portrait] = await seedPhotos(api.data.a.companyId, 1);
    const base = {
      source: "soul_id",
      name: "X",
      fromBrandId: api.data.a.companyId,
      portraitMediaId: portrait,
    };
    const missing = await api.request({
      method: "POST",
      path: "/api/v1/character-models",
      idempotencyKey: randomUUID(),
      body: { ...base, soulId: randomUUID() },
    });
    expect(missing.status).toBe(400);
    expect(errorOf(missing).details).toMatchObject({ field: "soulId" });
    const training = await api.request({
      method: "POST",
      path: "/api/v1/character-models",
      idempotencyKey: randomUUID(),
      body: { ...base, soulId: SOUL_TRAINING },
    });
    expect(training.status).toBe(400);
    expect(errorOf(training).details).toMatchObject({ reason: "not_ready" });
  });

  it("promover un influencer ready: reusa el Soul ID, queda asignado a su marca; dos veces → 409", async () => {
    const [ref] = await seedPhotos(api.data.a.companyId, 1);
    const rows = await api.handle.sql`
      insert into influencers (company_id, name, status, progress, provider, soul_id, reference_media_ids)
      values (${api.data.a.companyId}::uuid, 'Emily', 'ready', 100, 'higgsfield', ${SOUL},
              ${[ref as string]}::uuid[])
      returning id`;
    const influencerId = (rows[0] as unknown as { id: string }).id;
    const body = {
      source: "influencer",
      fromBrandId: api.data.a.companyId,
      influencerId,
    };
    const res = await api.request({
      method: "POST",
      path: "/api/v1/character-models",
      idempotencyKey: randomUUID(),
      body,
    });
    expect(res.status, res.raw).toBe(201);
    const model = dataOf(res);
    expect(model).toMatchObject({
      name: "Emily",
      status: "ready",
      source: "influencer",
      brandIds: [api.data.a.companyId],
    });
    const again = await api.request({
      method: "POST",
      path: "/api/v1/character-models",
      idempotencyKey: randomUUID(),
      body,
    });
    expect(again.status).toBe(409);

    // La pantalla de Influencers de la marca lo marca como «From library».
    const one = dataOf(
      await api.request({ method: "GET", path: `/api/v1/influencers/${influencerId}` }),
    );
    expect(one["modelId"]).toBe(model["id"]);
  });
});

describe("asignar a marcas", () => {
  it("crea la fila ready con el Soul ID en cada marca; desasignar desactiva; reasignar reactiva", async () => {
    const model = await importSoul("Nina");
    const id = model["id"] as string;
    const both = await assign(id, [api.data.a.companyId, api.data.b.companyId]);
    expect(both.status, both.raw).toBe(200);
    expect(new Set(dataOf(both)["brandIds"] as string[])).toEqual(
      new Set([api.data.a.companyId, api.data.b.companyId]),
    );
    let rows = await linkedRows(id);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({
        is_active: true,
        status: "ready",
        soul_id: SOUL,
        name: "Nina",
      });
    }

    // La marca b lo ve en su lista de influencers, con el badge.
    const list = await api.request({
      method: "GET",
      path: "/api/v1/influencers",
      headers: { [HEADER]: api.data.b.companyId },
    });
    const items = list.body?.["data"] as { modelId?: string }[];
    expect(items.some((i) => i.modelId === id)).toBe(true);
    expect(list.raw).not.toContain(SOUL);

    const onlyA = await assign(id, [api.data.a.companyId]);
    expect(dataOf(onlyA)["brandIds"]).toEqual([api.data.a.companyId]);
    rows = await linkedRows(id);
    expect(rows.find((r) => r.company_id === api.data.b.companyId)?.is_active).toBe(
      false,
    );

    await assign(id, [api.data.a.companyId, api.data.b.companyId]);
    rows = await linkedRows(id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.is_active)).toBe(true);
  });

  it("una marca ajena → 404 y no cambia nada", async () => {
    const model = await importSoul();
    const res = await assign(model["id"] as string, [
      api.data.a.companyId,
      foreignCompanyId,
    ]);
    expect(res.status).toBe(404);
    expect(await linkedRows(model["id"] as string)).toHaveLength(0);
  });

  it("un modelo que todavía entrena → 409 not_ready", async () => {
    const rows = await api.handle.sql`
      insert into character_models (owner_user_id, name, source, status, progress, portrait_url)
      select owner_user_id, 'T', 'photos', 'training', 50, 'http://x.test/p.png'
        from companies where id = ${api.data.a.companyId}::uuid
      returning id`;
    const id = (rows[0] as unknown as { id: string }).id;
    const res = await assign(id, [api.data.a.companyId]);
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "not_ready" });
  });
});

describe("voz y edición", () => {
  it("guarda una voz de fal del catálogo; un modelo TTS fuera del catálogo → 400", async () => {
    const model = await importSoul();
    const path = `/api/v1/character-models/${model["id"] as string}`;
    const ok = await api.request({
      method: "PATCH",
      path,
      body: {
        voice: {
          provider: "fal",
          model: "fal-ai/elevenlabs/tts/eleven-v3",
          voiceId: "Aria",
        },
        notes: "gym and coffee",
      },
    });
    expect(ok.status, ok.raw).toBe(200);
    expect(dataOf(ok)).toMatchObject({
      voice: {
        provider: "fal",
        model: "fal-ai/elevenlabs/tts/eleven-v3",
        voiceId: "Aria",
      },
      notes: "gym and coffee",
    });
    const bad = await api.request({
      method: "PATCH",
      path,
      body: { voice: { provider: "fal", model: "fal-ai/made-up-tts", voiceId: "Aria" } },
    });
    expect(bad.status).toBe(400);
    const cleared = await api.request({ method: "PATCH", path, body: { voice: null } });
    expect(dataOf(cleared)["voice"]).toBeNull();
  });

  it("renombrar el modelo renombra sus filas en las marcas", async () => {
    const model = await importSoul("Old");
    const id = model["id"] as string;
    await assign(id, [api.data.a.companyId]);
    await api.request({
      method: "PATCH",
      path: `/api/v1/character-models/${id}`,
      body: { name: "New" },
    });
    expect((await linkedRows(id))[0]?.name).toBe("New");
  });
});

describe("UGC para una marca (delegado)", () => {
  it("estima con el Soul ID del modelo, encola en la marca y lista lo generado", async () => {
    const model = await importSoul();
    const id = model["id"] as string;
    await assign(id, [api.data.b.companyId]);

    const est = await api.request({
      method: "POST",
      path: `/api/v1/character-models/${id}/ugc/estimate`,
      body: { brandId: api.data.b.companyId, prompt: "selfie holding a coffee cup" },
    });
    expect(est.status, est.raw).toBe(200);
    expect(estimates[0]?.body).toMatchObject({ custom_reference_id: SOUL });

    const gen = await api.request({
      method: "POST",
      path: `/api/v1/character-models/${id}/ugc`,
      body: { brandId: api.data.b.companyId, prompt: "selfie holding a coffee cup" },
    });
    expect(gen.status, gen.raw).toBe(202);
    const jobs = api.queue.forQueue(JOB_QUEUES.influencerPipeline);
    expect(jobs[0]?.payload).toMatchObject({
      op: "image",
      companyId: api.data.b.companyId,
    });

    const list = await api.request({
      method: "GET",
      path: `/api/v1/character-models/${id}/ugc?brandId=${api.data.b.companyId}`,
    });
    expect(list.status).toBe(200);
    expect(list.body?.["data"]).toHaveLength(1);
  });

  it("una marca donde no está asignado → 404 not_assigned", async () => {
    const model = await importSoul();
    const res = await api.request({
      method: "POST",
      path: `/api/v1/character-models/${model["id"] as string}/ugc/estimate`,
      body: { brandId: api.data.b.companyId, prompt: "x" },
    });
    expect(res.status).toBe(404);
    expect(errorOf(res).details).toMatchObject({ reason: "not_assigned" });
  });

  it("pieza: slideshow modelo + producto en la Library de la marca; textos que no cuadran → 400", async () => {
    const model = await importSoul();
    const id = model["id"] as string;
    await assign(id, [api.data.b.companyId]);
    const [shot, product] = await seedPhotos(api.data.b.companyId, 2);
    const bad = await api.request({
      method: "POST",
      path: `/api/v1/character-models/${id}/ugc/piece`,
      body: {
        brandId: api.data.b.companyId,
        kind: "image",
        sourceMediaId: shot,
        productMediaIds: [product],
        texts: ["only one"],
      },
    });
    expect(bad.status).toBe(400);
    const res = await api.request({
      method: "POST",
      path: `/api/v1/character-models/${id}/ugc/piece`,
      idempotencyKey: randomUUID(),
      body: {
        brandId: api.data.b.companyId,
        kind: "image",
        sourceMediaId: shot,
        productMediaIds: [product],
        texts: ["POV: my morning", "the one I use"],
      },
    });
    expect(res.status, res.raw).toBe(201);
    const piece = dataOf(res);
    const owner = await api.handle.sql`
      select company_id from contents where id = ${piece["_id"] as string}::uuid`;
    expect((owner[0] as unknown as { company_id: string }).company_id).toBe(
      api.data.b.companyId,
    );
  });

  it("media de una marca del dueño: imágenes listas; marca ajena → 404", async () => {
    await seedPhotos(api.data.b.companyId, 1);
    const ok = await api.request({
      method: "GET",
      path: `/api/v1/character-models/brands/${api.data.b.companyId}/media`,
    });
    expect(ok.status, ok.raw).toBe(200);
    expect((ok.body?.["data"] as unknown[]).length).toBeGreaterThan(0);
    const foreign = await api.request({
      method: "GET",
      path: `/api/v1/character-models/brands/${foreignCompanyId}/media`,
    });
    expect(foreign.status).toBe(404);
  });
});

describe("borrar", () => {
  it("desactiva sus filas en las marcas y deja model_id nulo", async () => {
    const model = await importSoul();
    const id = model["id"] as string;
    await assign(id, [api.data.a.companyId]);
    const before = await api.handle.sql`
      select id from influencers where model_id = ${id}::uuid`;
    const influencerId = (before[0] as unknown as { id: string }).id;
    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/character-models/${id}`,
    });
    expect(res.status).toBe(204);
    const row = (
      await api.handle
        .sql`select is_active, model_id from influencers where id = ${influencerId}::uuid`
    )[0] as unknown as { is_active: boolean; model_id: string | null };
    expect(row).toEqual({ is_active: false, model_id: null });
    expect(
      (await api.request({ method: "GET", path: `/api/v1/character-models/${id}` }))
        .status,
    ).toBe(404);
  });
});
