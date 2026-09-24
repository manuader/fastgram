import { describe, expect, it } from "vitest";
import {
  MODEL_PROVIDERS,
  MODEL_TASKS,
  type ModelRegistrySnapshot,
  type ModelTaskConfig,
} from "@fastgram/ports";

import {
  applyTaskUpdate,
  checkBaseUrl,
  keyLast4,
  legacyLlmFromEnv,
  openAiEndpoint,
  resolveLlmConfig,
  storedKeyFor,
  toPublicTaskConfig,
  type LegacyLlmEnv,
} from "./config.js";
import { MODEL_PROVIDER_PRESETS, MODEL_TASK_SPECS, providerPreset } from "./presets.js";

const NOW = "2026-09-24T12:00:00.000Z";
const KEY = "sk-or-v1-0123456789abcdef";
const LEGACY: LegacyLlmEnv = {
  baseUrl: "https://gateway.example/v1",
  apiKey: "env-key-0123456789",
  model: "env-model",
  contextWindowTokens: 8192,
};

const text = (over: Partial<ModelTaskConfig> = {}): ModelTaskConfig => ({
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "some/model",
  apiKey: KEY,
  contextWindowTokens: 32000,
  ...over,
});

describe("presets", () => {
  it("cubren el enum entero de proveedores y de tareas", () => {
    expect(MODEL_PROVIDER_PRESETS.map((p) => p.id).sort()).toEqual(
      [...MODEL_PROVIDERS].sort(),
    );
    expect(MODEL_TASK_SPECS.map((s) => s.task).sort()).toEqual([...MODEL_TASKS].sort());
  });

  it("no inventan la base URL de DeepSeek ni de custom", () => {
    expect(providerPreset("deepseek").baseUrl).toBeNull();
    expect(providerPreset("custom").baseUrl).toBeNull();
  });

  it("los locales no piden key", () => {
    expect(providerPreset("ollama").requiresKey).toBe(false);
    expect(providerPreset("lmstudio").requiresKey).toBe(false);
  });

  it("todas las base URLs de preset pasan la validación", () => {
    for (const p of MODEL_PROVIDER_PRESETS) {
      if (p.baseUrl !== null) expect(checkBaseUrl(p.baseUrl).ok).toBe(true);
    }
  });
});

describe("openAiEndpoint", () => {
  it("sigue la convención del SDK: base + recurso, con o sin barra final", () => {
    expect(
      openAiEndpoint(
        "https://generativelanguage.googleapis.com/v1beta/openai/",
        "chat/completions",
      ),
    ).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(openAiEndpoint("http://localhost:11434/v1", "models")).toBe(
      "http://localhost:11434/v1/models",
    );
  });
});

describe("checkBaseUrl", () => {
  it("rechaza credenciales en la URL, query y esquemas raros", () => {
    expect(checkBaseUrl("https://user:pass@x.example/v1").ok).toBe(false);
    expect(checkBaseUrl("https://x.example/v1?key=abc").ok).toBe(false);
    expect(checkBaseUrl("ftp://x.example").ok).toBe(false);
    expect(checkBaseUrl("x.example/v1").ok).toBe(false);
    expect(checkBaseUrl("  ").ok).toBe(false);
  });
});

describe("keyLast4", () => {
  it("no muestra nada de una key corta", () => {
    expect(keyLast4("abcd1234")).toBeNull();
    expect(keyLast4(KEY)).toBe("cdef");
  });
});

describe("applyTaskUpdate", () => {
  it("toma la base URL del preset si no viene", () => {
    const r = applyTaskUpdate("text", undefined, { provider: "groq", model: "m" }, NOW);
    expect(r.ok && r.config.baseUrl).toBe("https://api.groq.com/openai/v1");
  });

  it("DeepSeek exige base URL: no hay default inventado", () => {
    const r = applyTaskUpdate(
      "text",
      undefined,
      { provider: "deepseek", model: "m" },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, field: "baseUrl" });
  });

  it("sin apiKey en el PUT conserva la guardada si el origen no cambió", () => {
    const r = applyTaskUpdate(
      "text",
      text(),
      { provider: "openrouter", model: "other/model" },
      NOW,
    );
    expect(r.ok && r.config.apiKey).toBe(KEY);
  });

  it("descarta la key guardada si el origen cambia y no vino una nueva", () => {
    const r = applyTaskUpdate(
      "text",
      text(),
      { provider: "custom", baseUrl: "https://evil.example/v1", model: "m" },
      NOW,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.config.apiKey).toBeUndefined();
  });

  it("null borra la key", () => {
    const r = applyTaskUpdate(
      "text",
      text(),
      { provider: "openrouter", model: "some/model", apiKey: null },
      NOW,
    );
    expect(r.ok && r.config.apiKey).toBeUndefined();
  });

  it("la ventana se conserva con el mismo modelo y se descarta si el modelo cambia", () => {
    const same = applyTaskUpdate(
      "text",
      text(),
      { provider: "openrouter", model: "some/model" },
      NOW,
    );
    expect(same.ok && same.config.contextWindowTokens).toBe(32000);
    const other = applyTaskUpdate(
      "text",
      text(),
      { provider: "openrouter", model: "other" },
      NOW,
    );
    expect(other.ok && other.config.contextWindowTokens).toBeUndefined();
  });

  it("las tareas reservadas sólo aceptan custom", () => {
    expect(
      applyTaskUpdate("image", undefined, { provider: "groq", model: "m" }, NOW),
    ).toMatchObject({ ok: false, field: "provider" });
    expect(
      applyTaskUpdate(
        "image",
        undefined,
        { provider: "custom", baseUrl: "https://img.example", model: "m" },
        NOW,
      ).ok,
    ).toBe(true);
  });

  it("rechaza una key con espacios y un nombre de variable inválido", () => {
    expect(
      applyTaskUpdate(
        "text",
        undefined,
        { provider: "groq", model: "m", apiKey: "a b" },
        NOW,
      ),
    ).toMatchObject({ ok: false, field: "apiKey" });
    expect(
      applyTaskUpdate(
        "text",
        undefined,
        { provider: "groq", model: "m", apiKeyEnv: "lower-case" },
        NOW,
      ),
    ).toMatchObject({ ok: false, field: "apiKeyEnv" });
  });
});

