/**
 * `/analytics` — `P3-ANALYT-001/002`, `PU-AUTO-004`, `NFR-016`.
 *
 * El fixture trae un post de TikTok `SCHEDULED` por marca; cada test lo pone
 * en el estado que mide con SQL directo (ningún endpoint deja un post
 * `POSTED` con métricas: lo hace el worker).
 *
 * En modo personal `a` y `b` son marcas del mismo dueño, así que
 * `brands=all` junta las dos y `X-Fastgram-Workspace` elige la activa.
 */
import { JOB_QUEUES } from "@fastgram/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, startApi, type ApiHarness } from "./helpers/harness.js";

const HEADER = "x-fastgram-workspace";
const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const DAY = 86_400_000;

async function setPosted(
  api: ApiHarness,
  postId: string,
  over: {
    platform?: string;
    postedAgoMs?: number;
    synced?: boolean;
    views?: number;
    likes?: number;
    missing?: string[];
    errorCode?: string | null;
  } = {},
): Promise<void> {
  const postedAt = new Date(NOW - (over.postedAgoMs ?? DAY)).toISOString();
  const syncedAt = over.synced === false ? null : new Date(NOW - 60_000).toISOString();
  await api.handle.sql`
    update posts set
      status = 'POSTED'::post_status,
      platform = ${over.platform ?? "instagram"}::post_platform,
      posted_at = ${postedAt}::timestamptz,
      external_post_id = 'ext-1',
      views = ${over.views ?? 0},
      likes = ${over.likes ?? 0},
      comments = 0,
      shares = 0,
      metrics_missing = ${over.missing ?? []}::text[],
      metrics_synced_at = ${syncedAt}::timestamptz,
      metrics_error_code = ${over.errorCode ?? null}
    where id = ${postId}::uuid
  `;
}

const summary = (api: ApiHarness, query: string, headers?: Record<string, string>) =>
  api.request({
    method: "GET",
    path: `/api/v1/analytics/summary${query}`,
    ...(headers === undefined ? {} : { headers }),
  });

