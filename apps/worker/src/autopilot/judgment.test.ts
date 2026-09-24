import { StubJudgmentAdapter } from "@fastgram/adapters";
import { PortError, type Judgment } from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import { askPrecheck } from "./judgment.js";

const state = { caption: "hola", contentType: "wall-of-text" };

function failing(error: unknown): Judgment {
  const stub = new StubJudgmentAdapter();
  return {
    provenance: stub.provenance,
    choice: (r) => stub.choice(r),
    score: (r) => stub.score(r),
    noul: (r) => stub.noul(r),
    ask: () => Promise.reject(error),
  };
}

describe("askPrecheck — timeout duro (JV-3)", () => {
  it("responde → answered, con las cinco preguntas", async () => {
    const run = await askPrecheck(new StubJudgmentAdapter(), state, 1_000);
    expect(run.outcome.kind).toBe("answered");
    if (run.outcome.kind === "answered") {
      expect(Object.keys(run.outcome.answers).sort()).toEqual([
        "coherent",
        "inLanguage",
        "onBrand",
        "riskyClaims",
        "thirdPartyBrands",
      ]);
    }
  });

  it("un adaptador que no respeta su timeout igual corta: el reloj es propio", async () => {
    const hanging: Judgment = { ...failing(null), ask: () => new Promise(() => {}) };
    const started = Date.now();
    const run = await askPrecheck(hanging, state, 30);
    expect(run.outcome).toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("PortError timeout → timeout; cualquier otro → unavailable; nunca lanza", async () => {
    const t = await askPrecheck(
      failing(new PortError("timeout", "slow", { source: "x" })),
      state,
      1_000,
    );
    expect(t.outcome).toEqual({ kind: "timeout" });
    const u = await askPrecheck(
      failing(new PortError("provider_contract_violation", "bad", { source: "x" })),
      state,
      1_000,
    );
    expect(u.outcome).toEqual({
      kind: "unavailable",
      code: "provider_contract_violation",
    });
    const bug = await askPrecheck(failing(new TypeError("boom")), state, 1_000);
    expect(bug.outcome).toEqual({ kind: "unavailable", code: "unexpected" });
  });
});
