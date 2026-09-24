/**
 * `metrics-sync` contra Postgres — `PU-AUTO-004`, `NFR-016`.
 *
 * Con adaptadores **falsos** (nada habla con una plataforma), tokens falsos y
 * una cola que graba. Corre con `SET LOCAL ROLE fastgram_app`, como en
 * producción: el barrido (`app.metrics_sync_brands`) tiene que ver las marcas
 * sin GUC, y cada escritura pasa por RLS.
 */
import { randomUUID } from "node:crypto";

import { FixedClock } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import {
  APP_ROLE,
  blitzPreferences,
  connections,
  contents,
  mixTuningStore,
  posts,
  withCompany,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";
import {
  PortError,
  type ConnectionTokens,
  type EnqueuedJob,
  type JobSpec,
  type MetricsFetchResult,
  type MetricsRequest,
  type Queue,
  type SocialMetrics,
  type SocialMetricsCapabilities,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createMetricsSyncHandler } from "../src/metrics/sync-handler.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const NOW = new Date("2026-09-24T12:07:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const silent: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;
let clock: FixedClock;

class RecordingQueue implements Queue {
  readonly jobs: JobSpec<unknown>[] = [];
  async enqueue<T>(job: JobSpec<T>): Promise<EnqueuedJob> {
    this.jobs.push(job as JobSpec<unknown>);
    return { jobId: randomUUID(), created: true };
  }
  async enqueueMany(jobs: readonly JobSpec<unknown>[]): Promise<readonly EnqueuedJob[]> {
    return Promise.all(jobs.map((j) => this.enqueue(j)));
  }
  async work(): Promise<void> {}
  async getJob(): Promise<null> {
    return null;
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async scheduleRecurring(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

class FakeMetrics implements SocialMetrics {
  readonly calls: MetricsRequest[] = [];
  next: (req: MetricsRequest) => MetricsFetchResult | Error = (req) => ({
    items: req.externalPostIds.map((id) => ({
      externalPostId: id,
      views: 100,
      likes: 7,
    })),
    missing: [],
    unavailable: [],
  });
  constructor(private readonly caps: SocialMetricsCapabilities) {}
  capabilities(): SocialMetricsCapabilities {
    return this.caps;
  }
  async fetch(req: MetricsRequest): Promise<MetricsFetchResult> {
    this.calls.push(req);
    const r = this.next(req);
    if (r instanceof Error) throw r;
    return r;
  }
}

const IG_CAPS: SocialMetricsCapabilities = {
  platform: "instagram",
  metrics: ["views", "likes", "comments", "shares"],
  maxBatch: 100,
  costPerPostReadUsd: 0,
  requiredScopes: [],
};
const X_CAPS: SocialMetricsCapabilities = {
  ...IG_CAPS,
  platform: "x",
  costPerPostReadUsd: 0.005,
};

const tokens: ConnectionTokens = {
  getAccessToken: async () => "tok",
};

async function seedPosted(
  companyId: string,
  over: {
    platform?: "instagram" | "tiktok" | "x";
    postedAgoMs?: number;
    syncedAgoMs?: number | null;
    type?: "slideshow" | "wall-of-text" | "green-screen" | "video-hook";
    views?: number;
    likes?: number;
  } = {},
): Promise<string> {
  return withoutCompany(handle.db, async (tx) => {
    const [content] = await tx
      .insert(contents)
      .values({ companyId, type: over.type ?? "slideshow", status: "CREATED" })
      .returning({ id: contents.id });
    const [conn] = await tx
      .insert(connections)
      .values({
        companyId,
        platform: over.platform ?? "instagram",
        platformUserId: `u-${randomUUID().slice(0, 8)}`,
        platformUsername: "cuenta",
        publishable: true,
      })
      .returning({ id: connections.id });
    if (content === undefined || conn === undefined) throw new Error("seed");
    const synced = over.syncedAgoMs ?? null;
    const [post] = await tx
      .insert(posts)
      .values({
        companyId,
        contentId: content.id,
        platform: over.platform ?? "instagram",
        accountType: "oauth",
        connectionId: conn.id,
        scheduledAtUtc: new Date(NOW.getTime() - (over.postedAgoMs ?? HOUR)),
        status: "POSTED",
        postedAt: new Date(NOW.getTime() - (over.postedAgoMs ?? HOUR)),
        externalPostId: `ext-${randomUUID().slice(0, 8)}`,
        views: over.views ?? 0,
        likes: over.likes ?? 0,
        metricsSyncedAt: synced === null ? null : new Date(NOW.getTime() - synced),
      })
      .returning({ id: posts.id });
    if (post === undefined) throw new Error("seed");
    return post.id;
  });
}

async function readRow(id: string) {
  const r = await withoutCompany(handle.db, (tx) =>
    tx.query.posts.findFirst({ where: (t, { eq }) => eq(t.id, id) }),
  );
  if (r === undefined) throw new Error("no está");
  return r;
}

const ctx = (payload: unknown) => ({
  jobId: randomUUID(),
  payload,
  attempt: 1,
  maxAttempts: 3,
});

beforeAll(() => {
  handle = openDb();
});
afterAll(async () => {
  await handle.close();
});
beforeEach(() => {
  clock = new FixedClock(NOW.getTime());
});

function handler(
  adapters: Record<string, SocialMetrics>,
  extra: { queue?: Queue; tokens?: ConnectionTokens | null } = {},
) {
  return createMetricsSyncHandler({
    db: handle.db,
    clock,
    appRole: APP_ROLE,
    logger: silent,
    adapters,
    tokens: extra.tokens === undefined ? tokens : extra.tokens,
    queue: extra.queue,
  });
}

describe("sync de una marca", () => {
  it("escribe métricas, sello de sync y lo que no vino; TikTok queda pre-sync", async () => {
    const brand = await seedCompany(handle);
    const ig = await seedPosted(brand);
    const tt = await seedPosted(brand, { platform: "tiktok" });
    const fake = new FakeMetrics(IG_CAPS);

    await handler({ instagram: fake })(ctx({ companyId: brand }));

    const r = await readRow(ig);
    expect(r.views).toBe(100);
    expect(r.likes).toBe(7);
    expect(r.metricsSyncedAt?.getTime()).toBe(NOW.getTime());
    expect(r.metricsMissing).toEqual(["comments", "shares"]);
    expect(r.metricsErrorCode).toBeNull();
    expect((await readRow(tt)).metricsSyncedAt).toBeNull();
    expect(fake.calls[0]?.account.accessToken).toBe("tok");
  });

  it("frecuencias: <48 h cada hora, después cada 24 h, X (cobra) cada 24 h siempre", async () => {
    const brand = await seedCompany(handle);
    const fresh = await seedPosted(brand, {
      postedAgoMs: 5 * HOUR,
      syncedAgoMs: 30 * MIN,
    });
    const freshDue = await seedPosted(brand, {
      postedAgoMs: 5 * HOUR,
      syncedAgoMs: 61 * MIN,
    });
    const old = await seedPosted(brand, { postedAgoMs: 3 * DAY, syncedAgoMs: 2 * HOUR });
    const oldDue = await seedPosted(brand, {
      postedAgoMs: 3 * DAY,
      syncedAgoMs: 25 * HOUR,
    });
    const tooOld = await seedPosted(brand, { postedAgoMs: 31 * DAY, syncedAgoMs: null });
    const xFresh = await seedPosted(brand, {
      platform: "x",
      postedAgoMs: 5 * HOUR,
      syncedAgoMs: 2 * HOUR,
    });
    const ig = new FakeMetrics(IG_CAPS);
    const x = new FakeMetrics(X_CAPS);

    await handler({ instagram: ig, x })(ctx({ companyId: brand }));

    const asked = new Set(ig.calls.flatMap((c) => c.externalPostIds));
    const extOf = async (id: string) => (await readRow(id)).externalPostId ?? "";
    expect(asked.has(await extOf(fresh))).toBe(false);
    expect(asked.has(await extOf(freshDue))).toBe(true);
    expect(asked.has(await extOf(old))).toBe(false);
    expect(asked.has(await extOf(oldDue))).toBe(true);
    expect(asked.has(await extOf(tooOld))).toBe(false);
    expect(x.calls).toHaveLength(0);
    expect((await readRow(xFresh)).views).toBe(0);
  });

  it("sin permiso de insights: marca el código y NO borra lo último bueno", async () => {
    const brand = await seedCompany(handle);
    const id = await seedPosted(brand, {
      postedAgoMs: 3 * DAY,
      syncedAgoMs: 25 * HOUR,
      views: 50,
      likes: 5,
    });
    const fake = new FakeMetrics(IG_CAPS);
    fake.next = () => new PortError("forbidden", "no scope", { source: "test" });

    await handler({ instagram: fake })(ctx({ companyId: brand }));

    const r = await readRow(id);
    expect(r.metricsErrorCode).toBe("metrics_permission_missing");
    expect(r.views).toBe(50);
    expect(r.likes).toBe(5);
    expect(r.metricsSyncedAt?.getTime()).toBe(NOW.getTime() - 25 * HOUR);
  });

  it("token vencido → metrics_reconnect_required; transitorio → no escribe nada", async () => {
    const brand = await seedCompany(handle);
    const a = await seedPosted(brand);
    const expired: ConnectionTokens = {
      getAccessToken: async () => {
        throw new PortError("unauthorized", "expired", { source: "test" });
      },
    };
    await handler(
      { instagram: new FakeMetrics(IG_CAPS) },
      { tokens: expired },
    )(ctx({ companyId: brand }));
    expect((await readRow(a)).metricsErrorCode).toBe("metrics_reconnect_required");

    const brand2 = await seedCompany(handle);
    const b = await seedPosted(brand2);
    const flaky = new FakeMetrics(IG_CAPS);
    flaky.next = () => new PortError("rate_limited", "slow", { source: "test" });
    await handler({ instagram: flaky })(ctx({ companyId: brand2 }));
    const rb = await readRow(b);
    expect(rb.metricsErrorCode).toBeNull();
    expect(rb.metricsSyncedAt).toBeNull();
  });

  it("éxito parcial: missing → not_found_on_platform, unavailable → metrics_unavailable", async () => {
    const brand = await seedCompany(handle);
    const ok = await seedPosted(brand);
    const gone = await seedPosted(brand);
    const noData = await seedPosted(brand);
    const [extGone, extNoData] = [
      (await readRow(gone)).externalPostId ?? "",
      (await readRow(noData)).externalPostId ?? "",
    ];
    const fake = new FakeMetrics(IG_CAPS);
    fake.next = (req) => ({
      items: req.externalPostIds
        .filter((e) => e !== extGone && e !== extNoData)
        .map((e) => ({ externalPostId: e, views: 0, likes: 0, comments: 0, shares: 0 })),
      missing: [extGone],
      unavailable: [extNoData],
    });
    await handler({ instagram: fake })(ctx({ companyId: brand }));

    const rOk = await readRow(ok);
    // Un cero real: sincronizado, sin métricas faltantes.
    expect(rOk.metricsSyncedAt).not.toBeNull();
    expect(rOk.metricsMissing).toEqual([]);
    expect((await readRow(gone)).metricsErrorCode).toBe("not_found_on_platform");
    expect((await readRow(noData)).metricsErrorCode).toBe("metrics_unavailable");
  });
});

describe("barrido del cron", () => {
  it("con cola: encola una corrida por marca con clave por hora (sin GUC, como fastgram_app)", async () => {
    const brand = await seedCompany(handle);
    await seedPosted(brand);
    const queue = new RecordingQueue();

    await handler({ instagram: new FakeMetrics(IG_CAPS) }, { queue })(ctx({}));

    const mine = queue.jobs.filter(
      (j) => (j.payload as { companyId?: string }).companyId === brand,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.queue).toBe(JOB_QUEUES.metricsSync);
    expect(mine[0]?.options?.singletonKey).toBe(
      `${JOB_QUEUES.metricsSync}:${brand}:${String(Math.floor(NOW.getTime() / HOUR))}`,
    );
  });
});

describe("auto-tune del mix", () => {
  async function seedMeasured(
    brand: string,
    type: "slideshow" | "wall-of-text" | "green-screen",
    n: number,
    likes: number,
  ): Promise<void> {
    for (let i = 0; i < n; i++) {
      await seedPosted(brand, {
        type,
        postedAgoMs: 5 * DAY + i * HOUR,
        // Sincronizado hace 1 h: no está debido, el sync no lo toca.
        syncedAgoMs: HOUR,
        views: 1000,
        likes,
      });
    }
  }

  it("apagado (sin fila) no toca los pesos", async () => {
    const brand = await seedCompany(handle);
    await seedMeasured(brand, "slideshow", 5, 100);
    await handler({})(ctx({ companyId: brand }));
    const prefs = await withoutCompany(handle.db, (tx) =>
      tx.query.blitzPreferences.findFirst({
        where: (t, { eq }) => eq(t.companyId, brand),
      }),
    );
    expect(prefs).toBeUndefined();
  });

  it("prendido: ajusta acotado, registra de qué a qué, deja 0 en 0 y no repite en la semana", async () => {
    const brand = await seedCompany(handle);
    await withoutCompany(handle.db, (tx) =>
      tx.insert(blitzPreferences).values({
        companyId: brand,
        slideshowWeight: 50,
        wallOfTextWeight: 50,
        greenScreenWeight: 0,
        videoHookWeight: 0,
        remixPercentage: 0,
        ownMediaPercentage: 0,
        mentionBusinessPercentage: 0,
        influencerChance: 50,
      }),
    );
    await withCompany(handle.db, brand, (tx) =>
      mixTuningStore.setEnabled(tx, { companyId: brand }, true),
    );
    await seedMeasured(brand, "slideshow", 5, 200);
    await seedMeasured(brand, "wall-of-text", 5, 20);
    await seedMeasured(brand, "green-screen", 5, 900); // peso 0: no revive

    await handler({})(ctx({ companyId: brand }));

    const prefs = await withoutCompany(handle.db, (tx) =>
      tx.query.blitzPreferences.findFirst({
        where: (t, { eq }) => eq(t.companyId, brand),
      }),
    );
    expect(prefs?.slideshowWeight).toBe(60);
    expect(prefs?.wallOfTextWeight).toBe(40);
    expect(prefs?.greenScreenWeight).toBe(0);
    expect(prefs?.videoHookWeight).toBe(0);

    const log = await withoutCompany(handle.db, (tx) =>
      tx.query.formatMixAdjustments.findMany({
        where: (t, { eq }) => eq(t.companyId, brand),
      }),
    );
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      actor: "autotune",
      fromWeights: {
        slideshow: 50,
        "wall-of-text": 50,
        "green-screen": 0,
        "video-hook": 0,
      },
      toWeights: {
        slideshow: 60,
        "wall-of-text": 40,
        "green-screen": 0,
        "video-hook": 0,
      },
    });

    // Una hora después: no es semana todavía.
    clock = new FixedClock(NOW.getTime() + HOUR);
    await handler({})(ctx({ companyId: brand }));
    const again = await withoutCompany(handle.db, (tx) =>
      tx.query.formatMixAdjustments.findMany({
        where: (t, { eq }) => eq(t.companyId, brand),
      }),
    );
    expect(again).toHaveLength(1);
  });

  it("prendido y sin datos: registra la corrida como insufficient_data, sin cambio", async () => {
    const brand = await seedCompany(handle);
    await withCompany(handle.db, brand, (tx) =>
      mixTuningStore.setEnabled(tx, { companyId: brand }, true),
    );
    await handler({})(ctx({ companyId: brand }));
    const row = await withCompany(handle.db, brand, (tx) =>
      mixTuningStore.find(tx, { companyId: brand }),
    );
    expect(row?.lastOutcome).toBe("insufficient_data");
    expect(row?.lastRunAt?.getTime()).toBe(NOW.getTime());
  });
});
