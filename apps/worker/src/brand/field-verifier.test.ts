/**
 * `JV-4` en el worker: con un juicio falso (el puerto, no el adaptador).
 */
import { describe, expect, it } from "vitest";
import type { DerivedField } from "@fastgram/core";
import { PortError, type Judgment } from "@fastgram/ports";

import { createFieldVerifier } from "./field-verifier.js";
import type { BuildLogger } from "../content/build-handler.js";

const logger: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

const base = {
  confidence: "low" as const,
  confidenceSource: "synthesizer" as const,
  sourceId: "11111111-1111-4111-8111-111111111111",
  sourceType: "website" as const,
};
const fields: DerivedField[] = [
  { ...base, field: "productOffering", value: "Mugs", excerpt: "we sell mugs" },
  { ...base, field: "toneOfVoice", value: "Warm", excerpt: "hey friend!" },
  { ...base, field: "targetAudience", value: "", excerpt: undefined },
];

/** Un juicio que contesta por el nombre del campo del estado. */
function scripted(
  byField: Record<string, { p: number; s: number } | "throw" | "garbage">,
  asked: string[],
): Judgment {
  const ask = (async (request: { state: Record<string, unknown> }) => {
    const name = String(request.state["fieldName"]);
    asked.push(name);
    const plan = byField[name];
    if (plan === "throw") throw new PortError("timeout", "slow", { source: "test" });
    if (plan === "garbage" || plan === undefined)
      return { answers: {}, usage: { latencyMs: 1 } };
    return {
      answers: {
        supported: { kind: "noul", probability: plan.p },
        specificity: {
          kind: "score",
          value: plan.s,
          probabilities: [0, 1, 0],
          confidence: 1,
        },
      },
      usage: { latencyMs: 1 },
    };
  }) as unknown as Judgment["ask"];
  return {
    provenance: { adapter: "stub", model: "fake" },
    ask,
    choice: () => Promise.reject(new Error("no")),
    score: () => Promise.reject(new Error("no")),
    noul: () => Promise.reject(new Error("no")),
  };
}

const subject = { companyId: "c", sourceId: base.sourceId };

describe("JV-4 · worker", () => {
  it("mide la confianza de cada campo verificable, y sólo de ésos", async () => {
    const asked: string[] = [];
    const judgment = scripted(
      { productOffering: { p: 0.95, s: 2.5 }, toneOfVoice: { p: 0.7, s: 1 } },
      asked,
    );
    const out = await createFieldVerifier({
      judgment: () => Promise.resolve(judgment),
      logger,
    }).verify(fields, subject);
    expect(asked).toEqual(["productOffering", "toneOfVoice"]);
    expect(out.map((f) => [f.field, f.confidence, f.confidenceSource])).toEqual([
      ["productOffering", "high", "verifier"],
      ["toneOfVoice", "medium", "verifier"],
      ["targetAudience", "low", "synthesizer"],
    ]);
  });

  it("sin modelo de juicio, nada cambia (fallback conservador)", async () => {
    const out = await createFieldVerifier({
      judgment: () => Promise.resolve(null),
      logger,
    }).verify(fields, subject);
    expect(out).toEqual(fields);
  });

  it("un error o una respuesta rota dejan ese campo como estaba y siguen", async () => {
    const asked: string[] = [];
    const judgment = scripted(
      { productOffering: "throw", toneOfVoice: "garbage" },
      asked,
    );
    const out = await createFieldVerifier({
      judgment: () => Promise.resolve(judgment),
      logger,
    }).verify(fields, subject);
    expect(asked).toEqual(["productOffering", "toneOfVoice"]);
    expect(out).toEqual(fields);
  });
});
