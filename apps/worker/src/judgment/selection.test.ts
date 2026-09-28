/**
 * Sprint 9 (T, `PU-S9-015`): el decisor del worker con el gusto del dueño y la
 * biblioteca global, con un juicio falso. Sin red ni base.
 */
import { describe, expect, it, vi } from "vitest";
import {
  aggregatePreferenceSignals,
  buildPreferences,
  type AssetCandidate,
  type AssetDecisionInput,
  type LearnedPreferences,
} from "@fastgram/core";
import type {
  AskRequest,
  Judgment,
  JudgmentBatchOutcome,
  JudgmentQuestion,
  Rng,
  ScoreAnswer,
} from "@fastgram/ports";

import {
  runAssetDecision,
  withLearnedPreferences,
  type AssetJudge,
} from "./asset-decider.js";
import { libraryCopyMediaId } from "./library-source.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = Date.parse("2026-09-28T12:00:00.000Z");

/** Un score "blando" con valor esperado `value`. */
const soft = (value: number): ScoreAnswer => ({
  kind: "score",
  value,
  probabilities: [0.25, 0.25, 0.25, 0.25],
  confidence: 0.25,
});

/**
 * Juicio falso: «shocked» encaja 3,0 y «laughing» 2,8 (casi empate), todo
 * seguro. Anota en qué orden se preguntó la seguridad.
 */
function nearTieJudge() {
  const safetyOrder: string[] = [];
  const judgment: Judgment = {
    provenance: { adapter: "laya", model: "auto" },
    choice: async () => {
      throw new Error("no");
    },
    score: async () => {
      throw new Error("no");
    },
    noul: async () => {
      throw new Error("no");
    },
    ask: async <const Q extends readonly JudgmentQuestion[]>(r: AskRequest<Q>) => {
      const text = JSON.stringify(r.state).toLowerCase();
      if (r.questions.some((q) => q.id === "harm")) {
        safetyOrder.push(text.includes("laughing") ? "b" : "a");
        return {
          answers: {
            harm: { kind: "noul", probability: 0.05 },
            nsfw: { kind: "noul", probability: 0.05 },
          },
          usage: { latencyMs: 1 },
        } as unknown as JudgmentBatchOutcome<Q>;
      }
      const idea = text.includes("laughing") ? 2.8 : 3;
      const answers: Record<string, ScoreAnswer> = {};
      for (const q of r.questions)
        answers[q.id] = q.id === "ideaFit" ? soft(idea) : soft(3);
      return { answers, usage: { latencyMs: 1 } } as unknown as JudgmentBatchOutcome<Q>;
    },
  };
  return { judgment, safetyOrder };
}

const clip = (id: string, tags: string[]): AssetCandidate => ({
  id,
  kind: "meme_clip",
  source: "brand",
  description: `clip ${tags.join(" ")}`,
  tags,
});

const input = (extra: Partial<AssetDecisionInput> = {}): AssetDecisionInput => ({
  idea: "mondays",
  brand: { name: "Acme" },
  format: "green-screen",
  role: "meme",
  candidates: [clip("a", ["shocked"]), clip("b", ["laughing"])],
  ...extra,
});

function likesLaugh(exploration = 0.15): LearnedPreferences {
  const signals = [
    ...Array.from({ length: 6 }, () => ({
      kind: "accept" as const,
      features: ["clip.kind=laugh"],
      occurredAtMs: NOW,
    })),
    ...Array.from({ length: 6 }, () => ({
      kind: "discard" as const,
      features: ["clip.kind=shock"],
      occurredAtMs: NOW,
    })),
  ];
  return buildPreferences({
    brand: aggregatePreferenceSignals(signals, { nowMs: NOW }),
    owner: null,
    settings: { exploration },
    nowMs: NOW,
  });
}

/** Un `Rng` que devuelve estos valores en orden y cuenta cuántos se pidieron. */
function scripted(values: number[]): Rng & { used: number } {
  const rng = {
    used: 0,
    next: () => {
      const v = values[rng.used] ?? 0.99;
      rng.used += 1;
      return v;
    },
    nextInt: () => 0,
    weightedPick: <T>(items: readonly { value: T }[]): T => {
      const first = items[0];
      if (first === undefined) throw new Error("vacío");
      return first.value;
    },
  };
  return rng;
}

describe("runAssetDecision con el gusto del dueño (juicio falso)", () => {
  it("sin preferencias gana el mejor encaje; con ellas, el que le gusta — y la seguridad se pregunta en ese orden", async () => {
    const plain = nearTieJudge();
    const r0 = await runAssetDecision(plain.judgment, input(), logger, {
      concurrency: 1,
    });
    expect(r0.decision.chosenId).toBe("a");
    expect(plain.safetyOrder[0]).toBe("a");

    const tuned = nearTieJudge();
    const r1 = await runAssetDecision(
      tuned.judgment,
      input({ preferences: { prefs: likesLaugh(), explored: false } }),
      logger,
      { concurrency: 1 },
    );
    expect(r1.decision.chosenId).toBe("b");
    expect(tuned.safetyOrder[0]).toBe("b");
    const b = r1.decision.scored.find((s) => s.id === "b");
    expect(b?.preference).toBeCloseTo(1.164, 3);
    expect(b?.total).toBeCloseTo((b?.fit ?? 0) * 1.1642, 3);
  });
});

describe("withLearnedPreferences", () => {
  const recorder = () => {
    const seen: AssetDecisionInput[] = [];
    const judge: AssetJudge = {
      decide: async (i) => {
        seen.push(i);
        return {
          role: i.role,
          chosenId: null,
          mode: "empty",
          reason: "",
          scored: [],
          excluded: [],
          weights: {},
          weightsVersion: "t",
        };
      },
    };
    return { judge, seen };
  };

  it("sin nada aprendido devuelve el mismo juez y no toca el Rng", async () => {
    const { judge } = recorder();
    const rng = scripted([0.5]);
    const empty = buildPreferences({ brand: null, owner: null, nowMs: NOW });
    expect(withLearnedPreferences(judge, empty, rng)).toBe(judge);
    expect(withLearnedPreferences(judge, null, rng)).toBe(judge);
    expect(rng.used).toBe(0);
  });

  it("una tirada por decisión: 0,10 < 15 % explora; 0,90 no", async () => {
    const { judge, seen } = recorder();
    const rng = scripted([0.1, 0.9]);
    const tuned = withLearnedPreferences(judge, likesLaugh(0.15), rng);
    await tuned.decide(input());
    await tuned.decide(input());
    expect(rng.used).toBe(2);
    expect(seen.map((i) => i.preferences?.explored)).toEqual([true, false]);
  });
});

describe("la copia de un asset global en una marca", () => {
  it("tiene un id uuid determinista por (marca, asset)", () => {
    const a = libraryCopyMediaId("c1", "asset-1");
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(libraryCopyMediaId("c1", "asset-1")).toBe(a);
    expect(libraryCopyMediaId("c2", "asset-1")).not.toBe(a);
    expect(libraryCopyMediaId("c1", "asset-2")).not.toBe(a);
  });
});
