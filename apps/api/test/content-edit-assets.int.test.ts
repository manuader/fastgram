/**
 * Swap de media en `PATCH /content/:id` y `assets` en
 * `GET /content/:id/editable` — `PU-EDIT-003` (FR-051 `ASSETS`, FR-052,
 * FR-053, FR-071).
 *
 * Lo que fija:
 *  - el editor ve la media vigente, con los swaps aplicados;
 *  - `buildPayload` no se toca: los swaps viven en `studioState`;
 *  - una URL nueva fuera del Media Bank del workspace es `400` **sin aplicar
 *    nada** (ni cajas, ni revisión, ni job);
 *  - la media de **otro** workspace cuenta como ajena;
 *  - un slot que el formato no tiene es `400`.
 */
import { randomUUID } from "node:crypto";
import { JOB_QUEUES } from "@fastgram/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

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

const BOX = {
  id: "slide-0-text-0",
  slideIndex: 0,
  text: "Texto",
  position: { x: 50, y: 50 },
  widthPercent: 80,
  font: { family: "inter", weight: 700, size: 18 },
  color: "#FFFFFF",
  stroke: { width: 3, color: "#000000" },
  background: null,
} as const;

const draw = (url: string) => ({ url, drawX: 0, drawY: 0, drawW: 1080, drawH: 1920 });
const TEXT = {
  content: "Texto",
  x: 540,
  y: 960,
  width: 864,
  fontSize: 18,
  color: "#FFFFFF",
  textAlign: "center",
};

async function pieza(
  companyId: string,
  type: "green-screen" | "wall-of-text",
  payload: unknown,
): Promise<string> {
  const contentId = randomUUID();
  await api.handle.sql`
    insert into contents (id, company_id, type, status, revision, files, build_payload)
    values (${contentId}::uuid, ${companyId}::uuid, ${type}, 'CREATED', 1,
            ${["https://cdn.example.test/prev.mp4"]}::text[],
            ${JSON.stringify(payload)}::jsonb)
  `;
  await api.handle.sql`
    insert into content_text_boxes
      (id, content_id, company_id, slide_index, text, position, width_percent,
       font, color, stroke, background)
    values (${BOX.id}, ${contentId}::uuid, ${companyId}::uuid, 0, ${BOX.text},
            ${JSON.stringify(BOX.position)}::jsonb, ${BOX.widthPercent},
            ${JSON.stringify(BOX.font)}::jsonb, ${BOX.color},
            ${JSON.stringify(BOX.stroke)}::jsonb, null)
  `;
  return contentId;
}

