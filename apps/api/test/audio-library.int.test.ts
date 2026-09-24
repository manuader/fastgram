/**
 * Sprint 7 — la biblioteca de audio de la marca: `/audio/library`.
 *
 * El PUT del paso 2 de §9.8 no ocurre con `MemoryStorage` (sus URLs son
 * sintéticas), así que el test hace lo que haría el navegador: pone el objeto
 * en la clave de la reserva, y recién ahí finaliza. El PUT de verdad contra
 * MinIO lo ejercita `media-upload.int.test.ts` para el Media Bank; es el mismo
 * `reserveUpload`.
 */
import { randomUUID } from "node:crypto";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;
const storage = new MemoryStorage(new FixedClock("2026-09-21T12:00:00.000Z"));

beforeAll(async () => {
  api = await startApi({ storage });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

const MB = 1024 * 1024;

async function reserve(
  body: Record<string, unknown>,
  token?: string,
): Promise<ReturnType<ApiHarness["request"]>> {
  return api.request({
    method: "POST",
    path: "/api/v1/audio/library/upload-url",
    body,
    ...(token === undefined ? {} : { token }),
  });
}

async function keyOf(uploadId: string): Promise<string> {
  const rows = await api.handle.sql`
    select storage_key from upload_reservations where upload_id = ${uploadId}::uuid
  `;
  return String(rows[0]?.["storage_key"]);
}

/** Reserva + "PUT" + finalización. Devuelve la pista creada. */
async function upload(
  filename = "Mi Beat.mp3",
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const reserved = await reserve({
    filename,
    contentType: "audio/mpeg",
    sizeBytes: 3 * 1024,
  });
  expect(reserved.status).toBe(200);
  const uploadId = String(dataOf(reserved)["uploadId"]);
  await storage.put({
    key: await keyOf(uploadId),
    body: new Uint8Array(3 * 1024),
    contentType: "audio/mpeg",
  });
  const res = await api.request({
    method: "POST",
    path: "/api/v1/audio/library",
    body: { uploadId, ...extra },
  });
  expect(res.status).toBe(201);
  return dataOf(res);
}

async function list(query = "", token?: string): Promise<Record<string, unknown>[]> {
  const res = await api.request({
    method: "GET",
    path: `/api/v1/audio/library${query}`,
    ...(token === undefined ? {} : { token }),
  });
  expect(res.status).toBe(200);
  return (res.body?.["data"] ?? []) as Record<string, unknown>[];
}

describe("POST /audio/library/upload-url", () => {
  it("la clave cae bajo audio/{companyId}/, el prefijo que el render autoriza", async () => {
    const res = await reserve({
      filename: "a.mp3",
      contentType: "audio/mpeg",
      sizeBytes: 1024,
    });
    expect(res.status).toBe(200);
    const key = await keyOf(String(dataOf(res)["uploadId"]));
    expect(key.startsWith(`audio/${api.data.a.companyId}/`)).toBe(true);
  });

  it.each([
    ["extensión que no coincide", { filename: "a.wav", contentType: "audio/mpeg" }],
    ["un video no es audio", { filename: "a.mp4", contentType: "video/mp4" }],
    [
      "más de 20 MB",
      { filename: "a.mp3", contentType: "audio/mpeg", sizeBytes: 20 * MB + 1 },
    ],
  ])("%s: 400", async (_name, body) => {
    const res = await reserve({ sizeBytes: 1024, ...body });
    expect(res.status).toBe(400);
  });

  it("acepta m4a, aac y wav", async () => {
    for (const [filename, contentType] of [
      ["a.m4a", "audio/mp4"],
      ["a.m4a", "audio/x-m4a"],
      ["a.aac", "audio/aac"],
      ["a.wav", "audio/wav"],
    ]) {
      expect((await reserve({ filename, contentType, sizeBytes: 1024 })).status).toBe(
        200,
      );
    }
  });
});

describe("POST /audio/library — finalizar", () => {
  it("crea la pista: título del archivo, URL del objeto, autoUse por defecto", async () => {
    const track = await upload("Mi Beat.mp3");
    expect(track).toMatchObject({
      title: "Mi Beat",
      origin: "upload",
      contentType: "audio/mpeg",
      autoUse: true,
    });
    expect(String(track["url"])).toContain(
      encodeURIComponent(`audio/${api.data.a.companyId}/`),
    );
    expect(Number(track["sizeMb"])).toBeCloseTo(3 / 1024, 5);
  });

  it("con título explícito, usa ése", async () => {
    const track = await upload("x.mp3", { title: "Intro épica" });
    expect(track["title"]).toBe("Intro épica");
  });

  it("sin el objeto en el bucket: 409 y la reserva sigue viva", async () => {
    const res = await reserve({
      filename: "a.mp3",
      contentType: "audio/mpeg",
      sizeBytes: 9,
    });
    const uploadId = String(dataOf(res)["uploadId"]);
    const first = await api.request({
      method: "POST",
      path: "/api/v1/audio/library",
      body: { uploadId },
    });
    expect(first.status).toBe(409);
  });

  it("la reserva de otra marca: 404", async () => {
    const res = await reserve({
      filename: "a.mp3",
      contentType: "audio/mpeg",
      sizeBytes: 9,
    });
    const uploadId = String(dataOf(res)["uploadId"]);
    await storage.put({
      key: await keyOf(uploadId),
      body: new Uint8Array(9),
      contentType: "audio/mpeg",
    });
    const other = await api.request({
      method: "POST",
      path: "/api/v1/audio/library",
      body: { uploadId },
      token: api.data.b.token,
    });
    expect(other.status).toBe(404);
  });

  it("una reserva del Media Bank no entra a la biblioteca de audio: 404", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/media/upload-url",
      body: { filename: "a.png", contentType: "image/png", sizeBytes: 9 },
    });
    expect(res.status).toBe(200);
    const uploadId = String(dataOf(res)["uploadId"]);
    await storage.put({
      key: await keyOf(uploadId),
      body: new Uint8Array(9),
      contentType: "image/png",
    });
    const finalize = await api.request({
      method: "POST",
      path: "/api/v1/audio/library",
      body: { uploadId },
    });
    expect(finalize.status).toBe(404);
  });
});

