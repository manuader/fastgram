/**
 * `0018_metrics_sync.sql` y `repositories/metrics.ts` — `PU-AUTO-004`.
 *
 * Lo que importa probar acá, y por qué:
 *
 * 1. **`metricsStore.syncBrands` corre como `fastgram_app` y SIN GUC** y
 *    devuelve las marcas igual. Es la razón del `SECURITY DEFINER` (mismo
 *    caso que `0009`): sin él, el cron no vería ninguna marca y el sync no
 *    correría nunca, sin un solo error.
 * 2. **El `WHERE companyId` de cada escritura, medido como superusuario**
 *    (trampa 26): con el GUC puesto RLS tapa el agujero y el `WHERE` nunca se
 *    mide. Acá se escribe con el scope de otra marca y sin RLS.
 * 3. `NFR-016`: un post recién escrito deja `metricsSyncedAt` y la lista de
 *    métricas que no vinieron; un error posterior no borra lo último bueno.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withCompany, withoutCompany } from "../src/tenancy";
import { metricsStore, mixTuningStore } from "../src/repositories/index";
import { blitzPreferences, connections, contents, posts } from "../src/schema/index";
import {
  APP_ROLE,
  seedCompany,
  startTestDatabase,
  type TestDatabase,
} from "./helpers/postgres";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const DAY = 86_400_000;

let ctx: TestDatabase;
let alpha: string;
let beta: string;
let gamma: string;

async function seedPost(
  companyId: string,
  over: {
    status?: "POSTED" | "SCHEDULED";
    postedAt?: Date | null;
    externalPostId?: string | null;
    type?: "slideshow" | "wall-of-text";
  } = {},
): Promise<string> {
  const contentId = randomUUID();
  await ctx.db
    .insert(contents)
    .values({ id: contentId, companyId, type: over.type ?? "slideshow" });
  const connectionId = randomUUID();
  await ctx.db.insert(connections).values({
    id: connectionId,
    companyId,
    platform: "instagram",
    platformUserId: `u-${connectionId.slice(0, 6)}`,
    platformUsername: "handle",
  });
  const id = randomUUID();
  await ctx.db.insert(posts).values({
    id,
    companyId,
    contentId,
    platform: "instagram",
    accountType: "oauth",
    connectionId,
    scheduledAtUtc: NOW,
    status: over.status ?? "POSTED",
    postedAt: over.postedAt === undefined ? new Date(NOW.getTime() - DAY) : over.postedAt,
    externalPostId:
      over.externalPostId === undefined ? `ig-${id.slice(0, 6)}` : over.externalPostId,
  });
  return id;
}

const asApp = <T>(companyId: string, fn: Parameters<typeof withCompany<T>>[2]) =>
  withCompany(ctx.db, companyId, fn, { role: APP_ROLE });

async function row(id: string) {
  const [r] = await ctx.db.select().from(posts).where(eq(posts.id, id));
  if (r === undefined) throw new Error("no está el post");
  return r;
}

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db, { name: "Alpha metrics" })).companyId;
  beta = (await seedCompany(ctx.db, { name: "Beta metrics" })).companyId;
  gamma = (await seedCompany(ctx.db, { name: "Gamma metrics" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("metricsStore.syncBrands (SECURITY DEFINER)", () => {
  it("como `fastgram_app` y sin GUC ve las marcas con posts publicados o auto-tune", async () => {
    await seedPost(alpha);
    await seedPost(beta, { postedAt: new Date(NOW.getTime() - 60 * DAY) }); // fuera de la ventana
    await withCompany(ctx.db, gamma, (tx) =>
      mixTuningStore.setEnabled(tx, { companyId: gamma }, true),
    );

    const brands = await withoutCompany(
      ctx.db,
      (tx) => metricsStore.syncBrands(tx, new Date(NOW.getTime() - 30 * DAY)),
      { role: APP_ROLE },
    );
    expect(brands).toContain(alpha);
    expect(brands).toContain(gamma);
    expect(brands).not.toContain(beta);
  });

  it("un post sin id externo o no publicado no pone a la marca en la lista", async () => {
    const lone = (await seedCompany(ctx.db, { name: "Lone" })).companyId;
    await seedPost(lone, { externalPostId: null });
    await seedPost(lone, { status: "SCHEDULED", postedAt: null });
    const brands = await withoutCompany(
      ctx.db,
      (tx) => metricsStore.syncBrands(tx, new Date(NOW.getTime() - 30 * DAY)),
      { role: APP_ROLE },
    );
    expect(brands).not.toContain(lone);
  });
});

describe("metricsStore: sync de un post", () => {
  it("listSyncable trae sólo lo POSTED, OAuth, con id externo y dentro de la ventana", async () => {
    const brand = (await seedCompany(ctx.db)).companyId;
    const ok = await seedPost(brand);
    await seedPost(brand, { externalPostId: null });
    await seedPost(brand, { postedAt: new Date(NOW.getTime() - 40 * DAY) });
    const list = await asApp(brand, (tx) =>
      metricsStore.listSyncable(
        tx,
        { companyId: brand },
        new Date(NOW.getTime() - 30 * DAY),
        100,
      ),
    );
    expect(list.map((p) => p.id)).toEqual([ok]);
  });

  it("NFR-016: escribe métricas, sello de sync y lo que no vino; un error no borra lo bueno", async () => {
    const id = await seedPost(alpha);
    expect((await row(id)).metricsSyncedAt).toBeNull();

    const wrote = await asApp(alpha, (tx) =>
      metricsStore.writeMetrics(tx, { companyId: alpha }, id, {
        values: { views: 0, likes: 3 },
        syncedAt: NOW,
      }),
    );
    expect(wrote).toBe(true);
    let r = await row(id);
    expect(r.metricsSyncedAt?.toISOString()).toBe(NOW.toISOString());
    expect(r.views).toBe(0); // un 0 real: vino de la plataforma
    expect(r.likes).toBe(3);
    expect(r.metricsMissing).toEqual(["comments", "shares"]);

    await asApp(alpha, (tx) =>
      metricsStore.markError(
        tx,
        { companyId: alpha },
        [id],
        "metrics_permission_missing",
      ),
    );
    r = await row(id);
    expect(r.metricsErrorCode).toBe("metrics_permission_missing");
    expect(r.likes).toBe(3);
    expect(r.metricsSyncedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("trampa 26: el WHERE companyId solo, como superusuario, no escribe en otra marca", async () => {
    const id = await seedPost(alpha);
    const wrote = await withoutCompany(ctx.db, (tx) =>
      metricsStore.writeMetrics(tx, { companyId: beta }, id, {
        values: { views: 999 },
        syncedAt: NOW,
      }),
    );
    expect(wrote).toBe(false);
    expect(
      await withoutCompany(ctx.db, (tx) =>
        metricsStore.markError(tx, { companyId: beta }, [id], "x"),
      ),
    ).toBe(0);
    expect((await row(id)).views).toBe(0);
  });

  it("listForAnalytics: rango [from, to) y el tipo del contenido", async () => {
    const brand = (await seedCompany(ctx.db)).companyId;
    const inRange = await seedPost(brand, { type: "wall-of-text" });
    await seedPost(brand, { postedAt: new Date(NOW.getTime() - 20 * DAY) });
    const rows = await asApp(brand, (tx) =>
      metricsStore.listForAnalytics(
        tx,
        { companyId: brand },
        {
          from: new Date(NOW.getTime() - 7 * DAY),
          to: NOW,
          limit: 100,
        },
      ),
    );
    expect(rows.map((r) => [r.id, r.contentType])).toEqual([[inRange, "wall-of-text"]]);
  });
});

describe("mixTuningStore", () => {
  it("sin fila = apagado; prender, registrar corrida y ajuste, y listarlos", async () => {
    const brand = (await seedCompany(ctx.db)).companyId;
    const scope = { companyId: brand };
    expect(await asApp(brand, (tx) => mixTuningStore.find(tx, scope))).toBeNull();

    await asApp(brand, (tx) => mixTuningStore.setEnabled(tx, scope, true));
    await asApp(brand, (tx) =>
      mixTuningStore.recordRun(tx, scope, { at: NOW, outcome: "changed" }),
    );
    await asApp(brand, (tx) =>
      mixTuningStore.recordAdjustment(tx, scope, {
        actor: "autotune",
        from: { slideshow: 25 },
        to: { slideshow: 35 },
        stats: [],
        at: NOW,
      }),
    );
    const found = await asApp(brand, (tx) => mixTuningStore.find(tx, scope));
    expect(found).toMatchObject({ enabled: true, lastOutcome: "changed" });
    const list = await asApp(brand, (tx) =>
      mixTuningStore.listAdjustments(tx, scope, 10),
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.toWeights).toEqual({ slideshow: 35 });

    // Otra marca no ve el ajuste (RLS + WHERE).
    const other = await asApp(alpha, (tx) =>
      mixTuningStore.listAdjustments(tx, { companyId: alpha }, 10),
    );
    expect(other.every((a) => a.companyId === alpha)).toBe(true);
  });

  it("lockWeights lee los cuatro pesos (null sin fila)", async () => {
    const brand = (await seedCompany(ctx.db)).companyId;
    const scope = { companyId: brand };
    expect(await asApp(brand, (tx) => mixTuningStore.lockWeights(tx, scope))).toBeNull();
    await ctx.db.insert(blitzPreferences).values({
      companyId: brand,
      slideshowWeight: 40,
      wallOfTextWeight: 30,
      greenScreenWeight: 20,
      videoHookWeight: 10,
      remixPercentage: 0,
      ownMediaPercentage: 0,
      mentionBusinessPercentage: 0,
      influencerChance: 50,
    });
    expect(await asApp(brand, (tx) => mixTuningStore.lockWeights(tx, scope))).toEqual({
      slideshowWeight: 40,
      wallOfTextWeight: 30,
      greenScreenWeight: 20,
      videoHookWeight: 10,
    });
  });
});
