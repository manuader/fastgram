/**
 * El decisor de assets en el worker (sprint 9, O) con un juicio falso:
 * paralelismo acotado, plazo total, fallback y que nunca lanza.
 */
import { describe, expect, it, vi } from "vitest";
import type { AssetCandidate, AssetDecisionInput } from "@fastgram/core";
import {
  PortError,
  type AskRequest,
  type Judgment,
  type JudgmentBatchOutcome,
  type JudgmentQuestion,
  type ScoreAnswer,
} from "@fastgram/ports";

import { assetDecisionRow, runAssetDecision } from "./asset-decider.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const score = (level: number): ScoreAnswer => {
  const probabilities = [0, 0, 0, 0];
  probabilities[level - 1] = 1;
  return { kind: "score", value: level, probabilities, confidence: 1 };
};

/**
 * Un juicio falso que puntúa por palabras de la descripción: «monday» = encaje
 * 4, «gun» = NSFW. Cuenta cuántas llamadas hay en vuelo a la vez.
 */
function fakeJudge(opts: { delayMs?: number; fail?: boolean } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const wait = async () => {
    inFlight += 1;
    calls += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 1));
    inFlight -= 1;
    if (opts.fail === true) {
      throw new PortError("provider_unavailable", "down", { source: "test" });
    }
  };
  const describe = (state: unknown): string => JSON.stringify(state).toLowerCase();
  const judgment: Judgment = {
    provenance: { adapter: "laya", model: "auto" },
    choice: async () => {
      throw new Error("no");
    },
    score: async () => {
      throw new Error("no");
    },
    noul: async (r) => {
      await wait();
      return {
        answer: {
          kind: "noul",
          probability: describe(r.state).includes("gun") ? 0.95 : 0.05,
        },
        usage: { latencyMs: 1 },
      };
    },
    ask: async <const Q extends readonly JudgmentQuestion[]>(r: AskRequest<Q>) => {
      await wait();
      const text = describe(r.state);
      if (r.questions.some((q) => q.id === "harm")) {
        const p = text.includes("gun") ? 0.95 : 0.05;
        return {
          answers: {
            harm: { kind: "noul", probability: p },
            nsfw: { kind: "noul", probability: p },
          },
          usage: { latencyMs: 1 },
        } as unknown as JudgmentBatchOutcome<Q>;
      }
      const level = text.includes("monday") ? 4 : text.includes("tired") ? 3 : 1;
      const answers: Record<string, ScoreAnswer> = {};
      for (const q of r.questions) answers[q.id] = score(q.id === "brandFit" ? 2 : level);
      return { answers, usage: { latencyMs: 1 } } as unknown as JudgmentBatchOutcome<Q>;
    },
  };
  return {
    judgment,
    get maxInFlight() {
      return maxInFlight;
    },
    get calls() {
      return calls;
    },
  };
}

function input(n: number, extra: AssetCandidate[] = []): AssetDecisionInput {
  const candidates: AssetCandidate[] = Array.from({ length: n }, (_, i) => ({
    id: `c${String(i)}`,
    kind: "meme_clip",
    source: "brand",
    description: `random clip ${String(i)}`,
  }));
  return {
    idea: "hating mondays",
    brand: { name: "Brand" },
    format: "green-screen",
    role: "meme",
    candidates: [...candidates, ...extra],
  };
}

describe("runAssetDecision", () => {
  it("elige el que mejor encaja, saltea el inseguro, con ≤ 4 en vuelo", async () => {
    const fake = fakeJudge({ delayMs: 3 });
    const run = await runAssetDecision(
      fake.judgment,
      input(20, [
        {
          id: "gun",
          kind: "meme_clip",
          source: "brand",
          description: "monday man with a gun",
        },
        {
          id: "best",
          kind: "meme_clip",
          source: "brand",
          description: "office worker hates monday",
        },
      ]),
      logger,
    );
    expect(run.decision.mode).toBe("judged");
    expect(run.decision.chosenId).toBe("best");
    expect(run.decision.scored.find((s) => s.id === "gun")?.status).toBe("unsafe");
    expect(fake.maxInFlight).toBeLessThanOrEqual(4);
    // Encaje de los 20 de la shortlist + seguridad de un lote de 4 (el mejor
    // encaje, «gun», es inseguro; el segundo, «best», es seguro: se corta ahí).
    expect(run.attempted).toBe(24);
    expect(run.answered).toBe(24);
    expect(run.answers.get("c5")?.safety).toBeUndefined();
    expect(run.answers.get("best")?.safety?.harm?.probability).toBe(0.05);
    expect(run.answers.get("best")?.fit?.ideaFit?.value).toBe(4);
  });

  it("plazo vencido: decide con lo que llegó (o ranking), nunca espera de más", async () => {
    const fake = fakeJudge({ delayMs: 200 });
    const started = Date.now();
    const run = await runAssetDecision(fake.judgment, input(20), logger, {
      deadlineMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(["judged", "fallback"]).toContain(run.decision.mode);
    expect(run.attempted).toBeLessThan(40);
  });

  it("motor caído: a la tercera falla deja de intentar y manda el ranking", async () => {
    const fake = fakeJudge({ fail: true });
    const run = await runAssetDecision(fake.judgment, input(20), logger, {
      concurrency: 1,
    });
    expect(run.decision.mode).toBe("fallback");
    expect(run.decision.chosenId).toBe("c0");
    expect(fake.calls).toBe(3);
  });

  it("sin juicio: ranking textual sin llamar a nadie", async () => {
    const run = await runAssetDecision(null, input(3), logger);
    expect(run.decision.mode).toBe("fallback");
    expect(run.attempted).toBe(0);
  });

  it("la fila de asset_decisions no lleva descripciones (texto de terceros)", async () => {
    const fake = fakeJudge();
    const i = input(3);
    const run = await runAssetDecision(fake.judgment, i, logger);
    const row = assetDecisionRow(
      { companyId: "x", subjectType: "blitz_refill" },
      i,
      run,
      fake.judgment.provenance,
    );
    expect(JSON.stringify(row)).not.toContain("random clip");
    expect(row.adapter).toBe("laya");
    expect(row.questionsVersion).toBe("s9.1");
    expect((row.candidates as unknown[]).length).toBe(3);
  });
});
