/**
 * `GET /autopilot/digest` y `GET /autopilot/policy` — `PU-AUTO-003`. Contra
 * Postgres real, modo personal (marcas `a` y `b` del mismo dueño) y reloj del
 * arnés en el lunes 2026-09-21 12:00Z.
 *
 * Las decisiones se siembran como las escribe el worker (`autopilot_decisions`
 * con `details`), para medir la lectura y el scope sin depender del piloto.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRECHECK_THRESHOLDS } from "@fastgram/core";
import {
  autopilotDecisions,
  autopilotRuns,
  brandStrategies,
  posts,
  suggestions,
  withoutCompany,
} from "@fastgram/db";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const HEADER = "x-fastgram-workspace";
const TODAY = new Date("2026-09-21T10:00:00.000Z");

let api: ApiHarness;

async function suggestion(companyId: string, text: string, at = TODAY): Promise<string> {
  const id = randomUUID();
  await withoutCompany(api.handle.db, (tx) =>
    tx.insert(suggestions).values({
      id,
      companyId,
      contentType: "wall-of-text",
      generatedText: text,
      status: "popped",
      createdAt: at,
    }),
  );
  return id;
}

beforeAll(async () => {
  api = await startApi({ mode: "personal" });
  const { a } = api.data;
  const approvedId = await suggestion(a.companyId, "Tostamos cada lunes");
  const rejectedId = await suggestion(a.companyId, "Mejor que Starbucks");
  const heldId = await suggestion(a.companyId, "En espera");
  // De ayer: no entra en el día.
  await suggestion(a.companyId, "Vieja", new Date("2026-09-20T10:00:00.000Z"));
  const at = Date.parse("2026-09-22T09:00:00.000Z");

  await withoutCompany(api.handle.db, async (tx) => {
    await tx.insert(brandStrategies).values({
      companyId: a.companyId,
      networks: [{ network: "instagram", enabled: true, perDay: 1, dailyCap: 3 }],
      windows: {},
      formatMix: {},
      language: "es",
      autonomy: "autopilot",
      jitterMinutes: 0,
      brandGapMinutes: 10,
    });
    await tx.insert(autopilotDecisions).values([
      {
        companyId: a.companyId,
        suggestionId: approvedId,
        decision: "approved",
        contentId: a.contentId,
        details: {
          excerpt: "Tostamos cada lunes",
          reasons: [],
          scheduled: [{ network: "instagram", atMs: at }],
        },
        createdAt: TODAY,
      },
      {
        companyId: a.companyId,
        suggestionId: rejectedId,
        decision: "rejected",
        reason: "third_party_brand",
        details: {
          excerpt: "Mejor que Starbucks",
          reasons: ["third_party_brand", "off_brand", "not_a_reason"],
        },
        createdAt: TODAY,
      },
      {
        companyId: a.companyId,
        suggestionId: heldId,
        decision: "held",
        reason: "judgment_timeout",
        details: { excerpt: "En espera", reasons: ["judgment_timeout"] },
        createdAt: TODAY,
      },
    ]);
    await tx.insert(autopilotRuns).values({
      companyId: a.companyId,
      lastRunAt: TODAY,
      outcome: "ran",
      queueTarget: 5,
      queued: 4,
      approved: 1,
      rejected: 1,
      held: 1,
    });
    await tx.insert(posts).values([
      {
        companyId: a.companyId,
        contentId: a.contentId,
        platform: "tiktok",
        accountType: "oauth",
        connectionId: a.connectionId,
        scheduledAtUtc: new Date("2026-09-21T08:00:00.000Z"),
        postedAt: new Date("2026-09-21T08:01:00.000Z"),
        status: "POSTED",
      },
      {
        companyId: a.companyId,
        contentId: a.contentId,
        platform: "tiktok",
        accountType: "oauth",
        connectionId: a.connectionId,
        scheduledAtUtc: new Date("2026-09-21T09:00:00.000Z"),
        status: "FAILED",
        errorCode: "token_expired",
      },
    ]);
  });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

interface DigestBrand {
  brandId: string;
  autonomy: string;
  date: string;
  generated: number;
  approved: { excerpt: string; scheduled: unknown[]; contentId?: string }[];
  rejected: { reasons: string[] }[];
  held: { reasons: string[] }[];
  published: number;
  failed: { errorCode?: string }[];
  lastRun: { outcome: string; approved: number } | null;
}

const digestOf = (res: { body: Record<string, unknown> | undefined }) =>
  (dataOf(res as never) as { brands: DigestBrand[] }).brands;

describe("GET /autopilot/digest", () => {
  it("de la marca de la request: generadas, aprobadas, rechazadas con motivo, en espera, publicadas y fallidas", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/autopilot/digest" });
    expect(res.status).toBe(200);
    const brands = digestOf(res);
    expect(brands).toHaveLength(1);
    const [a] = brands;
    expect(a?.brandId).toBe(api.data.a.companyId);
    expect(a?.date).toBe("2026-09-21");
    expect(a?.autonomy).toBe("autopilot");
    // Tres del día; la de ayer no.
    expect(a?.generated).toBe(3);
    expect(a?.approved).toHaveLength(1);
    expect(a?.approved[0]).toMatchObject({
      excerpt: "Tostamos cada lunes",
      contentId: api.data.a.contentId,
      scheduled: [{ network: "instagram", at: Date.parse("2026-09-22T09:00:00.000Z") }],
    });
    // Un motivo que el contrato no conoce no viaja (ni rompe la respuesta).
    expect(a?.rejected[0]?.reasons).toEqual(["third_party_brand", "off_brand"]);
    expect(a?.held[0]?.reasons).toEqual(["judgment_timeout"]);
    expect(a?.published).toBe(1);
    expect(a?.failed).toEqual([expect.objectContaining({ errorCode: "token_expired" })]);
    expect(a?.lastRun).toMatchObject({ outcome: "ran", approved: 1 });
  });

  it("otra marca con el header no ve nada de la primera (scope por marca)", async () => {
    const res = await api.request({
      method: "GET",
      path: "/api/v1/autopilot/digest",
      headers: { [HEADER]: api.data.b.companyId },
    });
    expect(res.status).toBe(200);
    const [b] = digestOf(res);
    expect(b?.brandId).toBe(api.data.b.companyId);
    expect(b?.approved).toEqual([]);
    expect(b?.rejected).toEqual([]);
    expect(b?.lastRun).toBeNull();
    // Sin estrategia guardada, `manual`.
    expect(b?.autonomy).toBe("manual");
  });

  it("brands=all: todas las del dueño, cada una con lo suyo", async () => {
    const res = await api.request({
      method: "GET",
      path: "/api/v1/autopilot/digest?brands=all",
    });
    expect(res.status).toBe(200);
    const brands = digestOf(res);
    expect(brands.map((b) => b.brandId).sort()).toEqual(
      [api.data.a.companyId, api.data.b.companyId].sort(),
    );
    const b = brands.find((x) => x.brandId === api.data.b.companyId);
    expect(b?.approved).toEqual([]);
  });

  it("otro día no trae las decisiones de hoy; una fecha imposible es 400", async () => {
    const other = await api.request({
      method: "GET",
      path: "/api/v1/autopilot/digest?date=2026-09-20",
    });
    const [a] = digestOf(other);
    expect(a?.approved).toEqual([]);
    expect(a?.generated).toBe(1);

    const bad = await api.request({
      method: "GET",
      path: "/api/v1/autopilot/digest?date=2026-02-30",
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad).code).toBe("bad_request");
  });
});

describe("GET /autopilot/policy", () => {
  it("los umbrales son los de core, sin copia a mano", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/autopilot/policy" });
    expect(res.status).toBe(200);
    const policy = dataOf(res) as { thresholds: unknown; horizonDays: number };
    expect(policy.thresholds).toEqual(PRECHECK_THRESHOLDS);
    expect(policy.horizonDays).toBe(2);
  });
});