describe("modo personal", () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await startApi({ mode: "personal" });
  }, 180_000);
  afterAll(async () => {
    await api?.close();
  });
  beforeEach(async () => {
    await api.handle.sql`truncate table format_mix_adjustments, content_mix_autotune`;
  });

  it("una marca: totales, desglose por red y por tipo, engagement y último sync", async () => {
    await setPosted(api, api.data.a.postId, {
      views: 100,
      likes: 10,
      missing: ["shares"],
    });
    await setPosted(api, api.data.b.postId, { views: 999 });

    const res = await summary(api, "?days=7");
    expect(res.status, res.raw).toBe(200);
    const body = dataOf(res) as {
      totals: Record<string, unknown>;
      byNetwork: { key: string; posts: number }[];
      byFormat: { key: string }[];
      topPosts: { _id: string; shares: number | null }[];
      lastSyncedAt: number;
      brands: { id: string }[];
    };
    expect(body.brands.map((b) => b.id)).toEqual([api.data.a.companyId]);
    expect(body.totals).toMatchObject({
      posts: 1,
      syncedPosts: 1,
      pendingSync: 0,
      views: 100,
      likes: 10,
      engagementRate: 0.1,
    });
    expect(body.totals["metricCoverage"]).toMatchObject({ shares: 0, views: 1 });
    expect(body.byNetwork).toEqual([
      expect.objectContaining({ key: "instagram", posts: 1 }),
    ]);
    expect(body.byFormat.map((r) => r.key)).toEqual(["slideshow"]);
    // Una métrica que la red no dio viaja como null, no como 0.
    expect(body.topPosts[0]).toMatchObject({ _id: api.data.a.postId, shares: null });
    expect(body.lastSyncedAt).toBe(NOW - 60_000);
  });

  it("NFR-016: un post pre-sync cuenta como pendiente y no como '0 views'", async () => {
    await setPosted(api, api.data.a.postId, { synced: false, views: 0 });
    const body = dataOf(await summary(api, "")) as {
      totals: Record<string, unknown>;
      topPosts: unknown[];
      lastSyncedAt: number | null;
    };
    expect(body.totals).toMatchObject({ posts: 1, syncedPosts: 0, pendingSync: 1 });
    expect(body.totals["engagementRate"]).toBeNull();
    expect(body.topPosts).toEqual([]);
    expect(body.lastSyncedAt).toBeNull();
  });

  it("brands=all junta las marcas del dueño y dice qué red no tiene métricas", async () => {
    await setPosted(api, api.data.a.postId, { views: 100 });
    await setPosted(api, api.data.b.postId, { platform: "tiktok", synced: false });

    const body = dataOf(await summary(api, "?brands=all")) as {
      totals: Record<string, unknown>;
      brands: unknown[];
      unsupportedNetworks: string[];
    };
    expect(body.brands).toHaveLength(2);
    expect(body.totals).toMatchObject({ posts: 2, pendingSync: 1 });
    expect(body.unsupportedNetworks).toEqual(["tiktok"]);
  });

  it("el rango recalcula: un post de hace 10 días entra en 30 y no en 7 (FR-120 criterio 1)", async () => {
    await setPosted(api, api.data.a.postId, { postedAgoMs: 10 * DAY, views: 5 });
    const week = dataOf(await summary(api, "?days=7")) as { totals: { posts: number } };
    const month = dataOf(await summary(api, "?days=30")) as { totals: { posts: number } };
    expect(week.totals.posts).toBe(0);
    expect(month.totals.posts).toBe(1);
  });

  it("problemas de sync, por código", async () => {
    await setPosted(api, api.data.a.postId, { errorCode: "metrics_permission_missing" });
    const body = dataOf(await summary(api, "")) as { syncIssues: unknown[] };
    expect(body.syncIssues).toEqual([{ code: "metrics_permission_missing", count: 1 }]);
  });

  it("days fuera de 1–90 es 400", async () => {
    expect((await summary(api, "?days=91")).status).toBe(400);
    expect((await summary(api, "?days=0")).status).toBe(400);
  });

  it("mix: defaults sin fila, prender el auto-tune y que no se filtre a otra marca", async () => {
    const before = dataOf(
      await api.request({ method: "GET", path: "/api/v1/analytics/mix" }),
    );
    expect(before).toEqual({
      weights: {
        slideshow: 25,
        "wall-of-text": 25,
        "green-screen": 25,
        "video-hook": 25,
      },
      autotune: { enabled: false, lastRunAt: null, lastOutcome: null },
      adjustments: [],
    });

    const put = await api.request({
      method: "PUT",
      path: "/api/v1/analytics/mix/autotune",
      body: { enabled: true },
    });
    expect(put.status, put.raw).toBe(200);
    expect(dataOf(put)).toMatchObject({ enabled: true });

    const mine = dataOf(
      await api.request({ method: "GET", path: "/api/v1/analytics/mix" }),
    );
    expect(mine["autotune"]).toMatchObject({ enabled: true });
    const other = dataOf(
      await api.request({
        method: "GET",
        path: "/api/v1/analytics/mix",
        headers: { [HEADER]: api.data.b.companyId },
      }),
    );
    expect(other["autotune"]).toMatchObject({ enabled: false });
  });

  it("mix: devuelve el historial de ajustes de la marca, el más nuevo primero", async () => {
    await api.handle.sql`
      insert into format_mix_adjustments (company_id, actor, from_weights, to_weights, stats, created_at)
      values (
        ${api.data.a.companyId}::uuid, 'autotune',
        '{"slideshow":25,"wall-of-text":25,"green-screen":25,"video-hook":25}'::jsonb,
        '{"slideshow":35,"wall-of-text":15,"green-screen":25,"video-hook":25}'::jsonb,
        '[{"format":"slideshow","samples":5,"score":1.4}]'::jsonb,
        ${new Date(NOW).toISOString()}::timestamptz
      )
    `;
    const mix = dataOf(
      await api.request({ method: "GET", path: "/api/v1/analytics/mix" }),
    ) as {
      adjustments: { to: Record<string, number>; samples: Record<string, number> }[];
    };
    expect(mix.adjustments).toHaveLength(1);
    expect(mix.adjustments[0]?.to["slideshow"]).toBe(35);
    expect(mix.adjustments[0]?.samples).toEqual({ slideshow: 5 });
  });

  it("sync: encola metrics-sync de la marca activa, una vez por minuto", async () => {
    const first = await api.request({ method: "POST", path: "/api/v1/analytics/sync" });
    expect(first.status, first.raw).toBe(202);
    expect(dataOf(first)).toEqual({ queued: true });
    const second = await api.request({ method: "POST", path: "/api/v1/analytics/sync" });
    expect(dataOf(second)).toEqual({ queued: false });
    const jobs = api.queue.enqueued.filter((j) => j.queue === JOB_QUEUES.metricsSync);
    expect(jobs.map((j) => j.payload)).toContainEqual({
      companyId: api.data.a.companyId,
    });
  });
});

describe("modo standard", () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await startApi();
  }, 180_000);
  afterAll(async () => {
    await api?.close();
  });

  it("brands=all es sólo la marca de la key: b es otro tenant", async () => {
    await setPosted(api, api.data.a.postId, { views: 1 });
    await setPosted(api, api.data.b.postId, { views: 1 });
    const body = dataOf(await summary(api, "?brands=all")) as {
      brands: { id: string }[];
      totals: { posts: number };
    };
    expect(body.brands.map((b) => b.id)).toEqual([api.data.a.companyId]);
    expect(body.totals.posts).toBe(1);
  });

  it("sin cola, pedir un sync es 503", async () => {
    const noQueue = await startApi({ withQueue: false });
    try {
      const res = await noQueue.request({
        method: "POST",
        path: "/api/v1/analytics/sync",
      });
      expect(res.status).toBe(503);
    } finally {
      await noQueue.close();
    }
  });
});
