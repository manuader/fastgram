/**
 * `P1-JUDGE-004`: overrides de juicio por punto de decisión.
 */
import { describe, expect, it } from "vitest";
import type { ModelRegistrySnapshot, ModelTaskConfig } from "@fastgram/ports";

import { resolveLlmConfig, toPublicTaskConfig } from "./config.js";

const entry = (model: string, extra: Partial<ModelTaskConfig> = {}): ModelTaskConfig => ({
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  model,
  contextWindowTokens: 32_000,
  ...extra,
});

const legacy = {
  baseUrl: "https://gw.example/v1",
  apiKey: "sk-legacy-000000000000",
  model: "env-model",
  contextWindowTokens: 8_000,
};

describe("judgment.* hereda y se puede pisar", () => {
  it("sin override usa judgment; sin judgment usa text", () => {
    const onlyText: ModelRegistrySnapshot = { tasks: { text: entry("small") } };
    expect(resolveLlmConfig("judgment.autopilot", onlyText, null, {})?.model).toBe(
      "small",
    );
    const withJudgment: ModelRegistrySnapshot = {
      tasks: { text: entry("small"), judgment: entry("judge") },
    };
    expect(resolveLlmConfig("judgment.brand", withJudgment, null, {})?.model).toBe(
      "judge",
    );
  });

  it("con override completo, ése", () => {
    const snap: ModelRegistrySnapshot = {
      tasks: {
        text: entry("small"),
        judgment: entry("judge"),
        "judgment.autopilot": entry("big"),
      },
    };
    expect(resolveLlmConfig("judgment.autopilot", snap, null, {})?.model).toBe("big");
    expect(resolveLlmConfig("judgment.engagement", snap, null, {})?.model).toBe("judge");
  });

  it("un override incompleto no tapa al juicio general", () => {
    const snap: ModelRegistrySnapshot = {
      tasks: {
        judgment: entry("judge"),
        "judgment.autopilot": {
          provider: "ollama",
          baseUrl: "http://localhost:11434/v1",
          model: "big",
        },
      },
    };
    expect(resolveLlmConfig("judgment.autopilot", snap, null, {})?.model).toBe("judge");
  });

  it("sin registro, las LLM_* como antes", () => {
    expect(
      resolveLlmConfig("judgment.engagement", { tasks: {} }, legacy, {})?.model,
    ).toBe("env-model");
  });

  it("la vista pública dice de quién hereda", () => {
    const snap: ModelRegistrySnapshot = { tasks: { judgment: entry("judge") } };
    const view = toPublicTaskConfig("judgment.brand", snap, null, {});
    expect(view).toMatchObject({
      status: "ready",
      inheritsFrom: "judgment",
      model: "judge",
    });
    const own = toPublicTaskConfig(
      "judgment.brand",
      { tasks: { ...snap.tasks, "judgment.brand": entry("mine") } },
      null,
      {},
    );
    expect(own).toMatchObject({ inheritsFrom: null, model: "mine" });
  });
});