describe("resolveLlmConfig", () => {
  const snap = (tasks: ModelRegistrySnapshot["tasks"]): ModelRegistrySnapshot => ({
    tasks,
  });

  it("sin registro, las LLM_* de siempre", () => {
    expect(resolveLlmConfig("text", snap({}), LEGACY, {})).toMatchObject({
      source: "env",
      model: "env-model",
    });
    expect(resolveLlmConfig("text", snap({}), null, {})).toBeNull();
  });

  it("el registro completo gana al entorno", () => {
    expect(resolveLlmConfig("text", snap({ text: text() }), LEGACY, {})).toMatchObject({
      source: "registry",
      model: "some/model",
      apiKey: KEY,
    });
  });

  it("una entrada incompleta no apaga un entorno que andaba", () => {
    const { contextWindowTokens: _dropped, ...incomplete } = text();
    expect(
      resolveLlmConfig("text", snap({ text: incomplete }), LEGACY, {}),
    ).toMatchObject({ source: "env" });
  });

  it("judgment hereda de text", () => {
    expect(resolveLlmConfig("judgment", snap({ text: text() }), null, {})).toMatchObject({
      source: "registry",
      entry: "text",
    });
  });

  it("Ollama no necesita key y resuelve con key vacía", () => {
    const ollama: ModelTaskConfig = {
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5:7b-instruct",
      contextWindowTokens: 32768,
    };
    expect(resolveLlmConfig("text", snap({ text: ollama }), null, {})).toMatchObject({
      apiKey: "",
    });
  });

  it("la key puede salir de una variable de entorno", () => {
    const viaEnv: ModelTaskConfig = {
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "m",
      apiKeyEnv: "GROQ_API_KEY",
      contextWindowTokens: 8192,
    };
    expect(resolveLlmConfig("text", snap({ text: viaEnv }), null, {})).toBeNull();
    expect(
      resolveLlmConfig("text", snap({ text: viaEnv }), null, { GROQ_API_KEY: "gsk_1" }),
    ).toMatchObject({ apiKey: "gsk_1" });
  });

  it("las tareas reservadas nunca resuelven un LLM", () => {
    expect(resolveLlmConfig("image", snap({}), LEGACY, {})).toBeNull();
  });
});

describe("toPublicTaskConfig", () => {
  it("nunca devuelve la key", () => {
    const view = toPublicTaskConfig("text", { tasks: { text: text() } }, null, {});
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view.apiKey).toEqual({
      hasKey: true,
      last4: "cdef",
      source: "file",
      envVar: null,
    });
    expect(view.status).toBe("ready");
  });

  it("tampoco la del entorno", () => {
    const view = toPublicTaskConfig("text", { tasks: {} }, LEGACY, {});
    expect(JSON.stringify(view)).not.toContain(LEGACY.apiKey);
    expect(view).toMatchObject({ source: "env", status: "ready" });
  });

  it("dice qué falta", () => {
    const view = toPublicTaskConfig(
      "text",
      {
        tasks: {
          text: {
            provider: "groq",
            baseUrl: "https://api.groq.com/openai/v1",
            model: "m",
          },
        },
      },
      null,
      {},
    );
    expect(view.status).toBe("incomplete");
    expect(view.missing).toEqual(["apiKey", "contextWindowTokens"]);
  });
});

describe("storedKeyFor", () => {
  it("sólo presta la key guardada al mismo origen", () => {
    expect(storedKeyFor(text(), "https://openrouter.ai/api/v1/", {})).toBe(KEY);
    expect(storedKeyFor(text(), "https://attacker.example/v1", {})).toBeNull();
  });
});

describe("legacyLlmFromEnv", () => {
  it("las cuatro o nada", () => {
    const env = {
      LLM_BASE_URL: "https://g.example/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "m",
      LLM_CONTEXT_WINDOW_TOKENS: "8192",
    };
    expect(legacyLlmFromEnv(env)).toEqual({
      baseUrl: "https://g.example/v1",
      apiKey: "k",
      model: "m",
      contextWindowTokens: 8192,
    });
    expect(legacyLlmFromEnv({ ...env, LLM_MODEL: "" })).toBeNull();
    expect(legacyLlmFromEnv({ ...env, LLM_CONTEXT_WINDOW_TOKENS: "8k" })).toBeNull();
  });
});
