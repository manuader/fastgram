/**
 * `routes/v1/models.ts` montado solo, sin base: el registro es un archivo en un
 * directorio temporal (el adaptador real) y el proveedor es un doble.
 *
 * Lo que fijan estos casos es lo que no se ve en los tipos: que **ninguna
 * respuesta lleva la key**, que la key guardada no se presta a otro host, y que
 * un fallo del proveedor viaja como `ok: false` y no como un 401 que el cliente
 * web leería como sesión vencida.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  modelConnectionTestSchema,
  modelProviderSchema,
  modelTaskConfigSchema,
  modelTaskSchema,
  modelsOverviewSchema,
  providerModelsSchema,
} from "@fastgram/contracts";
import { FileModelRegistry, FixedClock } from "@fastgram/adapters";
import {
  MODEL_PROVIDERS,
  MODEL_TASKS,
  PortError,
  type ListedModel,
  type ModelCatalog,
  type ModelEndpoint,
} from "@fastgram/ports";

import { registerErrorHandler } from "../../plugins/error-handler.js";
import type { ZodApp } from "../../server/types.js";
import { registerModelRoutes } from "./models.js";

const KEY = "sk-or-v1-supersecret-abcdef123456";

interface CatalogCall {
  readonly kind: "list" | "test";
  readonly endpoint: ModelEndpoint & { model?: string };
}

class FakeCatalog implements ModelCatalog {
  readonly calls: CatalogCall[] = [];
  listResult: readonly ListedModel[] | PortError = [
    { id: "b-model" },
    { id: "a-model", contextWindowTokens: 8192 },
  ];
  testResult: PortError | null = null;

  listModels(endpoint: ModelEndpoint): Promise<readonly ListedModel[]> {
    this.calls.push({ kind: "list", endpoint });
    return this.listResult instanceof PortError
      ? Promise.reject(this.listResult)
      : Promise.resolve(this.listResult);
  }

  testConnection(endpoint: ModelEndpoint & { model: string }) {
    this.calls.push({ kind: "test", endpoint });
    if (this.testResult !== null) return Promise.reject(this.testResult);
    return Promise.resolve({ model: endpoint.model, latencyMs: 12 });
  }
}

let dir: string;
let catalog: FakeCatalog;
let registry: FileModelRegistry;
let env: Record<string, string | undefined>;
let app: ZodApp;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastgram-models-route-"));
  catalog = new FakeCatalog();
  registry = new FileModelRegistry({ path: join(dir, "models.json") });
  env = {};
  const raw = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  raw.setValidatorCompiler(validatorCompiler);
  raw.setSerializerCompiler(serializerCompiler);
  // Sólo `clock` lo usa esta ruta; el resto de `ApiDeps` no aplica.
  raw.decorate("deps", {
    clock: new FixedClock(new Date("2026-09-24T12:00:00Z")),
  } as never);
  registerErrorHandler(raw);
  app = raw as unknown as ZodApp;
  registerModelRoutes(app, { registry, catalog, env });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const body = (res: { body: string }): unknown =>
  (JSON.parse(res.body) as { data: unknown }).data;

describe("los enums del contrato son los del puerto", () => {
  it("tareas y proveedores", () => {
    expect([...modelTaskSchema.options]).toEqual([...MODEL_TASKS]);
    expect([...modelProviderSchema.options]).toEqual([...MODEL_PROVIDERS]);
  });
});

describe("GET /models", () => {
  it("una instalación nueva: todo unset, y los presets sin ningún modelo", async () => {
    const res = await app.inject({ method: "GET", url: "/models" });
    expect(res.statusCode).toBe(200);
    const overview = modelsOverviewSchema.parse(body(res));
    expect(overview.tasks.map((t) => t.status)).toEqual(MODEL_TASKS.map(() => "unset"));
    expect(overview.providers.find((p) => p.id === "deepseek")?.baseUrl).toBeNull();
    expect(res.body).not.toMatch(/"model":"[^"]/);
  });

  it("con las LLM_* del entorno, text y judgment dicen que corren con ellas", async () => {
    Object.assign(env, {
      LLM_BASE_URL: "https://g.example/v1",
      LLM_API_KEY: KEY,
      LLM_MODEL: "env-model",
      LLM_CONTEXT_WINDOW_TOKENS: "8192",
    });
    const res = await app.inject({ method: "GET", url: "/models" });
    const overview = modelsOverviewSchema.parse(body(res));
    const text = overview.tasks.find((t) => t.task === "text");
    expect(text).toMatchObject({ source: "env", status: "ready", model: "env-model" });
    expect(res.body).not.toContain(KEY);
  });
});

describe("PUT /models/:task", () => {
  it("guarda, y ninguna respuesta devuelve la key", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/models/text",
      payload: {
        provider: "openrouter",
        model: "vendor/some-model",
        apiKey: KEY,
        contextWindowTokens: 32000,
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(KEY);
    const saved = modelTaskConfigSchema.parse(body(put));
    expect(saved).toMatchObject({
      status: "ready",
      source: "registry",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: { hasKey: true, last4: "3456", source: "file" },
    });

    const get = await app.inject({ method: "GET", url: "/models" });
    expect(get.body).not.toContain(KEY);
    const judgment = modelsOverviewSchema
      .parse(body(get))
      .tasks.find((t) => t.task === "judgment");
    expect(judgment).toMatchObject({ inheritsFrom: "text", status: "ready" });

    // El archivo sí la tiene: es donde vive.
    expect((await registry.read()).tasks.text?.apiKey).toBe(KEY);
  });

  it("400 con el campo, y 404 para una tarea que no existe", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/models/text",
      payload: { provider: "deepseek", model: "m" },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({
      error: { code: "bad_request", details: { field: "baseUrl" } },
    });

    const missing = await app.inject({
      method: "PUT",
      url: "/models/music",
      payload: { provider: "custom", baseUrl: "https://x.example", model: "m" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("una tarea reservada sólo acepta custom", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/models/video",
      payload: { provider: "groq", model: "m" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /models/test", () => {
  it("lista y prueba con la key que vino, sin devolverla", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: {
        provider: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: KEY,
        model: "a-model",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(KEY);
    const result = modelConnectionTestSchema.parse(body(res));
    expect(result).toMatchObject({
      ok: true,
      keySource: "provided",
      completion: { ok: true, model: "a-model" },
    });
    expect(catalog.calls.map((c) => c.endpoint.apiKey)).toEqual([KEY, KEY]);
  });

  it("un 401 del proveedor es ok:false con código estable, no un 401 de esta API", async () => {
    catalog.listResult = new PortError(
      "unauthorized",
      "The model provider rejected the API key",
      {
        source: "test",
        cause: `leaked ${KEY}`,
      },
    );
    const res = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: {
        provider: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: "x",
      },
    });
    expect(res.statusCode).toBe(200);
    const result = modelConnectionTestSchema.parse(body(res));
    expect(result).toMatchObject({
      ok: false,
      models: { ok: false, error: { code: "unauthorized" } },
      completion: null,
    });
    expect(res.body).not.toContain(KEY);
  });

  it("usa la key guardada sólo contra el mismo origen", async () => {
    await registry.write("text", {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "m",
      apiKey: KEY,
    });

    await app.inject({
      method: "POST",
      url: "/models/test",
      payload: {
        task: "text",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
    });
    expect(catalog.calls.at(-1)?.endpoint.apiKey).toBe(KEY);

    const other = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: {
        task: "text",
        provider: "custom",
        baseUrl: "https://attacker.example/v1",
      },
    });
    expect(modelConnectionTestSchema.parse(body(other)).keySource).toBe("none");
    expect(catalog.calls.at(-1)?.endpoint.apiKey).toBeUndefined();
  });

  it("400 con una base URL con credenciales adentro", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: { provider: "custom", baseUrl: "https://u:p@x.example/v1" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /models/providers/:provider/models", () => {
  it("usa la base del preset y devuelve la lista", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/models/providers/ollama/models",
    });
    expect(res.statusCode).toBe(200);
    const listed = providerModelsSchema.parse(body(res));
    expect(listed).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      keySource: "none",
      result: { ok: true },
    });
  });

  it("DeepSeek sin base URL es 400; un proveedor inexistente, 404", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/models/providers/deepseek/models" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/models/providers/nope/models" }))
        .statusCode,
    ).toBe(404);
  });
});

/* ------------------------------------------------------------------------ *
 * Sprint 9 (O, D-18): Laya y Jev (SystemOne)
 * ------------------------------------------------------------------------ */

