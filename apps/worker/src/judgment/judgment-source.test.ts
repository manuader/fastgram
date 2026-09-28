/**
 * La fábrica de juicio (sprint 9, O): según el registro, SystemOne o LLM,
 * siempre con `RecordingJudgment`.
 */
import { describe, expect, it, vi } from "vitest";
import type { JudgmentRecordEntry, JudgmentSink } from "@fastgram/adapters";
import type { Database } from "@fastgram/db";
import type {
  Judgment,
  Llm,
  ModelRegistry,
  ModelRegistrySnapshot,
} from "@fastgram/ports";

import type { LlmSource } from "../llm/registry-llm.js";
import { createJudgmentSource } from "./judgment-source.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function registry(snapshot: ModelRegistrySnapshot): ModelRegistry {
  return { read: async () => snapshot, write: async () => undefined };
}

/** Un `Llm` que nunca se llama en estos tests (sólo se construye el adaptador). */
const llm: Llm = {
  complete: async () => {
    throw new Error("no se llama");
  },
  completeJson: async () => {
    throw new Error("no se llama");
  },
};

function llmSource(available: boolean): LlmSource {
  return {
    current: async () =>
      available
        ? {
            llm,
            config: {
              source: "registry",
              entry: "text",
              provider: "ollama",
              baseUrl: "http://localhost:11434/v1",
              apiKey: "",
              model: "qwen",
              contextWindowTokens: 32_000,
            },
          }
        : null,
  };
}

/** Un SystemOne falso que contesta un noul fijo. */
function fakeSystemOne(): Judgment {
  return {
    provenance: { adapter: "laya", model: "auto" },
    choice: async () => {
      throw new Error("no");
    },
    score: async () => {
      throw new Error("no");
    },
    noul: async () => ({
      answer: { kind: "noul", probability: 0.2 },
      usage: { latencyMs: 3 },
    }),
    ask: async () => {
      throw new Error("no");
    },
  };
}

const LAYA = {
  provider: "laya",
  baseUrl: "http://127.0.0.1:3006",
  model: "auto",
} as const;
const subject = { companyId: "00000000-0000-4000-8000-000000000001", subjectType: "t" };

function source(snapshot: ModelRegistrySnapshot, withLlm = true) {
  const recorded: JudgmentRecordEntry[] = [];
  const sink: JudgmentSink = {
    record: async (e) => {
      recorded.push(e);
    },
  };
  const built: string[] = [];
  const s = createJudgmentSource({
    llmSource: llmSource(withLlm),
    db: {} as unknown as Database, // no se usa: el sink es de memoria
    appRole: undefined,
    logger,
    registry: registry(snapshot),
    secrets: {},
    sink,
    buildSystemOne: (config) => {
      built.push(`${config.provider}:${config.model}`);
      return fakeSystemOne();
    },
  });
  return { s, recorded, built };
}

describe("createJudgmentSource", () => {
  it("judgment.assets en Laya → SystemOne, envuelto (graba en judgment_records)", async () => {
    const { s, recorded, built } = source({ tasks: { "judgment.assets": LAYA } });
    const h = await s.resolve("judgment.assets", subject);
    expect(h?.engine).toBe("systemone");
    expect(h?.judgment.provenance).toEqual({ adapter: "laya", model: "auto" });
    await h?.judgment.noul({
      decisionPoint: "DP-005",
      state: { a: 1 },
      question: {
        id: "q",
        kind: "noul",
        instructions: "x",
        criteria: { true: "t", false: "f" },
      },
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.adapter).toBe("laya");
    expect(built).toEqual(["laya:auto"]);
  });

  it("el adaptador se reusa mientras la configuración no cambie", async () => {
    const { s, built } = source({ tasks: { judgment: LAYA } });
    await s.resolve("judgment", subject);
    await s.resolve("judgment.brand", subject);
    expect(built).toEqual(["laya:auto"]);
  });

  it("llmOnly: aunque la tarea sea Laya, el LLM de fallback", async () => {
    const { s } = source({ tasks: { judgment: LAYA } });
    const h = await s.resolve("judgment", subject, { llmOnly: true });
    expect(h?.engine).toBe("llm");
    expect(h?.judgment.provenance.adapter).toBe("llm");
  });

  it("sin SystemOne: el LLM de la tarea; sin nada, null", async () => {
    expect(
      (await source({ tasks: {} }).s.resolve("judgment.assets", subject))?.engine,
    ).toBe("llm");
    expect(await source({ tasks: {} }, false).s.resolve("judgment", subject)).toBeNull();
  });
});
