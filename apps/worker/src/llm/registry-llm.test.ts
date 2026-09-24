import { describe, expect, it } from "vitest";
import type { FetchLike } from "@fastgram/adapters";
import type { LegacyLlmEnv, ResolvedLlmConfig } from "@fastgram/core";
import {
  isPortError,
  type Llm,
  type ModelRegistry,
  type ModelRegistrySnapshot,
  type ModelTaskConfig,
} from "@fastgram/ports";

import { buildLlm, createLlmSource, createResolvingLlm } from "./registry-llm.js";

const LEGACY: LegacyLlmEnv = {
  baseUrl: "https://gateway.example/v1",
  apiKey: "env-key",
  model: "env-model",
  contextWindowTokens: 8192,
};

const OLLAMA: ModelTaskConfig = {
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  model: "qwen2.5:7b-instruct",
  contextWindowTokens: 32768,
};

class MutableRegistry implements ModelRegistry {
  snapshot: ModelRegistrySnapshot = { tasks: {} };
  failWith: Error | null = null;
  reads = 0;
  read(): Promise<ModelRegistrySnapshot> {
    this.reads += 1;
    return this.failWith === null
      ? Promise.resolve(this.snapshot)
      : Promise.reject(this.failWith);
  }
  write(): Promise<void> {
    return Promise.resolve();
  }
}

function logger() {
  const lines: { level: string; msg: string; obj: Record<string, unknown> }[] = [];
  const at =
    (level: string) =>
    (obj: Record<string, unknown>, msg: string): void => {
      lines.push({ level, msg, obj });
    };
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

/** Un `Llm` que dice con qué configuración lo armaron. */
const fakeBuild = (config: ResolvedLlmConfig): Llm => ({ config }) as unknown as Llm;
const modelOf = (llm: Llm): string =>
  (llm as unknown as { config: ResolvedLlmConfig }).config.model;

describe("createLlmSource", () => {
  it("sin registro, las LLM_* de siempre; sin nada, null", async () => {
    const registry = new MutableRegistry();
    const withEnv = createLlmSource({
      registry,
      legacy: LEGACY,
      secrets: {},
      logger: logger(),
      build: fakeBuild,
    });
    expect((await withEnv.current("text"))?.config.source).toBe("env");

    const without = createLlmSource({
      registry,
      legacy: null,
      secrets: {},
      logger: logger(),
      build: fakeBuild,
    });
    expect(await without.current("text")).toBeNull();
  });

  it("un cambio en el registro llega sin reiniciar, pasado el TTL", async () => {
    const registry = new MutableRegistry();
    let t = 0;
    const log = logger();
    const source = createLlmSource({
      registry,
      legacy: LEGACY,
      secrets: {},
      logger: log,
      ttlMs: 1000,
      nowMs: () => t,
      build: fakeBuild,
    });

    const first = await source.current("text");
    expect(first && modelOf(first.llm)).toBe("env-model");

    registry.snapshot = { tasks: { text: OLLAMA } };
    t = 500;
    const cached = await source.current("text");
    expect(cached && modelOf(cached.llm)).toBe("env-model");

    t = 1500;
    const fresh = await source.current("text");
    expect(fresh && modelOf(fresh.llm)).toBe("qwen2.5:7b-instruct");
    expect(fresh?.config.source).toBe("registry");

    // Se anuncia una vez por cambio, y nunca con la key.
    const inUse = log.lines.filter((l) => l.msg === "LLM en uso");
    expect(inUse).toHaveLength(2);
    expect(JSON.stringify(log.lines)).not.toContain("env-key");
  });

  it("un registro que no se puede leer no apaga el LLM que andaba", async () => {
    const registry = new MutableRegistry();
    registry.snapshot = { tasks: { text: OLLAMA } };
    let t = 0;
    const log = logger();
    const source = createLlmSource({
      registry,
      legacy: null,
      secrets: {},
      logger: log,
      ttlMs: 10,
      nowMs: () => t,
      build: fakeBuild,
    });
    expect((await source.current("text"))?.config.model).toBe("qwen2.5:7b-instruct");

    registry.failWith = new Error("The model registry file is not valid JSON");
    t = 100;
    expect((await source.current("text"))?.config.model).toBe("qwen2.5:7b-instruct");
    t = 200;
    await source.current("text");
    expect(log.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });
});

describe("buildLlm", () => {
  it("con config del registro usa base + /chat/completions (Gemini) y no manda Bearer vacío", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      seen.push({ url, headers: init.headers });
      return Promise.resolve(
        new Response(
          JSON.stringify({ model: "m", choices: [{ message: { content: "hola" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };

    const gemini = buildLlm(
      {
        source: "registry",
        entry: "text",
        provider: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
        apiKey: "k",
        model: "m",
        contextWindowTokens: 1000,
      },
      fetchImpl,
    );
    await gemini.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(seen[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(seen[0]?.headers["Authorization"]).toBe("Bearer k");

    const local = buildLlm(
      {
        source: "registry",
        entry: "text",
        provider: "ollama",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "",
        model: "m",
        contextWindowTokens: 1000,
      },
      fetchImpl,
    );
    await local.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(seen[1]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(seen[1]?.headers["Authorization"]).toBeUndefined();
  });

  it("con las LLM_* no toca la URL: la normalización del adaptador de siempre", async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = (url) => {
      seen.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
        }),
      );
    };
    await buildLlm(
      { ...LEGACY, source: "env", entry: null, provider: null },
      fetchImpl,
    ).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(seen[0]).toBe("https://gateway.example/v1/chat/completions");
  });
});

describe("createResolvingLlm", () => {
  it("sin LLM configurado falla con provider_unavailable, que es reintentable", async () => {
    const source = createLlmSource({
      registry: new MutableRegistry(),
      legacy: null,
      secrets: {},
      logger: logger(),
      build: fakeBuild,
    });
    const error = await createResolvingLlm(source, "text")
      .complete({ messages: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("provider_unavailable");
    expect(isPortError(error) && error.isRetryable).toBe(true);
  });
});
