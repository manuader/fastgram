/**
 * Sprint 9 (O, D-18): las tareas de juicio pueden apuntar a un motor SystemOne
 * (Laya local, Jev de TypeSafe). Lo que fija este archivo:
 *
 * - quién gana en la cadena `judgment.x` → `judgment` → LLM;
 * - que una entrada SystemOne nunca se use como LLM (`resolveLlmConfig`);
 * - que un SystemOne no pida ventana de contexto, y que Jev sí pida key.
 */
import { describe, expect, it } from "vitest";
import type { ModelRegistrySnapshot, ModelTaskConfig } from "@fastgram/ports";

import {
  applyTaskUpdate,
  missingFields,
  resolveJudgmentConfig,
  resolveLlmConfig,
  toPublicTaskConfig,
} from "./config.js";
import { taskSpec } from "./presets.js";

const llm = (model: string): ModelTaskConfig => ({
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  model,
  contextWindowTokens: 32_000,
});

const laya: ModelTaskConfig = {
  provider: "laya",
  baseUrl: "http://127.0.0.1:3006",
  model: "auto",
};

const jevNoKey: ModelTaskConfig = {
  provider: "typesafe",
  baseUrl: "https://api.typesafe.ai",
  model: "jev-latest",
};

describe("resolveJudgmentConfig", () => {
  it("judgment en Laya: todos los puntos sin override van a Laya", () => {
    const snap: ModelRegistrySnapshot = { tasks: { text: llm("small"), judgment: laya } };
    for (const task of [
      "judgment",
      "judgment.autopilot",
      "judgment.assets",
      "judgment.brand",
    ] as const) {
      const r = resolveJudgmentConfig(task, snap, null, {});
      expect(r?.engine).toBe("systemone");
      if (r?.engine === "systemone") {
        expect(r.provider).toBe("laya");
        expect(r.entry).toBe("judgment");
        expect(r.apiKey).toBe("");
      }
    }
  });

  it("un override LLM completo gana sobre un judgment en Laya", () => {
    const snap: ModelRegistrySnapshot = {
      tasks: { text: llm("small"), judgment: laya, "judgment.autopilot": llm("big") },
    };
    const r = resolveJudgmentConfig("judgment.autopilot", snap, null, {});
    expect(r?.engine).toBe("llm");
    if (r?.engine === "llm") expect(r.llm.model).toBe("big");
  });

  it("sólo judgment.assets en Laya: el resto sigue en el LLM", () => {
    const snap: ModelRegistrySnapshot = {
      tasks: { text: llm("small"), "judgment.assets": laya },
    };
    expect(resolveJudgmentConfig("judgment.assets", snap, null, {})?.engine).toBe(
      "systemone",
    );
    const other = resolveJudgmentConfig("judgment.brand", snap, null, {});
    expect(other?.engine).toBe("llm");
    if (other?.engine === "llm") expect(other.llm.model).toBe("small");
  });

  it("Jev sin key está incompleto y cae al LLM (no tapa)", () => {
    const snap: ModelRegistrySnapshot = {
      tasks: { text: llm("small"), judgment: jevNoKey },
    };
    expect(missingFields("judgment", jevNoKey, {})).toEqual(["apiKey"]);
    const r = resolveJudgmentConfig("judgment", snap, null, {});
    expect(r?.engine).toBe("llm");
  });

  it("Jev con key por variable de entorno: SystemOne con esa key", () => {
    const snap: ModelRegistrySnapshot = {
      tasks: { judgment: { ...jevNoKey, apiKeyEnv: "TYPESAFE_API_KEY" } },
    };
    const r = resolveJudgmentConfig("judgment", snap, null, {
      TYPESAFE_API_KEY: "ts-key-0000000000001",
    });
    expect(r?.engine).toBe("systemone");
    if (r?.engine === "systemone") expect(r.apiKey).toBe("ts-key-0000000000001");
  });

  it("sin nada configurado: null", () => {
    expect(resolveJudgmentConfig("judgment.assets", { tasks: {} }, null, {})).toBeNull();
  });
});

describe("una entrada SystemOne nunca es un LLM", () => {
  it("judgment en Laya: el LLM de juicio es el de texto", () => {
    const snap: ModelRegistrySnapshot = { tasks: { text: llm("small"), judgment: laya } };
    expect(resolveLlmConfig("judgment", snap, null, {})?.model).toBe("small");
    expect(resolveLlmConfig("judgment.assets", snap, null, {})?.model).toBe("small");
  });

  it("override en Laya: el LLM es el de judgment", () => {
    const snap: ModelRegistrySnapshot = {
      tasks: { text: llm("small"), judgment: llm("judge"), "judgment.assets": laya },
    };
    expect(resolveLlmConfig("judgment.assets", snap, null, {})?.model).toBe("judge");
  });
});

describe("guardar y mostrar", () => {
  it("las tareas de juicio aceptan Laya y TypeSafe; texto y visión no", () => {
    expect(taskSpec("judgment").providers).toContain("laya");
    expect(taskSpec("judgment.assets").providers).toContain("typesafe");
    expect(taskSpec("text").providers).not.toContain("laya");
    expect(taskSpec("vision").providers).not.toContain("typesafe");
  });

  it("Laya se guarda sin ventana y sin key, y queda ready", () => {
    const r = applyTaskUpdate(
      "judgment.assets",
      undefined,
      { provider: "laya", model: "auto", contextWindowTokens: 8000 },
      "2026-09-28T00:00:00.000Z",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.baseUrl).toBe("http://127.0.0.1:3006");
    expect(r.config.contextWindowTokens).toBeUndefined();
    const view = toPublicTaskConfig(
      "judgment.assets",
      { tasks: { "judgment.assets": r.config } },
      null,
      {},
    );
    expect(view.status).toBe("ready");
    expect(view.missing).toEqual([]);
  });

  it("Laya no se puede elegir para texto", () => {
    const r = applyTaskUpdate(
      "text",
      undefined,
      { provider: "laya", model: "auto" },
      "2026-09-28T00:00:00.000Z",
    );
    expect(r.ok).toBe(false);
  });
});
