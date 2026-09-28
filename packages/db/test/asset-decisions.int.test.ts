/**
 * `0037_asset_decisions` contra Postgres real (sprint 9, O): la migración aplica,
 * una decisión se escribe y se lee por marca, RLS aísla, y `judgment_records`
 * acepta el adaptador `laya` (el valor nuevo del enum).
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createJudgmentSink,
  listRecentAssetDecisions,
  recordAssetDecision,
  type NewAssetDecision,
} from "../src/repositories/index.js";
import { withCompany } from "../src/tenancy.js";
import {
  APP_ROLE,
  seedCompany,
  startTestDatabase,
  type TestDatabase,
} from "./helpers/postgres.js";

let ctx: TestDatabase;
let alpha: string;
let beta: string;

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db)).companyId;
  beta = (await seedCompany(ctx.db)).companyId;
});

afterAll(async () => {
  await ctx.stop();
});

function decision(over: Partial<NewAssetDecision> = {}): NewAssetDecision {
  return {
    subjectType: "blitz_refill",
    role: "meme",
    format: "green-screen",
    idea: "hating mondays",
    candidates: [
      { id: "m1", kind: "meme_clip", source: "brand", textRank: 0, textScore: 3 },
    ],
    excluded: [{ id: "m9", reason: "duration" }],
    answers: {
      m1: {
        fit: {
          ideaFit: {
            kind: "score",
            value: 3.2,
            probabilities: [0, 0.2, 0.4, 0.4],
            confidence: 0.4,
          },
        },
        safety: { harm: { kind: "noul", probability: 0.1 } },
      },
    },
    scored: [{ id: "m1", total: 0.75, status: "scored" }],
    weights: { ideaFit: 0.4, text: 0.15 },
    weightsVersion: "s9.1",
    questionsVersion: "s9.1",
    chosenId: "m1",
    mode: "judged",
    reason: "Picked by AI among 1 candidates.",
    adapter: "laya",
    model: "auto",
    latencyMs: 1234.6,
    ...over,
  };
}

describe("asset_decisions (0037)", () => {
  it("se escribe con el rol de la app y se lee por marca", async () => {
    const row = await recordAssetDecision(ctx.db, alpha, decision(), { role: APP_ROLE });
    expect(row.companyId).toBe(alpha);
    expect(row.latencyMs).toBe(1235);
    const rows = await withCompany(
      ctx.db,
      alpha,
      (tx) => listRecentAssetDecisions(tx, { companyId: alpha }, { role: "meme" }),
      { role: APP_ROLE },
    );
    expect(rows.map((r) => r.chosenId)).toEqual(["m1"]);
    expect(rows[0]?.answers).toMatchObject({
      m1: { safety: { harm: { probability: 0.1 } } },
    });
  });

  it("RLS: otra marca no la ve (aunque el WHERE pida la ajena)", async () => {
    const rows = await withCompany(
      ctx.db,
      beta,
      (tx) => listRecentAssetDecisions(tx, { companyId: alpha }),
      { role: APP_ROLE },
    );
    expect(rows).toEqual([]);
  });

  it("RLS: no se puede escribir en nombre de otra marca", async () => {
    await expect(
      withCompany(
        ctx.db,
        beta,
        async (tx) => {
          const { insertAssetDecision } =
            await import("../src/repositories/asset-decisions.js");
          return insertAssetDecision(tx, { companyId: alpha }, decision());
        },
        { role: APP_ROLE },
      ),
    ).rejects.toThrow();
  });

  it("el CHECK de mode rechaza un modo inventado", async () => {
    await expect(
      recordAssetDecision(ctx.db, alpha, decision({ mode: "maybe" as never }), {
        role: APP_ROLE,
      }),
    ).rejects.toThrow();
  });

  it("judgment_records acepta el adaptador laya (valor nuevo del enum)", async () => {
    const sink = createJudgmentSink(ctx.db, { role: APP_ROLE });
    await expect(
      sink.record({
        companyId: alpha,
        decisionPoint: "DP-005",
        subjectType: "blitz_refill",
        adapter: "laya",
        model: "auto",
        answers: { safe: { kind: "noul", probability: 0.1 } },
        stateHash: createHash("sha256").update("x").digest("hex"),
        latencyMs: 12,
      }),
    ).resolves.toBeUndefined();
  });
});
