/**
 * `POST /media/import`, `GET /media/import/:id`, `GET /media/meta` —
 * `PU-MEME-001`/`003`.
 *
 * Lo que se mide acá es la ruta: validación, qué encola, el estado que
 * devuelve, el 404 cruzado y que los códigos de fallo salgan como dato. Que el
 * worker baje, suba y normalice lo mide
 * `apps/worker/test/media-import.int.test.ts`.
 */
import { randomUUID } from "node:crypto";

import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { UPLOAD_VIDEO_MAX_MB } from "@fastgram/contracts";
import {
  JOB_QUEUES,
  MEDIA_IMPORT_MAX_MB,
  importStatusKey,
  mediaMetaKey,
  type MediaImportJob,
} from "@fastgram/core";
import { MEDIA_IMPORT_FAILURE_CODES } from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mediaImportFailureCodeSchema } from "@fastgram/contracts";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const NOW = "2026-09-24T12:00:00.000Z";
let api: ApiHarness;
let storage: MemoryStorage;

beforeAll(async () => {
  storage = new MemoryStorage(new FixedClock(NOW));
  api = await startApi({ now: NOW, storage });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

async function put(key: string, value: unknown): Promise<void> {
  await storage.put({
    key,
    body: new TextEncoder().encode(JSON.stringify(value)),
    contentType: "application/json",
  });
}

describe("constantes atadas", () => {
  it("el tope de bytes del import es el de video del contrato, y los códigos coinciden", () => {
    expect(MEDIA_IMPORT_MAX_MB).toBe(UPLOAD_VIDEO_MAX_MB);
    expect([...mediaImportFailureCodeSchema.options]).toEqual([
      ...MEDIA_IMPORT_FAILURE_CODES,
    ]);
  });
});

describe("POST /media/import", () => {
  it("202, encola media-import con el companyId del token y deja el estado queued", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/media/import",
      body: {
        url: "https://www.youtube.com/watch?v=abc",
        kind: "video",
        categories: ["green-screen-video", "green-screen-video"],
      },
    });
    expect(res.status).toBe(202);
    const body = dataOf(res);
    expect(body).toMatchObject({
      kind: "video",
      state: "queued",
      sourceUrl: "https://www.youtube.com/watch?v=abc",
    });
    // Sin ids internos de la cola.
    expect(body["jobId"]).toBeUndefined();

    const jobs = api.queue.forQueue(JOB_QUEUES.mediaImport);
    expect(jobs).toHaveLength(1);
    const payload = jobs[0]?.payload as MediaImportJob;
    expect(payload).toMatchObject({
      companyId: api.data.a.companyId,
      importId: body["importId"],
      url: "https://www.youtube.com/watch?v=abc",
      kind: "video",
      categories: ["green-screen-video"],
    });
    expect(payload.mediaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(jobs[0]?.options?.retryLimit).toBe(1);

    const get = await api.request({
      method: "GET",
      path: `/api/v1/media/import/${String(body["importId"])}`,
    });
    expect(get.status).toBe(200);
    expect(dataOf(get)).toMatchObject({ state: "queued", importId: body["importId"] });
  });

  it.each([
    ["file:///etc/passwd"],
    ["http://localhost:3001/x"],
    ["http://169.254.169.254/latest"],
    ["ftp://example.com/a.mp4"],
  ])("400 bad_request con reason unsupported_url para %s, sin encolar", async (url) => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/media/import",
      body: { url, kind: "video" },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatchObject({
      code: "bad_request",
      details: { reason: "unsupported_url" },
    });
    expect(api.queue.forQueue(JOB_QUEUES.mediaImport)).toHaveLength(0);
  });

  it("400 por categorías de imagen, kind desconocido o audio con categorías", async () => {
    for (const body of [
      { url: "https://x.example.com/v", kind: "video", categories: ["slideshow-image"] },
      { url: "https://x.example.com/v", kind: "image" },
      { url: "https://x.example.com/v", kind: "audio", categories: ["hook-video"] },
      { url: "https://x.example.com/v", kind: "video", extra: 1 },
    ]) {
      const res = await api.request({
        method: "POST",
        path: "/api/v1/media/import",
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(api.queue.forQueue(JOB_QUEUES.mediaImport)).toHaveLength(0);
  });

  it("la misma Idempotency-Key devuelve el mismo import y no encola dos veces", async () => {
    const body = { url: "https://vimeo.com/123", kind: "audio" };
    const key = `imp-${randomUUID()}`;
    const a = await api.request({
      method: "POST",
      path: "/api/v1/media/import",
      body,
      idempotencyKey: key,
    });
    const b = await api.request({
      method: "POST",
      path: "/api/v1/media/import",
      body,
      idempotencyKey: key,
    });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(dataOf(b)["importId"]).toBe(dataOf(a)["importId"]);
    expect(api.queue.forQueue(JOB_QUEUES.mediaImport)).toHaveLength(1);
  });
});

describe("GET /media/import/:id", () => {
  it("el import de otra marca es el mismo 404 que uno inventado", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/media/import",
      body: { url: "https://x.example.com/v", kind: "video" },
    });
    const id = String(dataOf(res)["importId"]);

    const ajeno = await api.request({
      method: "GET",
      path: `/api/v1/media/import/${id}`,
      token: api.data.b.token,
    });
    const inventado = await api.request({
      method: "GET",
      path: `/api/v1/media/import/${randomUUID()}`,
      token: api.data.b.token,
    });
    expect(ajeno.status).toBe(404);
    expect(ajeno.raw).toBe(inventado.raw);
    // Un id que no es uuid no llega a armar una clave de storage.
    const raro = await api.request({
      method: "GET",
      path: "/api/v1/media/import/..%2F..%2Fx",
    });
    expect(raro.status).toBe(404);
  });

  it("un fallo del worker sale como dato con código estable, y la fila con su estado", async () => {
    const companyId = api.data.a.companyId;
    const failedId = randomUUID();
    await put(importStatusKey(companyId, failedId), {
      importId: failedId,
      kind: "video",
      state: "failed",
      sourceUrl: "https://x.example.com/v",
      error: "too_long",
      jobId: "media-import#x",
      updatedAt: 1,
    });
    const failed = await api.request({
      method: "GET",
      path: `/api/v1/media/import/${failedId}`,
    });
    expect(dataOf(failed)).toMatchObject({ state: "failed", error: "too_long" });
    expect(dataOf(failed)["jobId"]).toBeUndefined();

    const okId = randomUUID();
    const mediaId = String(api.data.a.mediaId);
    await put(importStatusKey(companyId, okId), {
      importId: okId,
      kind: "video",
      state: "imported",
      sourceUrl: "https://x.example.com/v",
      mediaId,
      background: "needs_background_removal",
      tagging: "tagged",
      tags: { emotion: "smug", situation: "x", people: 1, tags: ["a"] },
      updatedAt: 2,
    });
    const ok = await api.request({ method: "GET", path: `/api/v1/media/import/${okId}` });
    expect(dataOf(ok)).toMatchObject({
      state: "imported",
      mediaId,
      mediaStatus: expect.stringMatching(/processing|ready|failed/),
      background: "needs_background_removal",
      tags: { emotion: "smug" },
    });
  });

  it("un job que la cola dio por muerto se informa failed/download_failed", async () => {
    const companyId = api.data.a.companyId;
    const id = randomUUID();
    await put(importStatusKey(companyId, id), {
      importId: id,
      kind: "video",
      state: "downloading",
      sourceUrl: "https://x.example.com/v",
      jobId: "media-import#dead",
      updatedAt: 3,
    });
    const original = api.queue.getJob.bind(api.queue);
    api.queue.getJob = (async () => ({
      jobId: "media-import#dead",
      queue: JOB_QUEUES.mediaImport,
      state: "expired",
      payload: {},
      attempt: 2,
      retryLimit: 1,
      createdAt: new Date(0),
    })) as typeof api.queue.getJob;
    try {
      const res = await api.request({
        method: "GET",
        path: `/api/v1/media/import/${id}`,
      });
      expect(dataOf(res)).toMatchObject({ state: "failed", error: "download_failed" });
    } finally {
      api.queue.getJob = original;
    }
  });
});

