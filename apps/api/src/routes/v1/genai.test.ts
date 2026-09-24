/**
 * Settings → Models para imagen y video (`PU-MODEL-003`/`004`) y el tope
 * mensual (`PU-MODEL-005`), montados solos y sin base: el registro y el libro
 * de gasto son archivos reales en un directorio temporal, y el proveedor es un
 * doble. Ninguna llamada a Higgsfield ni a fal.
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
  budgetSummarySchema,
  genAspectRatioSchema,
  generationErrorCodeSchema,
  generationStatusSchema,
  modelConnectionTestSchema,
  modelsOverviewSchema,
  providerModelsSchema,
} from "@fastgram/contracts";
import {
  FileModelRegistry,
  FixedClock,
  JsonFileCollection,
  JsonFileDocument,
  type GenClient,
} from "@fastgram/adapters";
import { GENERATION_ERROR_CODES, GENERATION_STATUSES } from "@fastgram/core";
import { GEN_ASPECT_RATIOS, PortError, type ModelCatalog } from "@fastgram/ports";

import { registerErrorHandler } from "../../plugins/error-handler.js";
import type { ZodApp } from "../../server/types.js";
import { registerGenAiRoutes } from "./genai.js";
import { registerModelRoutes } from "./models.js";

const HF_KEY = "hf-key-id-123:hf-secret-456789";

const catalogUnused: ModelCatalog = {
  listModels: () => Promise.reject(new Error("an LLM catalog must not be called")),
  testConnection: () => Promise.reject(new Error("an LLM catalog must not be called")),
};

let dir: string;
let app: ZodApp;
let env: Record<string, string | undefined>;
let checked: { provider: string; apiKey: string; model: string }[];
let checkFails: PortError | null;

function fakeClient(provider: string, apiKey: string): GenClient {
  return {
    provider,
    models: () => [],
    poll: () => Promise.reject(new Error("unused")),
    estimateImage: () => Promise.reject(new Error("unused")),
    estimateVideo: () => Promise.reject(new Error("unused")),
    generateImage: () => Promise.reject(new Error("unused")),
    generateVideo: () => Promise.reject(new Error("unused")),
    checkCredentials: (model: string) => {
      checked.push({ provider, apiKey, model });
      return checkFails === null
        ? Promise.resolve({ latencyMs: 5, probe: "estimate endpoint" })
        : Promise.reject(checkFails);
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastgram-genai-route-"));
  env = {};
  checked = [];
  checkFails = null;
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
    genClientFor: (c) => fakeClient(c.provider, c.apiKey),
  });
  registerGenAiRoutes(app, {
    registry,
    ledger: new JsonFileDocument(join(dir, "spend.json")),
    generations: new JsonFileCollection(join(dir, "ai-studio")),
    env,
    clientFor: (c) => fakeClient(c.provider, c.apiKey),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const data = (res: { body: string }): unknown =>
  (JSON.parse(res.body) as { data: unknown }).data;

describe("los enums del contrato son los de core/ports", () => {
  it("relaciones, estados y códigos de error", () => {
    expect([...genAspectRatioSchema.options]).toEqual([...GEN_ASPECT_RATIOS]);
    expect([...generationStatusSchema.options]).toEqual([...GENERATION_STATUSES]);
    expect([...generationErrorCodeSchema.options]).toEqual([...GENERATION_ERROR_CODES]);
  });
});

describe("Settings → Models: imagen y video", () => {
  it("image y video son `genai`, están en uso y sólo aceptan Higgsfield, fal o ComfyUI", async () => {
    const res = await app.inject({ method: "GET", url: "/models" });
    const overview = modelsOverviewSchema.parse(data(res));
    for (const task of ["image", "video"] as const) {
      const t = overview.tasks.find((x) => x.task === task);
      expect(t).toMatchObject({
        kind: "genai",
        wired: true,
        providers: ["higgsfield", "fal", "comfyui"],
      });
    }
    expect(overview.providers.find((p) => p.id === "higgsfield")?.baseUrl).toBe(
      "https://api.higgsfield.ai",
    );
    // Un LLM no ofrece los de generación.
    expect(overview.tasks.find((t) => t.task === "text")?.providers).not.toContain("fal");
  });

  it("la lista es el catálogo verificado, sin red, filtrado por la tarea", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/models/providers/fal/models?task=video",
    });
    expect(res.statusCode).toBe(200);
    const listed = providerModelsSchema.parse(data(res));
    expect(listed.result.ok).toBe(true);
    const ids = listed.result.ok ? listed.result.models.map((m) => m.id) : [];
    expect(ids).toContain("fal-ai/wan/v2.2-a14b/text-to-video");
    expect(ids).not.toContain("fal-ai/flux/schnell");
  });

  it("guardar un id fuera del catálogo es 400 en `model`; uno del catálogo se guarda sin devolver la key", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/models/video",
      payload: { provider: "higgsfield", model: "made/up/model", apiKey: HF_KEY },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({
      error: { details: { field: "model" } },
    });

    const ok = await app.inject({
      method: "PUT",
      url: "/models/video",
      payload: {
        provider: "higgsfield",
        model: "kling-video/v2.6/pro/text-to-video",
        apiKey: HF_KEY,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain("hf-secret");
    expect(data(ok)).toMatchObject({
      status: "ready",
      apiKey: { hasKey: true, last4: "6789" },
    });
  });

  it("Higgsfield sin el formato KEY_ID:KEY_SECRET es 400 en apiKey", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/models/image",
      payload: {
        provider: "higgsfield",
        model: "z-image/turbo",
        apiKey: "just-an-id-1234",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      error: { details: { field: "apiKey" } },
    });
  });

  it("Test connection llama a checkCredentials del adaptador (no al catálogo de LLM)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: {
        task: "image",
        provider: "higgsfield",
        baseUrl: "",
        apiKey: HF_KEY,
        model: "z-image/turbo",
      },
    });
    const result = modelConnectionTestSchema.parse(data(res));
    expect(result).toMatchObject({
      ok: true,
      keySource: "provided",
      completion: { ok: true },
    });
    expect(checked).toEqual([
      { provider: "higgsfield", apiKey: HF_KEY, model: "z-image/turbo" },
    ]);
    expect(res.body).not.toContain("hf-secret");
  });

  it("credencial rechazada = 200 con ok:false y el código estable, nunca un 401", async () => {
    checkFails = new PortError("unauthorized", "Higgsfield rejected the credentials", {
      source: "test",
      cause: "HTTP 401: Invalid credentials",
    });
    const res = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: {
        provider: "fal",
        baseUrl: "",
        apiKey: "fal-k",
        model: "fal-ai/flux/schnell",
      },
    });
    expect(res.statusCode).toBe(200);
    const result = modelConnectionTestSchema.parse(data(res));
    expect(result.ok).toBe(false);
    expect(result.completion).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  });

  it("sin key ni guardada: no se llama al proveedor", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/models/test",
      payload: { provider: "fal", baseUrl: "", model: "fal-ai/flux/schnell" },
    });
    expect(modelConnectionTestSchema.parse(data(res)).ok).toBe(false);
    expect(checked).toEqual([]);
  });
});

describe("GET/PUT /models/budget", () => {
  it("instalación nueva: tope 30 (default), nada gastado, mes UTC", async () => {
    const res = await app.inject({ method: "GET", url: "/models/budget" });
    expect(budgetSummarySchema.parse(data(res))).toEqual({
      month: "2026-09",
      budgetUsd: 30,
      budgetSource: "default",
      chargedUsd: 0,
      reservedUsd: 0,
      remainingUsd: 30,
      generations: 0,
    });
  });

  it("el entorno cambia el default; Settings le gana; null vuelve al entorno", async () => {
    env["FASTGRAM_MONTHLY_BUDGET_USD"] = "45";
    const fromEnv = await app.inject({ method: "GET", url: "/models/budget" });
    expect(data(fromEnv)).toMatchObject({ budgetUsd: 45, budgetSource: "env" });

    const put = await app.inject({
      method: "PUT",
      url: "/models/budget",
      payload: { budgetUsd: 20 },
    });
    expect(put.statusCode).toBe(200);
    expect(data(put)).toMatchObject({ budgetUsd: 20, budgetSource: "settings" });

    const cleared = await app.inject({
      method: "PUT",
      url: "/models/budget",
      payload: { budgetUsd: null },
    });
    expect(data(cleared)).toMatchObject({ budgetUsd: 45, budgetSource: "env" });
  });

  it("montos inválidos: 400", async () => {
    for (const budgetUsd of [-1, 10.001, 1_000_000]) {
      const res = await app.inject({
        method: "PUT",
        url: "/models/budget",
        payload: { budgetUsd },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
