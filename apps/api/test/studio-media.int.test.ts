/**
 * Sprint 7 (agente F), contra Postgres: Media Bank (búsqueda, etiquetas, sets),
 * Content Studio (`POST /content/studio`), la clave del video propio y el
 * import de posts propios.
 *
 * Lo que persigue, además del camino feliz: que nada cruce de marca (404 o
 * 400 sin distinguir ajeno de inexistente), que el set exija 5 assets vivos,
 * y que el Studio arme el payload **en el servidor** y encole el build con el
 * `prompt` cuando se pide IA.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { JOB_QUEUES } from "@fastgram/core";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { media, withCompany } from "@fastgram/db";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;
// Propio y no el default del arnés: el test del video custom escribe el objeto
// como lo dejaría el PUT del cliente (`MemoryStorage` no recibe PUTs).
const storage = new MemoryStorage(new FixedClock("2026-09-21T12:00:00.000Z"));

beforeAll(async () => {
  api = await startApi({ storage });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

async function addMedia(
  companyId: string,
  values: {
    mediaType: "image" | "video";
    filename: string;
    categories?: string[];
    tags?: string[];
    status?: "ready" | "processing";
    origin?: "manual_upload" | "imported" | "generated";
  },
): Promise<string> {
  return withCompany(api.handle.db, companyId, async (tx) => {
    const [row] = await tx
      .insert(media)
      .values({
        companyId,
        mediaType: values.mediaType,
        filename: values.filename,
        r2Url: `https://cdn.example.test/${values.filename}`,
        storageKey: `media/${companyId}/${randomUUID()}-${values.filename}`,
        sizeMb: 1,
        status: values.status ?? "ready",
        categories: values.categories ?? [],
        tags: values.tags ?? [],
        origin: values.origin ?? "manual_upload",
      })
      .returning({ id: media.mediaId });
    if (row === undefined) throw new Error("no se creó la media");
    return row.id;
  });
}

function items(res: {
  body: Record<string, unknown> | undefined;
}): { filename: string }[] {
  return (res.body?.["data"] ?? []) as { filename: string }[];
}

describe("GET /media · búsqueda y filtros (P2-MEDIA-007)", () => {
  it("q busca por nombre y por etiqueta; tag y category filtran; imported se lista y generated no", async () => {
    const a = api.data.a.companyId;
    await addMedia(a, {
      mediaType: "image",
      filename: "Beach-day.jpg",
      tags: ["summer"],
    });
    await addMedia(a, {
      mediaType: "video",
      filename: "office.mp4",
      categories: ["hook-video"],
      tags: ["office", "pov"],
    });
    await addMedia(a, {
      mediaType: "image",
      filename: "ig-post.jpg",
      origin: "imported",
    });
    await addMedia(a, { mediaType: "image", filename: "gen.png", origin: "generated" });

    const byName = await api.request({ method: "GET", path: "/api/v1/media?q=beach" });
    expect(byName.status).toBe(200);
    expect(items(byName).map((m) => m.filename)).toEqual(["Beach-day.jpg"]);

    const byTagText = await api.request({ method: "GET", path: "/api/v1/media?q=pov" });
    expect(items(byTagText).map((m) => m.filename)).toEqual(["office.mp4"]);

    const byTag = await api.request({ method: "GET", path: "/api/v1/media?tag=Office" });
    expect(items(byTag).map((m) => m.filename)).toEqual(["office.mp4"]);

    const byCategory = await api.request({
      method: "GET",
      path: "/api/v1/media?category=hook-video",
    });
    expect(items(byCategory).map((m) => m.filename)).toEqual(["office.mp4"]);

    const all = items(
      await api.request({ method: "GET", path: "/api/v1/media?limit=100" }),
    );
    expect(all.map((m) => m.filename)).toContain("ig-post.jpg");
    expect(all.map((m) => m.filename)).not.toContain("gen.png");

    // `%` del usuario es literal, no un comodín.
    const literal = await api.request({ method: "GET", path: "/api/v1/media?q=%25" });
    expect(items(literal)).toEqual([]);
  });

  it("la otra marca no ve nada de esto", async () => {
    await addMedia(api.data.a.companyId, {
      mediaType: "image",
      filename: "secret-a.jpg",
    });
    const res = await api.request({
      method: "GET",
      path: "/api/v1/media?q=secret",
      token: api.data.b.token,
    });
    expect(items(res)).toEqual([]);
  });
});

describe("etiquetas", () => {
  it("PATCH {tags} reemplaza (en minúsculas, sin repetir) y GET /media/tags las cuenta", async () => {
    const id = await addMedia(api.data.a.companyId, {
      mediaType: "image",
      filename: "t.jpg",
    });
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/media/${id}`,
      body: { tags: ["Dog", "dog", " park "] },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)["tags"]).toEqual(["dog", "park"]);

    const tags = await api.request({ method: "GET", path: "/api/v1/media/tags" });
    expect(tags.status).toBe(200);
    expect(tags.body?.["data"]).toEqual(
      expect.arrayContaining([
        { tag: "dog", count: 1 },
        { tag: "park", count: 1 },
      ]),
    );

    // Un body sin nada que cambiar es 400.
    const empty = await api.request({
      method: "PATCH",
      path: `/api/v1/media/${id}`,
      body: {},
    });
    expect(empty.status).toBe(400);
  });
});

describe("Media Sets (P2-MEDIA-005/006)", () => {
  it("mínimo 5 assets vivos de la marca; crea, lista y borra", async () => {
    const a = api.data.a.companyId;
    const ids = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        addMedia(a, { mediaType: "image", filename: `s${String(n)}.jpg` }),
      ),
    );

    const four = await api.request({
      method: "POST",
      path: "/api/v1/media/sets",
      body: { name: "Few", kind: "CURATED", mediaIds: ids.slice(0, 4) },
    });
    expect(four.status).toBe(400);

    const foreign = await addMedia(api.data.b.companyId, {
      mediaType: "image",
      filename: "other.jpg",
    });
    const cross = await api.request({
      method: "POST",
      path: "/api/v1/media/sets",
      body: { name: "Cross", kind: "CURATED", mediaIds: [...ids.slice(0, 4), foreign] },
    });
    expect(cross.status).toBe(400);
    expect(errorOf(cross).details).toEqual({ missingMediaIds: [foreign] });

    const created = await api.request({
      method: "POST",
      path: "/api/v1/media/sets",
      body: { name: "Bedroom shots", kind: "SLIDESHOW", mediaIds: ids },
    });
    expect(created.status).toBe(201);
    const setId = dataOf(created)["id"] as string;

    const list = await api.request({ method: "GET", path: "/api/v1/media/sets" });
    expect((list.body?.["data"] as { id: string }[]).map((s) => s.id)).toEqual([setId]);

    const otherBrand = await api.request({
      method: "DELETE",
      path: `/api/v1/media/sets/${setId}`,
      token: api.data.b.token,
    });
    expect(otherBrand.status).toBe(404);

    const deleted = await api.request({
      method: "DELETE",
      path: `/api/v1/media/sets/${setId}`,
    });
    expect(deleted.status).toBe(204);
  });
});

describe("POST /content/studio", () => {
  it("arma el payload de Blitz en el servidor y encola el build; con IA lleva el prompt", async () => {
    const a = api.data.a.companyId;
    const video = await addMedia(a, { mediaType: "video", filename: "bg.mp4" });

    const res = await api.request({
      method: "POST",
      path: "/api/v1/content/studio",
      idempotencyKey: randomUUID(),
      body: {
        format: "wall-of-text",
        media: { video },
        texts: [""],
        textStylePresetId: "yellow-pop",
        ai: { prompt: "3 running tips", mentionBusiness: true },
      },
    });
    expect(res.status).toBe(201);
    const contentId = dataOf(res)["_id"] as string;
    expect(dataOf(res)["status"]).toBe("BUILDING");
    expect(dataOf(res)["type"]).toBe("wall-of-text");

    const jobs = api.queue.forQueue(JOB_QUEUES.contentBuild);
    expect(jobs.at(-1)?.payload).toEqual(
      expect.objectContaining({
        contentId,
        reason: "create",
        prompt: "3 running tips",
        mentionBusiness: true,
      }),
    );

    const [row] = await api.handle.sql<{ build_payload: unknown }[]>`
      select build_payload from contents where id = ${contentId}
    `;
    const payload = row?.build_payload as {
      video: { url: string };
      text: { content: string; color: string };
    };
    expect(payload.video.url).toBe("https://cdn.example.test/bg.mp4");
    // Con IA y el texto vacío, el borrador es el brief.
    expect(payload.text.content).toBe("3 running tips");
    // `yellow-pop` (CAPTION_STYLES de core).
    expect(payload.text.color).toBe("#FFD600");
  });

  it("media ajena, de otro tipo o sin terminar es 400 con los ids", async () => {
    const a = api.data.a.companyId;
    const image = await addMedia(a, { mediaType: "image", filename: "img.jpg" });
    const processing = await addMedia(a, {
      mediaType: "video",
      filename: "p.mp4",
      status: "processing",
    });
    const foreign = await addMedia(api.data.b.companyId, {
      mediaType: "video",
      filename: "b.mp4",
    });
    for (const video of [image, processing, foreign]) {
      const res = await api.request({
        method: "POST",
        path: "/api/v1/content/studio",
        idempotencyKey: randomUUID(),
        body: { format: "wall-of-text", media: { video }, texts: ["hi"] },
      });
      expect(res.status).toBe(400);
      expect(errorOf(res).details).toEqual({ mediaIds: [video] });
    }
  });

  it("slideshow: un texto por slide", async () => {
    const a = api.data.a.companyId;
    const s1 = await addMedia(a, { mediaType: "image", filename: "1.jpg" });
    const s2 = await addMedia(a, { mediaType: "image", filename: "2.jpg" });
    const wrong = await api.request({
      method: "POST",
      path: "/api/v1/content/studio",
      idempotencyKey: randomUUID(),
      body: { format: "slideshow", media: { slides: [s1, s2] }, texts: ["only one"] },
    });
    expect(wrong.status).toBe(400);

    const ok = await api.request({
      method: "POST",
      path: "/api/v1/content/studio",
      idempotencyKey: randomUUID(),
      body: {
        format: "slideshow",
        media: { slides: [s1, s2] },
        texts: ["one", "two"],
        aspectRatio: "1:1",
      },
    });
    expect(ok.status).toBe(201);
    expect(dataOf(ok)["type"]).toBe("slideshow");
  });
});

describe("POST /content/custom/video guarda la clave del archivo", () => {
  it("buildPayload.customVideo lleva la storageKey (y no sale por la API)", async () => {
    const reserve = await api.request({
      method: "POST",
      path: "/api/v1/content/custom/video/upload-url",
      body: { filename: "clip.mov", contentType: "video/quicktime", sizeBytes: 1024 },
    });
    expect(reserve.status).toBe(201);
    const uploadId = dataOf(reserve)["uploadId"] as string;

    // `MemoryStorage` no recibe el PUT: se escribe el objeto directo, como
    // quedaría después del PUT del cliente.
    const [reservation] = await api.handle.sql<{ storage_key: string }[]>`
      select storage_key from upload_reservations where upload_id = ${uploadId}
    `;
    const key = reservation?.storage_key ?? "";
    await storage.put({
      key,
      body: new Uint8Array([1, 2, 3]),
      contentType: "video/quicktime",
    });

    const res = await api.request({
      method: "POST",
      path: "/api/v1/content/custom/video",
      body: { uploadId },
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain("custom-video/");
    const contentId = dataOf(res)["_id"] as string;
    const [row] = await api.handle.sql<{ build_payload: unknown }[]>`
      select build_payload from contents where id = ${contentId}
    `;
    expect(row?.build_payload).toEqual({
      customVideo: {
        storageKey: key,
        contentType: "video/quicktime",
        filename: "clip.mov",
      },
    });
  });
});

describe("POST /media/own-posts/import (FR-011.5.1)", () => {
  it("perfil de TikTok → 202 queued + job; Instagram por perfil → 400", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/media/own-posts/import",
      body: { source: "profile", url: "https://www.tiktok.com/@acme", limit: 5 },
    });
    expect(res.status).toBe(202);
    expect(dataOf(res)).toEqual(
      expect.objectContaining({ state: "queued", platform: "tiktok", limit: 5 }),
    );
    const importId = dataOf(res)["id"] as string;
    expect(api.queue.forQueue(JOB_QUEUES.ownPostImport).at(-1)?.payload).toEqual({
      companyId: api.data.a.companyId,
      importId,
    });

    const status = await api.request({
      method: "GET",
      path: `/api/v1/media/own-posts/import/${importId}`,
    });
    expect(status.status).toBe(200);
    const cross = await api.request({
      method: "GET",
      path: `/api/v1/media/own-posts/import/${importId}`,
      token: api.data.b.token,
    });
    expect(cross.status).toBe(404);

    const ig = await api.request({
      method: "POST",
      path: "/api/v1/media/own-posts/import",
      body: { source: "profile", url: "https://www.instagram.com/acme" },
    });
    expect(ig.status).toBe(400);
  });

  it("una conexión de otra marca es 404; una de TikTok no se lee por conexión (400)", async () => {
    const foreign = await api.request({
      method: "POST",
      path: "/api/v1/media/own-posts/import",
      body: { source: "connection", connectionId: api.data.b.connectionId },
    });
    expect(foreign.status).toBe(404);

    const tiktok = await api.request({
      method: "POST",
      path: "/api/v1/media/own-posts/import",
      body: { source: "connection", connectionId: api.data.a.connectionId },
    });
    expect(tiktok.status).toBe(400);
    expect(errorOf(tiktok).details).toEqual({ reason: "unsupported_platform" });
  });
});
