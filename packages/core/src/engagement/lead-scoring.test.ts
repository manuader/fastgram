import { describe, expect, it } from "vitest";
import type { NoulAnswer, ScoreAnswer } from "@fastgram/ports";

import {
  LEAD_SCORE_WEIGHTS,
  LEAD_SCORING_QUESTIONS,
  LEAD_THRESHOLDS,
  buildLeadScoringState,
  normalizeScoreValue,
  parseStoredLeadAnswers,
  scoreLead,
  type LeadScoringAnswers,
} from "./lead-scoring.js";

const noul = (p: number): NoulAnswer => ({ kind: "noul", probability: p });
/** Un score concentrado en un nivel (1-based). */
const score = (level: number, levels: number): ScoreAnswer => ({
  kind: "score",
  value: level,
  probabilities: Array.from({ length: levels }, (_, i) => (i + 1 === level ? 1 : 0)),
  confidence: 1,
});

function answers(over: Partial<LeadScoringAnswers> = {}): LeadScoringAnswers {
  return {
    hasProblem: noul(1),
    buyingSignal: score(4, 4),
    fitToAudience: score(3, 3),
    replyWelcome: noul(1),
    alreadyAnswered: noul(0),
    ...over,
  };
}

describe("JV-2: las preguntas son las del PRD", () => {
  it("cinco ids, en una llamada, con los niveles del PRD", () => {
    expect(LEAD_SCORING_QUESTIONS.map((q) => q.id)).toEqual([
      "hasProblem",
      "buyingSignal",
      "fitToAudience",
      "replyWelcome",
      "alreadyAnswered",
    ]);
    const bs = LEAD_SCORING_QUESTIONS[1];
    const fa = LEAD_SCORING_QUESTIONS[2];
    expect(bs.levels).toHaveLength(4);
    expect(fa.levels).toHaveLength(3);
  });

  it("ningún peso ni umbral viaja al modelo (§9.15.3 regla 2)", () => {
    const text = JSON.stringify(LEAD_SCORING_QUESTIONS);
    for (const n of [
      ...Object.values(LEAD_SCORE_WEIGHTS),
      LEAD_THRESHOLDS.top,
      LEAD_THRESHOLDS.visible,
      LEAD_THRESHOLDS.veto,
    ]) {
      expect(text).not.toContain(String(n));
    }
  });
});

describe("JV-2: composición en código", () => {
  it("normaliza el score del puerto de [1, n] a [0, 1]", () => {
    expect(normalizeScoreValue(1, 4)).toBe(0);
    expect(normalizeScoreValue(4, 4)).toBe(1);
    expect(normalizeScoreValue(2.5, 4)).toBe(0.5);
    expect(normalizeScoreValue(2, 3)).toBe(0.5);
    expect(normalizeScoreValue(Number.NaN, 3)).toBe(0);
  });

  it("aplica la fórmula literal del PRD", () => {
    // buying 3/4 → 2/3, fit 2/3 → 0.5, hasProblem 0.8, replyWelcome 0.4
    const r = scoreLead(
      answers({
        buyingSignal: score(3, 4),
        fitToAudience: score(2, 3),
        hasProblem: noul(0.8),
        replyWelcome: noul(0.4),
      }),
    );
    const expected = 0.35 * (2 / 3) + 0.3 * 0.5 + 0.2 * 0.8 + 0.15 * 0.4;
    expect(r.score).toBeCloseTo(expected, 4);
  });

  it("cortes de lista: > 0.75 top, 0.4–0.75 general, < 0.4 oculto", () => {
    expect(scoreLead(answers()).tier).toBe("top");
    expect(
      scoreLead(
        answers({
          buyingSignal: score(2, 4),
          fitToAudience: score(2, 3),
          replyWelcome: noul(0.5),
        }),
      ).tier,
    ).toBe("general");
    expect(
      scoreLead(
        answers({
          buyingSignal: score(1, 4),
          fitToAudience: score(1, 3),
          hasProblem: noul(0.3),
          replyWelcome: noul(0.2),
        }),
      ).tier,
    ).toBe("hidden");
  });

  it("exactamente 0.75 no es top (el PRD dice `> 0.75`)", () => {
    const w = { buyingSignal: 0.75, fitToAudience: 0, hasProblem: 0, replyWelcome: 0 };
    expect(scoreLead(answers(), w).score).toBe(0.75);
    expect(scoreLead(answers(), w).tier).toBe("general");
  });

  it("veto: alreadyAnswered > 0.7 oculta aunque el score sea máximo", () => {
    const r = scoreLead(answers({ alreadyAnswered: noul(0.71) }));
    expect(r.score).toBe(1);
    expect(r.tier).toBe("vetoed");
    expect(scoreLead(answers({ alreadyAnswered: noul(0.7) })).tier).toBe("top");
  });
});

describe("JV-2: recalculable sin reinferir (P4-ENGAGE-005)", () => {
  it("un peso nuevo sobre las respuestas guardadas cambia el tier, sin juicio", () => {
    const stored: unknown = JSON.parse(
      JSON.stringify(
        answers({
          buyingSignal: score(1, 4),
          fitToAudience: score(3, 3),
          hasProblem: noul(0.9),
          replyWelcome: noul(0.9),
        }),
      ),
    );
    const parsed = parseStoredLeadAnswers(stored);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(scoreLead(parsed).tier).toBe("general");
    const fitHeavy = {
      buyingSignal: 0,
      fitToAudience: 0.6,
      hasProblem: 0.2,
      replyWelcome: 0.2,
    };
    expect(scoreLead(parsed, fitHeavy).tier).toBe("top");
  });

  it("una forma vieja o rota es `null` (re-juzgar), nunca score 0", () => {
    expect(parseStoredLeadAnswers(null)).toBeNull();
    expect(
      parseStoredLeadAnswers({ hasProblem: { kind: "noul", probability: 1 } }),
    ).toBeNull();
    const wrongLevels = { ...answers(), buyingSignal: score(2, 3) };
    expect(parseStoredLeadAnswers(JSON.parse(JSON.stringify(wrongLevels)))).toBeNull();
  });
});

describe("JV-2: estado filtrado y limpio", () => {
  it("sin autor, sin perfil completo, con topes y sin invisibles", () => {
    const state = buildLeadScoringState({
      post: {
        title: "Need a tool​ for invoices",
        body: "x".repeat(10_000),
        subreddit: "smallbusiness",
        score: 12,
        numComments: 3,
        topComments: ["a", "b", "c", "d", "e", "f", "g"],
      },
      subredditRules: ["No self-promotion: ..."],
      brand: { coreIdentity: "id", productOffering: "invoices", targetAudience: "smb" },
    });
    const text = JSON.stringify(state);
    expect(text).not.toContain("author");
    expect(text).not.toContain("​");
    expect((state["post"] as { body: string }).body).toHaveLength(3_000);
    expect(state["topComments"]).toHaveLength(5);
    expect(Object.keys(state["brand"] as object).sort()).toEqual([
      "coreIdentity",
      "productOffering",
      "targetAudience",
    ]);
  });
});
