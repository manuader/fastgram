/**
 * ComfyUI de punta a punta en la API (`PU-LATER-003`), sin base y **sin
 * dobles del adaptador**: el registro es el archivo real en un directorio
 * temporal, el cliente es `ComfyUiClient` de verdad (por `createGenClient`), y
 * del otro lado hay un servidor HTTP local de prueba que contesta lo que
 * documenta https://docs.comfy.org/development/comfyui-server/comms_routes.
 *
 * Lo que fija: guardar un workflow (y sus errores con `details.field`),
 * «Test connection» = `GET /system_stats`, y que AI Studio lo ofrezca con
 * costo 0 que no consume el tope.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  aiStudioOptionsSchema,
  generationEstimateSchema,
  modelConnectionTestSchema,
  modelTaskConfigSchema,
} from "@fastgram/contracts";
import {
  FileModelRegistry,
  FixedClock,
  JsonFileCollection,
  JsonFileDocument,
  createGenClient,
  isGenProvider,
} from "@fastgram/adapters";
import type { ResolvedGenAiConfig } from "@fastgram/core";
import type { ModelCatalog } from "@fastgram/ports";

import { registerErrorHandler } from "../../plugins/error-handler.js";
import type { ZodApp } from "../../server/types.js";
import { registerAiStudioRoutes } from "./ai-studio.js";
import { registerGenAiRoutes } from "./genai.js";
import { registerModelRoutes } from "./models.js";

const catalogUnused: ModelCatalog = {
  listModels: () => Promise.reject(new Error("an LLM catalog must not be called")),
  testConnection: () => Promise.reject(new Error("an LLM catalog must not be called")),
};

const WORKFLOW = {
  "4": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "sd15.safetensors" },
  },
  pos: { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["4", 1] } },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: 512, height: 512, batch_size: 1 },
  },
  k: { class_type: "KSampler", inputs: { seed: 1, positive: ["pos", 0] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["k", 0] } },
};

const COMFY = {
  workflow: WORKFLOW,
  prompt: { nodeId: "pos", input: "text" },
  width: { nodeId: "5", input: "width" },
  height: { nodeId: "5", input: "height" },
  seed: { nodeId: "k", input: "seed" },
};

let dir: string;
let app: ZodApp;
let comfy: Server;
let comfyBase: string;
let hits: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastgram-comfyui-route-"));
  hits = [];
  comfy = createServer((req, res) => {
    hits.push(`${req.method ?? ""} ${req.url ?? ""}`);
    if (req.url === "/system_stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          system: { os: "posix", comfyui_version: "0.3.60" },
          devices: [{ name: "cpu", type: "cpu", index: 0 }],
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("404: Not Found");
  });
  await new Promise<void>((resolve) => comfy.listen(0, "127.0.0.1", resolve));
  comfyBase = `http://127.0.0.1:${String((comfy.address() as AddressInfo).port)}`;

  const env: Record<string, string | undefined> = {};
  const raw = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  raw.setValidatorCompiler(validatorCompiler);
  raw.setSerializerCompiler(serializerCompiler);
  raw.decorate("deps", {
    clock: new FixedClock(new Date("2026-09-24T12:00:00Z")),
  } as never);
  registerErrorHandler(raw);
  app = raw as unknown as ZodApp;
  const registry = new FileModelRegistry({ path: join(dir, "models.json") });
  registerModelRoutes(app, {
    registry,
    catalog: catalogUnused,
    env,
    genClientFor: (c) => createGenClient({ ...c, timeoutMs: 2000 }),
  });
  const genaiDeps = {
    registry,
    ledger: new JsonFileDocument(join(dir, "spend.json")),
    generations: new JsonFileCollection(join(dir, "ai-studio")),
    env,
    clientFor: (c: ResolvedGenAiConfig) => {
      if (!isGenProvider(c.provider)) throw new Error("no adapter");
      return createGenClient({
        provider: c.provider,
        baseUrl: c.baseUrl,
        apiKey: c.apiKey,
        task: c.task,
        model: c.model,
        timeoutMs: 2000,
        ...(c.comfyWorkflow === undefined ? {} : { comfyWorkflow: c.comfyWorkflow }),
      });
    },
  };
  registerGenAiRoutes(app, genaiDeps);
  registerAiStudioRoutes(app, genaiDeps);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await new Promise<void>((resolve) => comfy.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const data = (res: { body: string }): unknown =>
  (JSON.parse(res.body) as { data: unknown }).data;

describe("PUT /models/image con ComfyUI", () => {
  it("guarda el workflow en models.json (sin key) y lo devuelve para editarlo", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/models/image",
      payload: {
        provider: "comfyui",
        baseUrl: comfyBase,
        model: "sd15-basic",
        comfyWorkflow: COMFY,
      },
    });
    expect(res.statusCode).toBe(200);
    const view = modelTaskConfigSchema.parse(data(res));
    expect(view).toMatchObject({
      status: "ready",
      provider: "comfyui",
      model: "sd15-basic",
    });
    expect(view.comfyWorkflow).toEqual(COMFY);

    const file = JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as {
      tasks: { image: { comfyWorkflow: unknown; apiKey?: string } };
    };
    expect(file.tasks.image.comfyWorkflow).toEqual(COMFY);
    expect(file.tasks.image.apiKey).toBeUndefined();
  });

  it("sin workflow, o con un nodo que no está → 400 con field comfyWorkflow", async () => {
    const none = await app.inject({
      method: "PUT",
      url: "/models/image",
      payload: { provider: "comfyui", model: "x" },
    });
    expect(none.statusCode).toBe(400);
    expect(JSON.parse(none.body)).toMatchObject({
      error: { code: "bad_request", details: { field: "comfyWorkflow" } },
    });

    const missing = await app.inject({
      method: "PUT",
      url: "/models/image",
      payload: {
        provider: "comfyui",
        model: "x",
        comfyWorkflow: { ...COMFY, prompt: { nodeId: "nope", input: "text" } },
      },
    });
    expect(missing.statusCode).toBe(400);
    const body = JSON.parse(missing.body) as { error: { message: string } };
    expect(body.error.message).toContain("nope");
  });

  it("el formato del editor se rechaza pidiendo el de API", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/models/image",
      payload: {
        provider: "comfyui",
        model: "x",
        comfyWorkflow: {
          workflow: { nodes: [], links: [], version: 0.4 },
          prompt: { nodeId: "1", input: "text" },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(
      (JSON.parse(res.body) as { error: { message: string } }).error.message,
    ).toMatch(/API format/);
  });
});

describe("POST /models/test con ComfyUI", () => {
  it("contra el servidor de prueba: GET /system_stats, sin key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: { task: "image", provider: "comfyui", baseUrl: comfyBase },
    });
    expect(res.statusCode).toBe(200);
    const result = modelConnectionTestSchema.parse(data(res));
    expect(result.ok).toBe(true);
    expect(result.completion).toMatchObject({ ok: true });
    expect(hits).toEqual(["GET /system_stats"]);
  });

  it("servidor caído → ok:false provider_unavailable (200, no un 5xx)", async () => {
    await new Promise<void>((resolve) => comfy.close(() => resolve()));
    const res = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: { task: "image", provider: "comfyui", baseUrl: comfyBase, model: "x" },
    });
    expect(res.statusCode).toBe(200);
    const result = modelConnectionTestSchema.parse(data(res));
    expect(result.ok).toBe(false);
    expect(result.completion).toMatchObject({
      ok: false,
      error: { code: "provider_unavailable" },
    });
    comfy = createServer();
    await new Promise<void>((resolve) => comfy.listen(0, "127.0.0.1", resolve));
  });
});

describe("AI Studio con un workflow de ComfyUI", () => {
  it("lo ofrece como modelo de imagen y estima 0 que entra aunque el tope sea 0", async () => {
    await app.inject({
      method: "PUT",
      url: "/models/image",
      payload: {
        provider: "comfyui",
        baseUrl: comfyBase,
        model: "sd15-basic",
        comfyWorkflow: COMFY,
      },
    });
    await app.inject({ method: "PUT", url: "/models/budget", payload: { budgetUsd: 0 } });

    const options = aiStudioOptionsSchema.parse(
      data(await app.inject({ method: "GET", url: "/ai-studio/options" })),
    );
    expect(options.image).toMatchObject({
      configured: true,
      provider: "comfyui",
      defaultModel: "sd15-basic",
    });
    expect(options.image.models.map((m) => m.id)).toEqual(["sd15-basic"]);

    const res = await app.inject({
      method: "POST",
      url: "/ai-studio/estimate",
      payload: { kind: "image", prompt: "a fox", aspectRatio: "4:5", count: 1 },
    });
    expect(res.statusCode).toBe(200);
    const estimate = generationEstimateSchema.parse(data(res));
    expect(estimate.estimate.usd).toBe(0);
    expect(estimate.fits).toBe(true);
    // Estimar no toca ComfyUI.
    expect(hits).toEqual([]);
  });
});
