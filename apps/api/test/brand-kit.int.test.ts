/**
 * `POST /media/brand-kit` y el listado de `brand_kit` — `PU-MEDIA-002`.
 *
 * Lo que se mide es **qué encola la ruta** (cola, payload, clave) y que el
 * Media Bank liste el origen nuevo sin empezar a listar los que FR-100
 * esconde. Que el worker genere y cree las filas lo mide
 * `apps/worker/test/brand-backgrounds.int.test.ts`.
 */
import { JOB_QUEUES } from "@fastgram/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi({ now: "2026-09-24T12:00:00.000Z" });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

describe("POST /media/brand-kit — 202 y encola brand-backgrounds", () => {
  it("sin cuerpo: kit por defecto (8 + 3), semilla nueva, un job con el companyId del token", async () => {
    const res = await api.request({ method: "POST", path: "/api/v1/media/brand-kit" });
    expect(res.status).toBe(202);
    const body = dataOf(res);
    expect(body).toMatchObject({ images: 8, videos: 3, enqueued: true });
    expect(String(body["seed"])).toMatch(/^kit-[0-9a-f-]{36}$/);

    const jobs = api.queue.forQueue(JOB_QUEUES.brandBackgrounds);
    expect(jobs).toHaveLength(1);
    // El scope sale del token y de nada más: el cuerpo no tiene companyId.
    expect(jobs[0]?.payload).toEqual({
      companyId: api.data.a.companyId,
      seed: body["seed"],
      images: 8,
      videos: 3,
    });
    expect(jobs[0]?.options?.singletonKey).toBe(
      `brand-backgrounds:${api.data.a.companyId}:${String(body["seed"])}:8x3`,
    );
    expect(jobs[0]?.options?.retryLimit).toBe(2);
  });

  it("sin semilla, dos pedidos son dos kits distintos", async () => {
    const a = await api.request({ method: "POST", path: "/api/v1/media/brand-kit" });
    const b = await api.request({ method: "POST", path: "/api/v1/media/brand-kit" });
    expect(dataOf(a)["seed"]).not.toBe(dataOf(b)["seed"]);
    expect(api.queue.forQueue(JOB_QUEUES.brandBackgrounds)).toHaveLength(2);
  });

  it("misma marca + semilla + cantidades: un solo job, y el segundo dice enqueued=false", async () => {
    const body = { seed: "mi-kit", images: 2, videos: 1 };
    const first = await api.request({
      method: "POST",
      path: "/api/v1/media/brand-kit",
      body,
    });
    const second = await api.request({
      method: "POST",
      path: "/api/v1/media/brand-kit",
      body,
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(dataOf(first)["enqueued"]).toBe(true);
    expect(dataOf(second)["enqueued"]).toBe(false);
    expect(api.queue.forQueue(JOB_QUEUES.brandBackgrounds)).toHaveLength(1);
  });

  it("la misma semilla en otra marca es otro job (la clave lleva el companyId)", async () => {
    const body = { seed: "compartida" };
    await api.request({ method: "POST", path: "/api/v1/media/brand-kit", body });
    await api.request({
      method: "POST",
      path: "/api/v1/media/brand-kit",
      body,
      token: api.data.b.token,
    });
    const jobs = api.queue.forQueue(JOB_QUEUES.brandBackgrounds);
    expect(
      jobs.map((j) => (j.payload as { companyId: string }).companyId).sort(),
    ).toEqual([api.data.a.companyId, api.data.b.companyId].sort());
  });

  it("Idempotency-Key: el replay devuelve la misma semilla y no encola otro", async () => {
    const a = await api.request({
      method: "POST",
      path: "/api/v1/media/brand-kit",
      idempotencyKey: "kit-key-1",
    });
    const b = await api.request({
      method: "POST",
      path: "/api/v1/media/brand-kit",
      idempotencyKey: "kit-key-1",
    });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(dataOf(b)["seed"]).toBe(dataOf(a)["seed"]);
    expect(api.queue.forQueue(JOB_QUEUES.brandBackgrounds)).toHaveLength(1);
  });

  it.each([
    ["nada que generar", { images: 0, videos: 0 }],
    ["imágenes de más", { images: 21 }],
    ["videos de más", { videos: 7 }],
    ["semilla con espacios", { seed: "a b" }],
    ["campo desconocido", { palette: ["#000000"] }],
  ])("400: %s — y no encola", async (_, body) => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/media/brand-kit",
      body,
    });
    expect(api.queue.forQueue(JOB_QUEUES.brandBackgrounds)).toHaveLength(0);
    expect(res.status).toBe(400);
    expect(errorOf(res)["code"]).toBe("bad_request");
  });
});

describe("GET /media lista `brand_kit` y sigue escondiendo lo generado", () => {
  it("brand_kit sí, generated no, y nada de otra marca", async () => {
    const a = api.data.a.companyId;
    const b = api.data.b.companyId;
    const fila = (companyId: string, origin: string, name: string) => api.handle.sql`
      insert into media (company_id, media_type, filename, r2_url, storage_key, status,
                         size_mb, categories, origin)
      values (${companyId}::uuid, 'image', ${name},
              ${`https://bucket.test/media/${companyId}/${name}`},
              ${`media/${companyId}/${name}`}, 'ready', 0.1,
              '{slideshow-image}'::text[], ${origin}::media_origin)
    `;
    await fila(a, "brand_kit", "kit-a.jpg");
    await fila(a, "generated", "gen-a.jpg");
    await fila(b, "brand_kit", "kit-b.jpg");

    const res = await api.request({ method: "GET", path: "/api/v1/media?limit=100" });
    expect(res.status).toBe(200);
    const items = (res.body?.["data"] ?? []) as Record<string, unknown>[];
    const names = items.map((m) => m["filename"]);
    // Negativas primero (trampa 35).
    expect(names).not.toContain("gen-a.jpg");
    expect(names).not.toContain("kit-b.jpg");
    expect(names).toContain("kit-a.jpg");
    const kit = items.find((m) => m["filename"] === "kit-a.jpg");
    expect(kit?.["origin"]).toBe("brand_kit");
  });
});

describe("POST /media/brand-kit sin cola", () => {
  let sinCola: ApiHarness;
  beforeAll(async () => {
    sinCola = await startApi({ now: "2026-09-24T12:00:00.000Z", withQueue: false });
  }, 180_000);
  afterAll(async () => {
    await sinCola?.close();
  });

  it("503 service_unavailable", async () => {
    const res = await sinCola.request({
      method: "POST",
      path: "/api/v1/media/brand-kit",
    });
    expect(res.status).toBe(503);
    expect(errorOf(res)["code"]).toBe("service_unavailable");
  });
});