describe("GET /media/meta", () => {
  it("devuelve sólo la metadata de la marca del token y valida los ids", async () => {
    const a = api.data.a.companyId;
    const mediaId = randomUUID();
    await put(mediaMetaKey(a, mediaId), {
      mediaId,
      sourceUrl: "https://x.example.com/v",
      tags: { emotion: "smug", situation: "x", people: 0, tags: ["t"] },
      background: "green_screen",
      intruso: "no sale",
    });
    const mine = await api.request({
      method: "GET",
      path: `/api/v1/media/meta?ids=${mediaId},${randomUUID()}`,
    });
    expect(mine.status).toBe(200);
    const list = mine.body?.["data"] as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      mediaId,
      sourceUrl: "https://x.example.com/v",
      tags: { emotion: "smug", situation: "x", people: 0, tags: ["t"] },
      background: "green_screen",
    });

    const other = await api.request({
      method: "GET",
      path: `/api/v1/media/meta?ids=${mediaId}`,
      token: api.data.b.token,
    });
    expect(other.body?.["data"]).toEqual([]);

    const bad = await api.request({
      method: "GET",
      path: "/api/v1/media/meta?ids=../../x",
    });
    expect(bad.status).toBe(400);
  });
});

// Al final: `startApi` vuelve a sembrar y deja inválidas las keys del harness de arriba.
describe("POST /media/import sin cola", () => {
  it("sin cola: 503 sin escribir nada", async () => {
    const sinCola = await startApi({ now: NOW, withQueue: false });
    try {
      const res = await sinCola.request({
        method: "POST",
        path: "/api/v1/media/import",
        body: { url: "https://x.example.com/v", kind: "video" },
      });
      expect(res.status).toBe(503);
    } finally {
      await sinCola.close();
    }
  });
});
