/**
 * Sprint 7, segunda tanda (H), contra Postgres:
 *
 * - `GET /brand/sources` publica `analysisPhase` sólo mientras analiza (`0031`).
 * - `GET /brand/post-analysis-offer` / `POST …/dismiss` (`P1-ONB-007`):
 *   nunca antes de un análisis terminado; descartada, no vuelve.
 * - `POST /audio/library/extract` y `GET /audio/library/extractions/:id`:
 *   encola con el estado en el storage de la marca; ajeno → 404.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AUDIO_EXTRACT_MAX_SECONDS as CONTRACT_MAX } from "@fastgram/contracts";
import { AUDIO_EXTRACT_MAX_SECONDS, JOB_QUEUES } from "@fastgram/core";
import { brandSources, companyProfiles, media, withCompany } from "@fastgram/db";

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

async function addSource(
  companyId: string,
  values: Partial<typeof brandSources.$inferInsert> = {},
): Promise<string> {
  return withCompany(api.handle.db, companyId, async (tx) => {
    const [row] = await tx
      .insert(brandSources)
      .values({
        companyId,
        sourceType: "instagram",
        handle: `flow_${randomUUID().slice(0, 8)}`,
        canonicalUrl: `https://www.instagram.com/flow_${randomUUID().slice(0, 8)}`,
        acquisitionTier: "B_public_api",
        status: "analyzing",
        isPrimary: false,
        ...values,
      })
      .returning({ id: brandSources.id });
    if (row === undefined) throw new Error("no se creó la fuente");
    return row.id;
  });
}

async function addVideo(companyId: string, videoDurationSec: number | null = 30) {
  return withCompany(api.handle.db, companyId, async (tx) => {
    const [row] = await tx
      .insert(media)
      .values({
        companyId,
        mediaType: "video",
        filename: "clip.mp4",
        r2Url: "https://cdn.example.test/clip.mp4",
        storageKey: `media/${companyId}/${randomUUID()}.mp4`,
        sizeMb: 1,
        status: "ready",
        videoDurationSec,
        origin: "manual_upload",
      })
      .returning({ id: media.mediaId });
    if (row === undefined) throw new Error("no se creó el video");
    return row.id;
  });
}

describe("P1-ONB-005 · analysisPhase en la fuente", () => {
  it("sale mientras analiza y no fuera de `analyzing`", async () => {
    const a = api.data.a.companyId;
    const analyzing = await addSource(a, { analysisPhase: "synthesizing" });
    const res = await api.request({ method: "GET", path: "/api/v1/brand/sources" });
    expect(res.status).toBe(200);
    const list = (res.body?.["data"] ?? []) as {
      _id: string;
      analysisPhase?: string | null;
    }[];
    expect(list.find((s) => s._id === analyzing)?.analysisPhase).toBe("synthesizing");

    // Una fase vieja en una fuente que ya terminó no se publica.
    await api.handle
      .sql`update brand_sources set status = 'ready' where id = ${analyzing}::uuid`;
    const after = await api.request({ method: "GET", path: "/api/v1/brand/sources" });
    const again = (after.body?.["data"] ?? []) as {
      _id: string;
      analysisPhase?: string | null;
    }[];
    expect(again.find((s) => s._id === analyzing)?.analysisPhase).toBeNull();
  });
});

describe("P1-ONB-007 · oferta post-análisis", () => {
  it("antes del análisis no se ofrece; después sí; descartada, no vuelve (y no toca a otra marca)", async () => {
    const b = api.data.b.companyId;
    await withCompany(api.handle.db, b, (tx) =>
      tx.insert(companyProfiles).values({ companyId: b }).onConflictDoNothing(),
    );
    const id = await addSource(b, { status: "analyzing" });
    const get = () =>
      api.request({
        method: "GET",
        path: "/api/v1/brand/post-analysis-offer",
        token: api.data.b.token,
      });

    const before = await get();
    expect(before.status).toBe(200);
    expect(dataOf(before)).toEqual({ show: false, dismissed: false, source: null });

    await api.handle.sql`
      update brand_sources set status = 'ready', last_analysed_at = now() where id = ${id}::uuid`;
    const ready = dataOf(await get()) as {
      show: boolean;
      source: { sourceType: string };
    };
    expect(ready.show).toBe(true);
    expect(ready.source.sourceType).toBe("instagram");

    const dismiss = await api.request({
      method: "POST",
      path: "/api/v1/brand/post-analysis-offer/dismiss",
      token: api.data.b.token,
    });
    expect(dismiss.status).toBe(204);
    expect(dataOf(await get())).toMatchObject({ show: false, dismissed: true });

    // Idempotente.
    const twice = await api.request({
      method: "POST",
      path: "/api/v1/brand/post-analysis-offer/dismiss",
      token: api.data.b.token,
    });
    expect(twice.status).toBe(204);

    // La marca `a` no heredó el descarte.
    const other = await api.request({
      method: "GET",
      path: "/api/v1/brand/post-analysis-offer",
    });
    expect(dataOf(other)).toMatchObject({ dismissed: false });
  });
});

describe("audio-extract · POST /audio/library/extract", () => {
  it("el tope de duración es el mismo en contracts y en core", () => {
    expect(CONTRACT_MAX).toBe(AUDIO_EXTRACT_MAX_SECONDS);
  });

  it("encola con el id de la extracción y el estado queda consultable", async () => {
    const a = api.data.a.companyId;
    const mediaId = await addVideo(a);
    const res = await api.request({
      method: "POST",
      path: "/api/v1/audio/library/extract",
      body: { mediaId, title: "Mi pista" },
    });
    expect(res.status).toBe(202);
    const created = dataOf(res) as { id: string; state: string; mediaId: string };
    expect(created).toMatchObject({ state: "queued", mediaId });

    const jobs = api.queue.forQueue(JOB_QUEUES.audioExtract);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      companyId: a,
      extractionId: created.id,
      mediaId,
      title: "Mi pista",
    });

    const status = await api.request({
      method: "GET",
      path: `/api/v1/audio/library/extractions/${created.id}`,
    });
    expect(status.status).toBe(200);
    expect(dataOf(status)).toMatchObject({ id: created.id, state: "queued" });

    // La misma extracción pedida desde otra marca: 404, igual que un id inventado.
    const foreign = await api.request({
      method: "GET",
      path: `/api/v1/audio/library/extractions/${created.id}`,
      token: api.data.b.token,
    });
    expect(foreign.status).toBe(404);
    const junk = await api.request({
      method: "GET",
      path: "/api/v1/audio/library/extractions/..%2F..%2Fsecreto",
    });
    expect(junk.status).toBe(404);
  });

  it("video ajeno → 404; imagen o video largo → 400; nada se encola", async () => {
    const foreign = await addVideo(api.data.b.companyId);
    const r1 = await api.request({
      method: "POST",
      path: "/api/v1/audio/library/extract",
      body: { mediaId: foreign },
    });
    expect(r1.status).toBe(404);

    const long = await addVideo(api.data.a.companyId, AUDIO_EXTRACT_MAX_SECONDS + 60);
    const r2 = await api.request({
      method: "POST",
      path: "/api/v1/audio/library/extract",
      body: { mediaId: long },
    });
    expect(r2.status).toBe(400);
    expect(errorOf(r2).details).toMatchObject({ reason: "too_long" });

    const image = await withCompany(api.handle.db, api.data.a.companyId, async (tx) => {
      const [row] = await tx
        .insert(media)
        .values({
          companyId: api.data.a.companyId,
          mediaType: "image",
          filename: "foto.jpg",
          r2Url: "https://cdn.example.test/foto.jpg",
          storageKey: `media/${api.data.a.companyId}/${randomUUID()}.jpg`,
          sizeMb: 1,
          status: "ready",
          origin: "manual_upload",
        })
        .returning({ id: media.mediaId });
      return row?.id ?? "";
    });
    const r3 = await api.request({
      method: "POST",
      path: "/api/v1/audio/library/extract",
      body: { mediaId: image },
    });
    expect(r3.status).toBe(400);
    expect(errorOf(r3).details).toMatchObject({ reason: "not_a_video" });

    expect(api.queue.forQueue(JOB_QUEUES.audioExtract)).toHaveLength(0);
  });
});