describe("GET /audio/library", () => {
  it("más nuevas primero, búsqueda por título, y sólo las de la marca", async () => {
    const tag = randomUUID().slice(0, 8);
    await upload(`uno-${tag}.mp3`);
    await upload(`dos-${tag}.mp3`);

    const found = await list(`?q=${tag}`);
    expect(found.map((t) => t["title"])).toEqual([`dos-${tag}`, `uno-${tag}`]);
    expect(await list(`?q=${encodeURIComponent("uno-" + tag)}`)).toHaveLength(1);
    // Los comodines del término se escapan: `%` busca un `%`.
    expect(await list(`?q=${encodeURIComponent("%")}`)).toHaveLength(0);

    expect(await list(`?q=${tag}`, api.data.b.token)).toHaveLength(0);
  });

  it("pagina con cursor", async () => {
    const tag = randomUUID().slice(0, 8);
    for (const n of [1, 2, 3]) await upload(`p${String(n)}-${tag}.mp3`);
    const first = await api.request({
      method: "GET",
      path: `/api/v1/audio/library?q=${tag}&limit=2`,
    });
    const pagination = first.body?.["pagination"] as { cursor: string; hasMore: boolean };
    expect(pagination.hasMore).toBe(true);
    const second = await list(`?q=${tag}&limit=2&cursor=${pagination.cursor}`);
    expect(second.map((t) => t["title"])).toEqual([`p1-${tag}`]);
  });
});

describe("PATCH y DELETE /audio/library/:id", () => {
  it("renombra y saca del sorteo; borrar la saca de la lista", async () => {
    const track = await upload("renombrar.mp3");
    const id = String(track["id"]);

    const renamed = await api.request({
      method: "PATCH",
      path: `/api/v1/audio/library/${id}`,
      body: { title: "Nuevo nombre", autoUse: false },
    });
    expect(renamed.status).toBe(200);
    expect(dataOf(renamed)).toMatchObject({ title: "Nuevo nombre", autoUse: false });

    const empty = await api.request({
      method: "PATCH",
      path: `/api/v1/audio/library/${id}`,
      body: {},
    });
    expect(empty.status).toBe(400);

    const del = await api.request({
      method: "DELETE",
      path: `/api/v1/audio/library/${id}`,
    });
    expect(del.status).toBe(204);
    expect((await list()).some((t) => t["id"] === id)).toBe(false);
    // El objeto queda: una pieza que ya la usa se sigue renderizando.
    const again = await api.request({
      method: "DELETE",
      path: `/api/v1/audio/library/${id}`,
    });
    expect(again.status).toBe(404);
  });

  it("la pista de otra marca es 404, igual que una que no existe", async () => {
    const track = await upload("ajena.mp3");
    const id = String(track["id"]);
    for (const method of ["PATCH", "DELETE"] as const) {
      const res = await api.request({
        method,
        path: `/api/v1/audio/library/${id}`,
        token: api.data.b.token,
        ...(method === "PATCH" ? { body: { title: "robada" } } : {}),
      });
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe("not_found");
    }
    // Sigue intacta para su dueño.
    expect((await list()).find((t) => t["id"] === id)?.["title"]).toBe("ajena");
  });
});
