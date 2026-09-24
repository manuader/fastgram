/**
 * `0017_autopilot.sql` — decisiones y corridas del piloto, y
 * `app.autopilot_brands()`.
 *
 * Todo lo que mide aislamiento corre con `SET LOCAL ROLE fastgram_app`: como
 * superusuario RLS no aplica y el archivo daría verde sin medir nada — y la
 * función `SECURITY DEFINER` existe justamente porque con ese rol una
 * consulta directa a `companies` devuelve cero filas.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { autopilotStore, type AutopilotBrandRow } from "../src/repositories/index";
import {
  autopilotDecisions,
  blitzPromptRequests,
  brandStrategies,
  companies,
  suggestions,
} from "../src/schema/index";
import type { Transaction } from "../src/client";
import { APP_ROLE, withCompany, withoutCompany } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: { companyId: string; ownerUserId: string };
let beta: { companyId: string; ownerUserId: string };
let gone: { companyId: string; ownerUserId: string };

const asApp = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  withCompany(ctx.db, companyId, fn, { role: APP_ROLE });

const strategy = {
  networks: [],
  windows: {},
  formatMix: {},
  language: "es",
  jitterMinutes: 7,
  brandGapMinutes: 10,
};

async function suggestion(
  companyId: string,
  createdAt: Date,
  extra: Partial<typeof suggestions.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(suggestions).values({
    id,
    companyId,
    contentType: "wall-of-text",
    generatedText: `copy ${id.slice(0, 4)}`,
    createdAt,
    ...extra,
  });
  return id;
}

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = await seedCompany(ctx.db, { name: "Alpha" });
  beta = await seedCompany(ctx.db, { name: "Beta" });
  gone = await seedCompany(ctx.db, { name: "Gone" });
  await ctx.db
    .update(companies)
    .set({ status: "soft_deleted" })
    .where(eq(companies.id, gone.companyId));
  await ctx.db.insert(brandStrategies).values([
    { companyId: alpha.companyId, ...strategy, autonomy: "autopilot" },
    { companyId: gone.companyId, ...strategy, autonomy: "autopilot" },
  ]);
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("app.autopilot_brands()", () => {
  it("con fastgram_app lista las marcas vivas con dueño y autonomía (NULL sin estrategia)", async () => {
    // La negativa primero (trampa 35): sin la función, el rol no ve ninguna company.
    const direct = await withoutCompany(ctx.db, (tx) => tx.select().from(companies), {
      role: APP_ROLE,
    });
    expect(direct).toHaveLength(0);

    const rows = await withoutCompany(ctx.db, (tx) => autopilotStore.listBrands(tx), {
      role: APP_ROLE,
    });
    const byId = new Map<string, AutopilotBrandRow>(rows.map((r) => [r.companyId, r]));
    expect(byId.get(alpha.companyId)).toEqual({
      companyId: alpha.companyId,
      ownerUserId: alpha.ownerUserId,
      autonomy: "autopilot",
    });
    expect(byId.get(beta.companyId)?.autonomy).toBeNull();
    expect(byId.has(gone.companyId)).toBe(false);
  });
});

describe("candidatos del piloto", () => {
  it("queued, las más viejas primero, sin las de prompt ni las ya juzgadas", async () => {
    const t0 = new Date("2026-09-24T10:00:00Z");
    const later = await suggestion(alpha.companyId, new Date(t0.getTime() + 60_000));
    const oldest = await suggestion(alpha.companyId, t0);
    const decided = await suggestion(alpha.companyId, new Date(t0.getTime() - 60_000));
    await suggestion(alpha.companyId, new Date(t0.getTime() - 120_000), {
      status: "discarded",
    });
    const [request] = await ctx.db
      .insert(blitzPromptRequests)
      .values({ companyId: alpha.companyId, prompt: "tema", count: 1 })
      .returning({ id: blitzPromptRequests.id });
    await suggestion(alpha.companyId, new Date(t0.getTime() - 180_000), {
      promptRequestId: request?.id ?? null,
    });
    await suggestion(beta.companyId, new Date(t0.getTime() - 240_000));

    const first = await asApp(alpha.companyId, (tx) =>
      autopilotStore.recordDecision(
        tx,
        { companyId: alpha.companyId },
        {
          suggestionId: decided,
          decision: "held",
          reason: "judgment_timeout",
          contentId: null,
          details: {},
        },
      ),
    );
    expect(first).toBe(true);

    const rows = await asApp(alpha.companyId, (tx) =>
      autopilotStore.listCandidates(tx, { companyId: alpha.companyId }, { limit: 10 }),
    );
    expect(rows.map((r) => r.id)).toEqual([oldest, later]);
  });

  it("una sugerencia se decide una sola vez (UNIQUE)", async () => {
    const id = await suggestion(alpha.companyId, new Date());
    const record = () =>
      asApp(alpha.companyId, (tx) =>
        autopilotStore.recordDecision(
          tx,
          { companyId: alpha.companyId },
          {
            suggestionId: id,
            decision: "rejected",
            reason: "off_brand",
            contentId: null,
            details: { reasons: ["off_brand"] },
          },
        ),
      );
    expect(await record()).toBe(true);
    expect(await record()).toBe(false);
  });
});

describe("autopilot_decisions y autopilot_runs bajo RLS", () => {
  it("una marca no ve las decisiones ni la corrida de otra", async () => {
    await asApp(alpha.companyId, (tx) =>
      autopilotStore.saveRun(
        tx,
        { companyId: alpha.companyId },
        {
          lastRunAt: new Date(),
          outcome: "ran",
          queueTarget: 12,
          queued: 5,
          approved: 1,
          rejected: 1,
          held: 0,
        },
      ),
    );
    const own = await asApp(alpha.companyId, (tx) =>
      autopilotStore.findRun(tx, { companyId: alpha.companyId }),
    );
    expect(own?.queueTarget).toBe(12);

    const leakedRun = await asApp(beta.companyId, (tx) =>
      tx.execute(sql`select 1 from autopilot_runs`),
    );
    expect(leakedRun).toHaveLength(0);
    const leaked = await asApp(beta.companyId, (tx) =>
      tx.select().from(autopilotDecisions),
    );
    expect(leaked).toHaveLength(0);
    const mine = await asApp(alpha.companyId, (tx) =>
      tx.select().from(autopilotDecisions),
    );
    expect(mine.length).toBeGreaterThan(0);
  });

  it("el digest lee por rango y cuenta lo generado", async () => {
    const from = Date.now() - 3_600_000;
    const to = Date.now() + 3_600_000;
    const rows = await asApp(alpha.companyId, (tx) =>
      autopilotStore.listDecisionsInRange(
        tx,
        { companyId: alpha.companyId },
        { fromMs: from, toMs: to, limit: 50 },
      ),
    );
    expect(rows.some((r) => r.decision.decision === "rejected")).toBe(true);
    expect(rows.every((r) => r.contentType === "wall-of-text")).toBe(true);
    const generated = await asApp(alpha.companyId, (tx) =>
      autopilotStore.countSuggestionsCreatedInRange(
        tx,
        { companyId: alpha.companyId },
        { fromMs: from, toMs: to },
      ),
    );
    expect(generated).toBeGreaterThanOrEqual(1);
  });
});