async function media(
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

const greenScreen = () => ({
  canvas: { width: 1080, height: 1920 },
  image: draw("https://cdn.example.test/bg.jpg"),
  video: draw("https://cdn.example.test/meme.mp4"),
  text: TEXT,
});

const patch = (contentId: string, body: Record<string, unknown>) =>
  api.request({
    method: "PATCH",
    path: `/api/v1/content/${contentId}`,
    body: { revision: 1, textBoxes: [BOX], ...body },
    idempotencyKey: `assets-${randomUUID()}`,
  });

const editable = async (contentId: string) =>
  dataOf(
    await api.request({ method: "GET", path: `/api/v1/content/${contentId}/editable` }),
  );

async function estado(contentId: string) {
  const filas = await api.handle.sql`
    select revision, status, build_payload, studio_state
    from contents where id = ${contentId}::uuid
  `;
  return filas[0] as unknown as {
    revision: number;
    status: string;
    build_payload: { video: { url: string } };
    studio_state: unknown;
  };
}

describe("GET /content/:id/editable devuelve la media vigente", () => {
  it("sin swaps: la del payload", async () => {
    const id = await pieza(api.data.a.companyId, "green-screen", greenScreen());
    const data = await editable(id);
    expect(data["assets"]).toEqual({
      image: draw("https://cdn.example.test/bg.jpg"),
      video: draw("https://cdn.example.test/meme.mp4"),
    });
  });

  it("wall-of-text sin pista: audio null", async () => {
    const id = await pieza(api.data.a.companyId, "wall-of-text", {
      canvas: { width: 1080, height: 1920 },
      video: draw("https://cdn.example.test/v.mp4"),
      text: TEXT,
    });
    const data = await editable(id);
    expect((data["assets"] as Record<string, unknown>)["audio"]).toBeNull();
  });
});

describe("PATCH con assets", () => {
  it("Swap Video del Media Bank: 200, studioState guardado, buildPayload intacto", async () => {
    const companyId = api.data.a.companyId;
    const nuevo = `https://cdn.example.test/media/${randomUUID()}.mp4`;
    await media(companyId, "video", nuevo);
    const id = await pieza(companyId, "green-screen", greenScreen());

    const res = await patch(id, { assets: { video: { url: nuevo } } });

    expect(res.status).toBe(200);
    const fila = await estado(id);
    expect(fila.revision).toBe(2);
    expect(fila.build_payload.video.url).toBe("https://cdn.example.test/meme.mp4");
    expect(fila.studio_state).toMatchObject({ assets: { video: { url: nuevo } } });
    expect(api.queue.forQueue(JOB_QUEUES.contentRebuild)).toHaveLength(1);

    // El editor ya ve el nuevo (la pieza está en BUILDING, pero `editable` no
    // mira el estado).
    const data = await editable(id);
    expect((data["assets"] as { video: { url: string } }).video.url).toBe(nuevo);
  });

  it("zoom del meme: sólo draw*, no pasa por el Media Bank", async () => {
    const id = await pieza(api.data.a.companyId, "green-screen", greenScreen());
    const res = await patch(id, {
      assets: { video: { drawX: -270, drawY: -480, drawW: 1620, drawH: 2880 } },
    });
    expect(res.status).toBe(200);
    const data = await editable(id);
    expect((data["assets"] as { video: unknown }).video).toEqual({
      url: "https://cdn.example.test/meme.mp4",
      drawX: -270,
      drawY: -480,
      drawW: 1620,
      drawH: 2880,
    });
  });

  it("URL fuera del Media Bank: 400 y no se aplica NADA", async () => {
    const id = await pieza(api.data.a.companyId, "green-screen", greenScreen());
    const res = await patch(id, {
      textBoxes: [{ ...BOX, text: "no debería quedar" }],
      assets: { video: { url: "https://evil.example.test/x.mp4" } },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatchObject({
      code: "bad_request",
      details: { invalidAssets: ["video"] },
    });
    const fila = await estado(id);
    expect(fila.revision).toBe(1);
    expect(fila.status).toBe("CREATED");
    expect(fila.studio_state).toBeNull();
    const cajas = await api.handle.sql`
      select text from content_text_boxes where content_id = ${id}::uuid
    `;
    expect((cajas[0] as unknown as { text: string }).text).toBe("Texto");
    expect(api.queue.forQueue(JOB_QUEUES.contentRebuild)).toHaveLength(0);
  });

  it("media de OTRO workspace cuenta como ajena", async () => {
    const ajena = `https://cdn.example.test/media/${randomUUID()}.mp4`;
    await media(api.data.b.companyId, "video", ajena);
    const id = await pieza(api.data.a.companyId, "green-screen", greenScreen());
    const res = await patch(id, { assets: { video: { url: ajena } } });
    expect(res.status).toBe(400);
  });

  it("una imagen no sirve de video", async () => {
    const img = `https://cdn.example.test/media/${randomUUID()}.jpg`;
    await media(api.data.a.companyId, "image", img);
    const id = await pieza(api.data.a.companyId, "green-screen", greenScreen());
    expect((await patch(id, { assets: { video: { url: img } } })).status).toBe(400);
    expect((await patch(id, { assets: { image: { url: img } } })).status).toBe(200);
  });

  it("slot que el formato no tiene: 400", async () => {
    const id = await pieza(api.data.a.companyId, "green-screen", greenScreen());
    const res = await patch(id, { assets: { audio: null } });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({ reason: "asset_slot_not_in_format" });
  });

  it("No audio en un wall-of-text: 200 y editable dice null", async () => {
    const id = await pieza(api.data.a.companyId, "wall-of-text", {
      canvas: { width: 1080, height: 1920 },
      video: draw("https://cdn.example.test/v.mp4"),
      audio: { url: "https://cdn.example.test/a.mp3" },
      text: TEXT,
    });
    expect((await patch(id, { assets: { audio: null } })).status).toBe(200);
    const data = await editable(id);
    expect((data["assets"] as Record<string, unknown>)["audio"]).toBeNull();
  });

  it("audio que no está en el catálogo: 400", async () => {
    const id = await pieza(api.data.a.companyId, "wall-of-text", {
      canvas: { width: 1080, height: 1920 },
      video: draw("https://cdn.example.test/v.mp4"),
      text: TEXT,
    });
    const res = await patch(id, {
      assets: { audio: { url: "https://cdn.example.test/random.mp3" } },
    });
    expect(res.status).toBe(400);
  });

  it("revisión vieja con assets: 409 stale_revision antes de mirar la media", async () => {
    const id = await pieza(api.data.a.companyId, "green-screen", greenScreen());
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/content/${id}`,
      body: {
        revision: 7,
        textBoxes: [BOX],
        assets: { video: { url: "https://evil.example.test/x.mp4" } },
      },
      idempotencyKey: `assets-${randomUUID()}`,
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("stale_revision");
  });
});
