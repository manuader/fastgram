/**
 * `P2-RENDER-009` — `POST /content` rechaza media que no es de la marca con
 * `400 bad_request` **antes** de cobrar y de encolar.
 *
 * El render ya la rechazaba (`apps/worker/src/content/media-authorization.ts`),
 * pero después del save cobrado y del job encolado: la pieza nacía, fallaba y
 * reembolsaba. Acá se fija que la API corta antes y que no queda nada escrito.
 *
 * Cada rechazo se mide primero por lo que **no** pasó (sin job, sin fila) y
 * después por el status (trampa 35).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOB_QUEUES } from "@fastgram/core";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";
import { ownedAudioUrl, ownedMediaUrl } from "./helpers/owned-media.js";

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi();
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

const draw = (url: string) => ({ url, drawX: 0, drawY: 0, drawW: 1080, drawH: 1920 });

const TEXT = {
  content: "Guía rápida",
  x: 50,
  y: 50,
  width: 800,
  fontSize: 48,
  color: "#FFFFFF",
  textAlign: "center",
};

const wallOfText = (video: string, audio?: string) => ({
  canvas: { width: 1080, height: 1920 },
  video: draw(video),
  ...(audio === undefined ? {} : { audio: { url: audio } }),
  text: TEXT,
});

const post = (body: unknown) =>
  api.request({
    method: "POST",
    path: "/api/v1/content",
    body,
    idempotencyKey: `guard-${randomUUID()}`,
  });

async function contentCount(companyId: string): Promise<number> {
  const rows = await api.handle.sql`
    select count(*)::int as n from contents where company_id = ${companyId}::uuid
  `;
  return (rows[0] as unknown as { n: number }).n;
}

async function readyMedia(
  companyId: string,
  mediaType: "image" | "video",
  url: string,
): Promise<void> {
  await api.handle.sql`
    insert into media (company_id, media_type, filename, r2_url, storage_key,
                       status, size_mb, origin)
    values (${companyId}::uuid, ${mediaType}, 'f', ${url}, ${`k/${randomUUID()}`},
            'ready', 1, 'manual_upload')
  `;
}

async function expectRejected(body: unknown, slots: string[]): Promise<void> {
  const companyId = api.data.a.companyId;
  const before = await contentCount(companyId);
  const res = await post(body);

  expect(api.queue.forQueue(JOB_QUEUES.contentBuild)).toHaveLength(0);
  expect(await contentCount(companyId)).toBe(before);
  expect(res.status).toBe(400);
  const error = errorOf(res);
  expect(error.code).toBe("bad_request");
  expect((res.body?.["error"] as { details?: unknown }).details).toEqual({
    invalidAssets: slots,
  });
}

describe("POST /content · media de la marca (P2-RENDER-009)", () => {
  it("una URL ajena (otro host) → 400 sin encolar ni crear", async () => {
    await expectRejected(wallOfText("https://cdn.example.test/a.mp4"), ["video"]);
  });

  it("una URL bajo el prefijo de OTRA marca → 400", async () => {
    const ajena = await ownedMediaUrl(api.data.b.companyId, "clip.mp4");
    await expectRejected(wallOfText(ajena), ["video"]);
  });

  it("un asset vivo de OTRA marca (fila ready de b) → 400", async () => {
    const url = `https://cdn.example.test/otra/${randomUUID()}.mp4`;
    await readyMedia(api.data.b.companyId, "video", url);
    await expectRejected(wallOfText(url), ["video"]);
  });

  it("audio de la biblioteca de otra marca → 400 con el slot audio", async () => {
    const video = await ownedMediaUrl(api.data.a.companyId, "clip.mp4");
    const audio = await ownedAudioUrl(api.data.b.companyId, "beat.mp3");
    await expectRejected(wallOfText(video, audio), ["audio"]);
  });

  it("audio bajo media/{companyId}/ no es la biblioteca de audio → 400", async () => {
    const video = await ownedMediaUrl(api.data.a.companyId, "clip.mp4");
    const audio = await ownedMediaUrl(api.data.a.companyId, "beat.mp3");
    await expectRejected(wallOfText(video, audio), ["audio"]);
  });

  it("`..` en la URL no escapa del prefijo propio", async () => {
    const propia = await ownedMediaUrl(api.data.a.companyId, "x");
    // La clave canónica del MemoryStorage codifica las barras; se arma el
    // escape con segmentos reales para que el parser los resuelva.
    const escape = new URL(propia);
    escape.pathname = `${escape.pathname}/../../${api.data.b.companyId}/clip.mp4`;
    await expectRejected(wallOfText(escape.toString()), ["video"]);
  });

  it("slideshow: nombra cada slide ajeno", async () => {
    const propia = await ownedMediaUrl(api.data.a.companyId, "s0.jpg");
    const slide = (url: string) => ({
      canvas: { width: 1080, height: 1920, aspectRatio: "9:16" },
      image: draw(url),
      texts: [],
    });
    await expectRejected(
      {
        num_images: 3,
        images: [
          slide(propia),
          slide("https://cdn.example.test/s1.jpg"),
          slide(await ownedMediaUrl(api.data.b.companyId, "s2.jpg")),
        ],
      },
      ["slides[1]", "slides[2]"],
    );
  });

  it("media y audio propios (prefijos de la marca) → 201 y encola", async () => {
    const video = await ownedMediaUrl(api.data.a.companyId, "clip.mp4");
    const audio = await ownedAudioUrl(api.data.a.companyId, "beat.mp3");
    const res = await post(wallOfText(video, audio));
    expect(res.status).toBe(201);
    expect(dataOf(res)["status"]).toBe("BUILDING");
    expect(api.queue.forQueue(JOB_QUEUES.contentBuild)).toHaveLength(1);
  });

  it("un asset vivo propio fuera del prefijo (fila ready de a) → 201", async () => {
    const url = `https://cdn.example.test/legacy/${randomUUID()}.mp4`;
    await readyMedia(api.data.a.companyId, "video", url);
    const res = await post(wallOfText(url));
    expect(res.status).toBe(201);
    expect(api.queue.forQueue(JOB_QUEUES.contentBuild)).toHaveLength(1);
  });

  it("un rechazo no quema la idempotency key", async () => {
    const key = `guard-reuse-${randomUUID()}`;
    const mala = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: wallOfText("https://cdn.example.test/a.mp4"),
      idempotencyKey: key,
    });
    expect(mala.status).toBe(400);
    // Misma key, mismo body: sigue siendo 400 (no un replay cacheado de otra
    // cosa ni un 409 por key en uso).
    const otra = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: wallOfText("https://cdn.example.test/a.mp4"),
      idempotencyKey: key,
    });
    expect(otra.status).toBe(400);
  });
});
