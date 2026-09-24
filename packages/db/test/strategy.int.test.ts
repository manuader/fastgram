/**
 * `0014_brand_strategy.sql` — estrategia por marca y slots planificados.
 *
 * Como en `rls.int.test.ts`, el aislamiento se afirma en las dos direcciones
 * (lo propio se ve · lo ajeno no) y con `SET LOCAL ROLE fastgram_app`: como
 * superusuario, RLS no aplica y el archivo daría verde sin medir nada.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  brandStrategyRepository,
  calendarLocks,
  plannedSlotRepository,
  postCalendar,
} from "../src/repositories/index";
import {
  brandStrategies,
  connections,
  contents,
  plannedSlots,
  posts,
} from "../src/schema/index";
import type { Transaction } from "../src/client";
import { APP_ROLE, withCompany } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: { companyId: string; ownerUserId: string };
let beta: { companyId: string; ownerUserId: string };
let alphaContent: string;
let betaContent: string;
let alphaConnection: string;

const asApp = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  withCompany(ctx.db, companyId, fn, { role: APP_ROLE });

const strategyValues = {
  networks: [{ network: "instagram", enabled: true, perDay: 1, dailyCap: 3 }],
  windows: { mon: ["09:00"] },
  formatMix: {},
  language: "es",
  autonomy: "manual" as const,
  jitterMinutes: 7,
  brandGapMinutes: 10,
};

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = await seedCompany(ctx.db, { name: "Alpha" });
  beta = await seedCompany(ctx.db, { name: "Beta" });

  alphaContent = randomUUID();
  betaContent = randomUUID();
  alphaConnection = randomUUID();
  await ctx.db.insert(contents).values([
    {
      id: alphaContent,
      companyId: alpha.companyId,
      type: "slideshow",
      status: "CREATED",
    },
    { id: betaContent, companyId: beta.companyId, type: "slideshow", status: "CREATED" },
  ]);
  await ctx.db.insert(connections).values({
    id: alphaConnection,
    companyId: alpha.companyId,
    platform: "tiktok",
    platformUserId: "tt-alpha",
    platformUsername: "alpha",
  });
  // Sembrado como superusuario (provisión), no como la aplicación.
  await ctx.db.insert(brandStrategies).values([
    { companyId: alpha.companyId, ...strategyValues },
    { companyId: beta.companyId, ...strategyValues, language: "en" },
  ]);
  await ctx.db.insert(plannedSlots).values([
    {
      companyId: alpha.companyId,
      contentId: alphaContent,
      network: "x",
      scheduledAtUtc: new Date("2026-10-01T12:00:00Z"),
    },
    {
      companyId: beta.companyId,
      contentId: betaContent,
      network: "x",
      scheduledAtUtc: new Date("2026-10-01T12:00:00Z"),
    },
  ]);
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("brand_strategies bajo RLS", () => {
  it("con scope propio se ve la propia (se rompe si se borra la política)", async () => {
    const rows = await asApp(alpha.companyId, (tx) => tx.select().from(brandStrategies));
    expect(rows.map((r) => r.companyId)).toEqual([alpha.companyId]);
  });

  it("no se ve la ajena ni se puede escribir en su nombre (se rompe si se desactiva RLS)", async () => {
    const ajena = await asApp(alpha.companyId, (tx) =>
      tx
        .select()
        .from(brandStrategies)
        .where(sql`${brandStrategies.companyId} = ${beta.companyId}`),
    );
    expect(ajena).toEqual([]);

    await expect(
      asApp(alpha.companyId, (tx) =>
        tx.insert(brandStrategies).values({
          companyId: randomUUID(),
          ...strategyValues,
        }),
      ),
    ).rejects.toThrow();
  });

  it("el repositorio guarda y relee, y la zona sale de companies", async () => {
    const saved = await asApp(alpha.companyId, (tx) =>
      brandStrategyRepository.save(tx, alpha, {
        ...strategyValues,
        autonomy: "autopilot",
      }),
    );
    expect(saved.autonomy).toBe("autopilot");
    const again = await asApp(alpha.companyId, (tx) =>
      brandStrategyRepository.find(tx, alpha),
    );
    expect(again?.autonomy).toBe("autopilot");

    await asApp(alpha.companyId, (tx) =>
      brandStrategyRepository.setTimezone(tx, alpha, "America/Argentina/Buenos_Aires"),
    );
    const tz = await asApp(alpha.companyId, (tx) =>
      brandStrategyRepository.timezone(tx, alpha),
    );
    expect(tz).toBe("America/Argentina/Buenos_Aires");
    // La de la otra marca, intacta.
    const betaTz = await asApp(beta.companyId, (tx) =>
      brandStrategyRepository.timezone(tx, beta),
    );
    expect(betaTz).toBe("UTC");
  });

  it("los CHECK de rango sostienen el contrato", async () => {
    await expect(
      asApp(alpha.companyId, (tx) =>
        brandStrategyRepository.save(tx, alpha, { ...strategyValues, jitterMinutes: 61 }),
      ),
    ).rejects.toThrow();
  });
});

describe("planned_slots bajo RLS", () => {
  it("lo propio se ve y lo ajeno no", async () => {
    const rows = await asApp(alpha.companyId, (tx) => tx.select().from(plannedSlots));
    expect(rows.map((r) => r.companyId)).toEqual([alpha.companyId]);
  });

  it("listInRange trae los planificados en [from, to)", async () => {
    const from = Date.parse("2026-10-01T00:00:00Z");
    const inRange = await asApp(alpha.companyId, (tx) =>
      plannedSlotRepository.listInRange(tx, alpha, {
        fromMs: from,
        toMs: from + 86_400_000,
        limit: 10,
      }),
    );
    expect(inRange).toHaveLength(1);
    const edge = await asApp(alpha.companyId, (tx) =>
      plannedSlotRepository.listInRange(tx, alpha, {
        fromMs: from,
        toMs: Date.parse("2026-10-01T12:00:00Z"),
        limit: 10,
      }),
    );
    expect(edge).toHaveLength(0);
  });

  it("una pieza no se planifica dos veces en la misma red", async () => {
    await expect(
      asApp(alpha.companyId, (tx) =>
        plannedSlotRepository.create(tx, alpha, {
          contentId: alphaContent,
          network: "x",
          scheduledAtUtc: new Date("2026-10-02T12:00:00Z"),
        }),
      ),
    ).rejects.toThrow();
  });

  it("markConverted cierra el slot una sola vez, y no el de otra marca", async () => {
    const slot = await asApp(alpha.companyId, (tx) =>
      plannedSlotRepository.create(tx, alpha, {
        contentId: alphaContent,
        network: "tiktok",
        scheduledAtUtc: new Date("2026-10-03T12:00:00Z"),
      }),
    );
    const postId = randomUUID();
    await ctx.db.insert(posts).values({
      id: postId,
      companyId: alpha.companyId,
      contentId: alphaContent,
      platform: "tiktok",
      accountType: "oauth",
      connectionId: alphaConnection,
      scheduledAtUtc: new Date("2026-10-03T12:00:00Z"),
    });

    const fromBeta = await asApp(beta.companyId, (tx) =>
      plannedSlotRepository.markConverted(tx, beta, slot.id, postId),
    );
    expect(fromBeta).toBeNull();

    const first = await asApp(alpha.companyId, (tx) =>
      plannedSlotRepository.markConverted(tx, alpha, slot.id, postId),
    );
    expect(first?.status).toBe("converted");
    const second = await asApp(alpha.companyId, (tx) =>
      plannedSlotRepository.markConverted(tx, alpha, slot.id, postId),
    );
    expect(second).toBeNull();
  });
});

describe("postCalendar.listInRange", () => {
  it("usa la fecha efectiva: posted_at si salió, scheduled_at_utc si no", async () => {
    const ids = [randomUUID(), randomUUID()];
    await ctx.db.insert(posts).values([
      {
        id: ids[0],
        companyId: alpha.companyId,
        contentId: alphaContent,
        platform: "tiktok",
        accountType: "oauth",
        connectionId: alphaConnection,
        // Programado el 10, salió el 12 (carril lento).
        scheduledAtUtc: new Date("2026-11-10T12:00:00Z"),
        postedAt: new Date("2026-11-12T12:00:00Z"),
        status: "POSTED",
      },
      {
        id: ids[1],
        companyId: alpha.companyId,
        contentId: alphaContent,
        platform: "tiktok",
        accountType: "oauth",
        connectionId: alphaConnection,
        scheduledAtUtc: new Date("2026-11-11T12:00:00Z"),
      },
    ]);
    const day = (d: number) => Date.parse(`2026-11-${String(d)}T00:00:00Z`);

    const tenth = await asApp(alpha.companyId, (tx) =>
      postCalendar.listInRange(tx, alpha, { fromMs: day(10), toMs: day(11), limit: 10 }),
    );
    expect(tenth).toEqual([]);

    const all = await asApp(alpha.companyId, (tx) =>
      postCalendar.listInRange(tx, alpha, { fromMs: day(10), toMs: day(13), limit: 10 }),
    );
    expect(all.map((p) => p.id)).toEqual([ids[1], ids[0]]);

    const afterFirst = await asApp(alpha.companyId, (tx) =>
      postCalendar.listInRange(tx, alpha, {
        fromMs: day(10),
        toMs: day(13),
        limit: 10,
        after: { atMs: Date.parse("2026-11-11T12:00:00Z"), id: ids[1] ?? "" },
      }),
    );
    expect(afterFirst.map((p) => p.id)).toEqual([ids[0]]);

    const fromBeta = await asApp(beta.companyId, (tx) =>
      postCalendar.listInRange(tx, alpha, { fromMs: day(10), toMs: day(13), limit: 10 }),
    );
    // Con el scope de beta en la transacción, RLS esconde las de alpha aunque
    // el filtro de la consulta diga alpha.
    expect(fromBeta).toEqual([]);
  });
});

describe("calendarLocks", () => {
  it("el lock por dueño se toma con el rol de la aplicación", async () => {
    await expect(
      asApp(alpha.companyId, (tx) => calendarLocks.lockOwner(tx, alpha.ownerUserId)),
    ).resolves.toBeUndefined();
  });
});
