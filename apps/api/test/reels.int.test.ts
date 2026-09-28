/**
 * Reels (`PU-S9-010`): crear por `POST /content` y por «Create from prompt»,
 * leer y editar el spec por capas con las guardas de `FR-051`, y la preview
 * que sin servicio de render dice por qué no está.
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

async function reelSpec(companyId: string) {
  return {
    version: 1,
    durationSec: 10,
    canvas: { width: 1080, height: 1920 },
    fps: 30,
    theme: {
      background: "#111111",
      primary: "#FFFFFF",
      accent: "#FFE14D",
      text: "#FFFFFF",
    },
    mix: { duckMusic: true, duckLevel: 0.3 },
    layers: [
      {
        id: "bg",
        kind: "background",
        start: 0,
        end: 10,
        z: 0,
        fill: {
          type: "image",
          url: await ownedMediaUrl(companyId, "bg.jpg"),
          motion: "ken-burns",
        },
        transitionIn: { kind: "cut", durationSec: 0.3 },
      },
      {
        id: "clip",
        kind: "clip",
        start: 1,
        end: 8,
        z: 5,
        url: await ownedMediaUrl(companyId, "gs.mp4"),
        chroma: "green",
        fit: "contain",
        rect: { x: 50, y: 68, width: 100, height: 64 },
        mediaStartSec: 0,
        volume: 1,
        loop: false,
      },
      {
        id: "hook",
        kind: "text",
        start: 0.2,
        end: 3,
        z: 10,
        text: "Stop scrolling",
        font: { family: "anton", weight: 400, size: 44 },
        color: "#FFFFFF",
        stroke: { width: 3, color: "#000000" },
        background: null,
        position: { x: 50, y: 13 },
        widthPercent: 90,
        animation: "kinetic-bounce",
        exit: "fade",
      },
      {
        id: "music",
        kind: "audio",
        role: "music",
        start: 0,
        end: 10,
        url: await ownedAudioUrl(companyId, "m.mp3"),
        volume: 0.5,
        mediaStartSec: 0,
        fadeInSec: 0.8,
        fadeOutSec: 1.5,
        loop: true,
      },
    ],
  };
}

const post = (path: string, body: unknown) =>
  api.request({ method: "POST", path, body, idempotencyKey: `reel-${randomUUID()}` });

async function createReel(): Promise<{ id: string; revision: number }> {
  const res = await post("/api/v1/content", {
    reel: await reelSpec(api.data.a.companyId),
  });
  expect(res.status).toBe(201);
  const content = dataOf(res) as unknown as {
    _id: string;
    type: string;
    revision: number;
  };
  expect(content.type).toBe("reel");
  return { id: content._id, revision: content.revision };
}

async function markCreated(id: string): Promise<void> {
  await api.handle.sql`update contents set status = 'CREATED' where id = ${id}::uuid`;
}

describe("POST /content · reel", () => {
  it("crea la pieza `reel` y encola el build", async () => {
    await createReel();
    const jobs = api.queue.forQueue(JOB_QUEUES.contentBuild);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({ contentType: "reel", reason: "create" });
  });

  it("media ajena en una capa → 400 con la capa, sin crear", async () => {
    const spec = await reelSpec(api.data.a.companyId);
    spec.layers[1] = {
      ...spec.layers[1],
      url: "https://evil.test/x.mp4",
    } as (typeof spec.layers)[number];
    const res = await post("/api/v1/content", { reel: spec });
    expect(res.status).toBe(400);
    expect((res.body?.["error"] as { details?: unknown }).details).toEqual({
      invalidAssets: ["reel.layers.clip"],
    });
  });

  it("un spec fuera de los topes → 400 antes de todo", async () => {
    const spec = { ...(await reelSpec(api.data.a.companyId)), durationSec: 90 };
    const res = await post("/api/v1/content", { reel: spec });
    expect(res.status).toBe(400);
  });
});

describe("GET/PUT /content/:id/reel", () => {
  it("devuelve el spec; /editable responde 422 (un reel se edita por capas)", async () => {
    const { id, revision } = await createReel();
    const res = await api.request({ method: "GET", path: `/api/v1/content/${id}/reel` });
    expect(res.status).toBe(200);
    const body = dataOf(res) as unknown as {
      revision: number;
      reel: { layers: unknown[] };
    };
    expect(body.revision).toBe(revision);
    expect(body.reel.layers).toHaveLength(4);
    const editable = await api.request({
      method: "GET",
      path: `/api/v1/content/${id}/editable`,
    });
    expect(editable.status).toBe(422);
  });

  it("otra marca: 404", async () => {
    const { id } = await createReel();
    const res = await api.request({
      method: "GET",
      path: `/api/v1/content/${id}/reel`,
      token: api.data.b.token,
    });
    expect(res.status).toBe(404);
  });

  it("PUT guarda el spec en studioState, sube la revisión y encola el rebuild", async () => {
    const { id, revision } = await createReel();
    await markCreated(id);
    const spec = await reelSpec(api.data.a.companyId);
    const edited = {
      ...spec,
      layers: spec.layers.map((l) =>
        l.kind === "text" ? { ...l, text: "Edited", animation: "pop" } : l,
      ),
    };
    api.queue.reset();
    const res = await api.request({
      method: "PUT",
      path: `/api/v1/content/${id}/reel`,
      body: { revision, reel: edited },
      idempotencyKey: `reel-${randomUUID()}`,
    });
    expect(res.status).toBe(200);
    expect(dataOf(res) as unknown as { status: string; revision: number }).toMatchObject({
      status: "BUILDING",
      revision: revision + 1,
    });
    expect(api.queue.forQueue(JOB_QUEUES.contentRebuild)).toHaveLength(1);
    const rows = await api.handle
      .sql`select studio_state, build_payload from contents where id = ${id}::uuid`;
    const row = rows[0] as unknown as {
      studio_state: { reel: { layers: { id: string; text?: string }[] } };
      build_payload: { reel: { layers: { id: string; text?: string }[] } };
    };
    expect(row.studio_state.reel.layers.find((l) => l.id === "hook")?.text).toBe(
      "Edited",
    );
    // El payload original no se reescribe.
    expect(row.build_payload.reel.layers.find((l) => l.id === "hook")?.text).toBe(
      "Stop scrolling",
    );
    // Y lo que devuelve GET es el editado.
    const again = await api.request({
      method: "GET",
      path: `/api/v1/content/${id}/reel`,
    });
    expect(
      (
        dataOf(again) as unknown as { reel: { layers: { id: string; text?: string }[] } }
      ).reel.layers.find((l) => l.id === "hook")?.text,
    ).toBe("Edited");
  });

  it("PUT con revisión vieja → 409 stale_revision; en BUILDING → 409", async () => {
    const { id, revision } = await createReel();
    const spec = await reelSpec(api.data.a.companyId);
    const building = await api.request({
      method: "PUT",
      path: `/api/v1/content/${id}/reel`,
      body: { revision, reel: spec },
      idempotencyKey: `reel-${randomUUID()}`,
    });
    expect(building.status).toBe(409);
    expect(errorOf(building).code).toBe("unsupported_content_state");
    await markCreated(id);
    const stale = await api.request({
      method: "PUT",
      path: `/api/v1/content/${id}/reel`,
      body: { revision: revision + 5, reel: spec },
      idempotencyKey: `reel-${randomUUID()}`,
    });
    expect(stale.status).toBe(409);
    expect(errorOf(stale).code).toBe("stale_revision");
  });
});

describe("POST /reels/preview", () => {
  it("sin servicio de render configurado → 503 reel_preview_unavailable", async () => {
    const res = await post("/api/v1/reels/preview", {
      reel: await reelSpec(api.data.a.companyId),
    });
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe("reel_preview_unavailable");
  });
});

describe("POST /reels/from-prompt", () => {
  it("arma el reel con la media de la marca y lo encola", async () => {
    const companyId = api.data.a.companyId;
    const clip = await ownedMediaUrl(companyId, `gs-${randomUUID()}.mp4`);
    const bg = await ownedMediaUrl(companyId, `bg-${randomUUID()}.jpg`);
    await api.handle.sql`
      insert into media (company_id, media_type, filename, r2_url, storage_key, status, size_mb, origin, categories, video_duration_sec)
      values (${companyId}::uuid, 'video', 'gs.mp4', ${clip}, ${`k/${randomUUID()}`}, 'ready', 1, 'manual_upload', '{green-screen-video}', 6),
             (${companyId}::uuid, 'image', 'bg.jpg', ${bg}, ${`k/${randomUUID()}`}, 'ready', 1, 'manual_upload', '{green-screen-background}', null)
    `;
    const res = await post("/api/v1/reels/from-prompt", {
      prompt: "Stop scrolling. Coffee rules.",
    });
    expect(res.status).toBe(201);
    const content = dataOf(res) as unknown as {
      _id: string;
      type: string;
      status: string;
    };
    expect(content).toMatchObject({ type: "reel", status: "BUILDING" });
    expect(api.queue.forQueue(JOB_QUEUES.contentBuild)).toHaveLength(1);
    const rows = await api.handle
      .sql`select build_payload from contents where id = ${content._id}::uuid`;
    const payload = (
      rows[0] as unknown as {
        build_payload: { reel: { layers: { kind: string; url?: string }[] } };
      }
    ).build_payload;
    const layerClip = payload.reel.layers.find((l) => l.kind === "clip");
    expect(layerClip?.url).toBe(clip);
  });

  it("un prompt vacío → 400", async () => {
    const res = await post("/api/v1/reels/from-prompt", { prompt: "   " });
    expect(res.status).toBe(400);
  });
});
