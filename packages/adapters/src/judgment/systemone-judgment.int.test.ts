/**
 * `SystemOneJudgmentAdapter` contra el Laya real (D-18). Opcional: si
 * `LAYA_URL` (default `http://127.0.0.1:3006`) no responde `/health`, se
 * saltea — no hay Laya en CI y el test no puede mentir diciendo que pasó.
 *
 * No prueba calidad de juicio (§25.4), sólo que el wire real encaja en el
 * contrato: tres tipos de pregunta, 0-based → 1-based, y el ruteo por idioma.
 */
import { describe, expect, it } from "vitest";

import { probeSystemOne } from "./systemone-catalog.js";
import { SystemOneJudgmentAdapter } from "./systemone-judgment.js";

const BASE = process.env["LAYA_URL"] ?? "http://127.0.0.1:3006";

async function layaUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

const up = await layaUp();

describe.skipIf(!up)(`Laya real en ${BASE}`, () => {
  const raw: string[] = [];
  const adapter = new SystemOneJudgmentAdapter({
    baseUrl: BASE,
    model: "auto",
    adapter: "laya",
    // La primera llamada a un checkpoint frío tarda ~8–10 s en la Mac.
    defaultTimeoutMs: 30_000,
    onRawResponse: (r) => raw.push(r.model),
  });

  it("choice, score y noul en un lote", async () => {
    const { answers, usage } = await adapter.ask({
      decisionPoint: "DP-005",
      state: {
        idea: "a meme about hating mondays",
        candidate:
          "office worker slams the alarm clock and groans at the Monday calendar",
      },
      questions: [
        {
          id: "fit",
          kind: "score",
          instructions: "How well does the candidate clip fit the idea?",
          levels: [
            "Unrelated to the idea.",
            "Loosely related.",
            "Clearly fits the idea.",
            "A perfect match for the idea.",
          ],
        },
        {
          id: "safe",
          kind: "noul",
          instructions: "Is the candidate safe for a mainstream brand to post?",
          criteria: {
            true: "Nothing offensive, sexual, violent or hateful.",
            false: "Contains offensive, sexual, violent or hateful content.",
          },
        },
        {
          id: "mood",
          kind: "choice",
          instructions: "What is the mood of the candidate clip?",
          criteria: {
            frustrated: "Annoyed, tired or frustrated.",
            happy: "Cheerful or excited.",
            neutral: "No clear emotion.",
          },
        },
      ],
    });
    expect(answers.fit.value).toBeGreaterThanOrEqual(1);
    expect(answers.fit.value).toBeLessThanOrEqual(4);
    expect(answers.safe.probability).toBeGreaterThanOrEqual(0);
    expect(Object.keys(answers.mood.probabilities).sort()).toEqual([
      "frustrated",
      "happy",
      "neutral",
    ]);
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(raw.at(-1)).toBe("laya-rl-agent/english");
  });

  it("estado en castellano: rutea al checkpoint multilingüe", async () => {
    await adapter.noul({
      decisionPoint: "DP-005",
      state: {
        idea: "un meme sobre odiar los lunes",
        candidate: "un gato que se cae de la mesa",
      },
      question: {
        id: "fits",
        kind: "noul",
        instructions: "Does the candidate fit the idea?",
        criteria: { true: "It fits the idea.", false: "It does not fit the idea." },
      },
    });
    expect(raw.at(-1)).toBe("laya-rl-agent/multilingual");
  });

  it("probar conexión", async () => {
    const r = await probeSystemOne({
      provider: "laya",
      baseUrl: BASE,
      apiKey: "",
      model: "auto",
      timeoutMs: 30_000,
    });
    expect(r.model.startsWith("laya-rl-agent")).toBe(true);
  });
});