describe("SystemOne (Laya, Jev)", () => {
  async function withProbe(
    probe: (config: {
      provider: string;
      baseUrl: string;
      apiKey: string;
      model: string;
    }) => Promise<{ model: string; latencyMs: number }>,
  ): Promise<ZodApp> {
    await app.close();
    const raw = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    raw.setValidatorCompiler(validatorCompiler);
    raw.setSerializerCompiler(serializerCompiler);
    raw.decorate("deps", {
      clock: new FixedClock(new Date("2026-09-28T12:00:00Z")),
    } as never);
    registerErrorHandler(raw);
    app = raw as unknown as ZodApp;
    registerModelRoutes(app, { registry, catalog, env, systemOneProbe: probe });
    await app.ready();
    return app;
  }

  it("los presets proponen el modelo del catálogo; judgment.assets acepta Laya", async () => {
    const res = await app.inject({ method: "GET", url: "/models" });
    const overview = modelsOverviewSchema.parse(body(res));
    expect(overview.providers.find((p) => p.id === "laya")).toMatchObject({
      baseUrl: "http://127.0.0.1:3006",
      requiresKey: false,
      defaultModel: "auto",
    });
    expect(overview.providers.find((p) => p.id === "typesafe")?.defaultModel).toBe(
      "jev-latest",
    );
    const assets = overview.tasks.find((t) => t.task === "judgment.assets");
    expect(assets?.providers).toContain("laya");
    expect(overview.tasks.find((t) => t.task === "text")?.providers).not.toContain(
      "laya",
    );
  });

  it("guardar Laya en judgment.assets: ready, sin ventana; un modelo inventado es 400", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/models/judgment.assets",
      payload: { provider: "laya", model: "gpt-9" },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: "PUT",
      url: "/models/judgment.assets",
      payload: { provider: "laya", model: "auto", contextWindowTokens: 4096 },
    });
    expect(ok.statusCode).toBe(200);
    const view = modelTaskConfigSchema.parse(body(ok));
    expect(view).toMatchObject({
      status: "ready",
      provider: "laya",
      model: "auto",
      contextWindowTokens: null,
      missing: [],
    });
  });

  it("probar Laya: catálogo + la prueba del adaptador; sin tocar el catálogo OpenAI", async () => {
    const seen: string[] = [];
    await withProbe(async (c) => {
      seen.push(
        `${c.provider} ${c.baseUrl} ${c.model} key=${c.apiKey === "" ? "none" : "yes"}`,
      );
      return { model: "laya-rl-agent/english", latencyMs: 42 };
    });
    const res = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: { task: "judgment.assets", provider: "laya", baseUrl: "" },
    });
    const result = modelConnectionTestSchema.parse(body(res));
    expect(result.ok).toBe(true);
    expect(result.completion).toEqual({
      ok: true,
      model: "laya-rl-agent/english",
      latencyMs: 42,
    });
    expect(result.models.ok && result.models.models.map((m) => m.id)).toEqual([
      "auto",
      "english",
      "multilingual",
      "typed-decisions",
    ]);
    expect(seen).toEqual(["laya http://127.0.0.1:3006 auto key=none"]);
    expect(catalog.calls).toHaveLength(0);
  });

  it("Laya caído: ok:false con código estable", async () => {
    await withProbe(async () => {
      throw new PortError("provider_unavailable", "Laya is not answering", {
        source: "Judgment/laya",
      });
    });
    const res = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: { provider: "laya", baseUrl: "http://127.0.0.1:3006", model: "auto" },
    });
    expect(res.statusCode).toBe(200);
    const result = modelConnectionTestSchema.parse(body(res));
    expect(result.ok).toBe(false);
    expect(result.completion).toMatchObject({
      ok: false,
      error: { code: "provider_unavailable" },
    });
  });

  it("Jev sin key: no se llama, unauthorized", async () => {
    let called = false;
    await withProbe(async () => {
      called = true;
      return { model: "x", latencyMs: 1 };
    });
    const res = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: { provider: "typesafe", baseUrl: "" },
    });
    const result = modelConnectionTestSchema.parse(body(res));
    expect(result.completion).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
    expect(called).toBe(false);
  });

  it("la lista de modelos de un SystemOne es el catálogo", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/models/providers/typesafe/models",
    });
    const result = providerModelsSchema.parse(body(res));
    expect(result.result).toEqual({
      ok: true,
      models: [{ id: "jev-latest", ownedBy: "Jev (latest)" }],
    });
  });
});
