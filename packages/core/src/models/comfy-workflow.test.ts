/**
 * ComfyUI en el registro de modelos — `PU-LATER-003`: validar el workflow,
 * guardarlo por `applyTaskUpdate`, resolverlo sin key y que no consuma tope.
 */
import { describe, expect, it } from "vitest";
import type { ComfyWorkflowConfig, ModelRegistrySnapshot } from "@fastgram/ports";

import { budgetSummary, EMPTY_SPEND_LEDGER, fitsBudget } from "../genai/budget.js";
import { checkGenerationInput } from "../genai/request.js";
import { checkComfyApiWorkflow, checkComfyWorkflowConfig } from "./comfy-workflow.js";
import { applyTaskUpdate, resolveGenAiConfig, toPublicTaskConfig } from "./config.js";
import { providerPreset, taskSpec } from "./presets.js";

const NOW = "2026-09-24T12:00:00.000Z";

const WORKFLOW = {
  a1: { class_type: "CLIPTextEncode", inputs: { text: "hi", clip: ["ck", 1] } },
  lat: {
    class_type: "EmptyLatentImage",
    inputs: { width: 512, height: 768, batch_size: 1 },
  },
  ks: { class_type: "KSampler", inputs: { seed: 7, positive: ["a1", 0] } },
};

const CONFIG: ComfyWorkflowConfig = {
  workflow: WORKFLOW,
  prompt: { nodeId: "a1", input: "text" },
  width: { nodeId: "lat", input: "width" },
  height: { nodeId: "lat", input: "height" },
  seed: { nodeId: "ks", input: "seed" },
};

describe("preset de ComfyUI", () => {
  it("local, sin key, en 127.0.0.1:8188 y disponible para imagen y video", () => {
    expect(providerPreset("comfyui")).toMatchObject({
      baseUrl: "http://127.0.0.1:8188",
      requiresKey: false,
      local: true,
    });
    expect(taskSpec("image").providers).toContain("comfyui");
    expect(taskSpec("video").providers).toContain("comfyui");
    expect(taskSpec("text").providers).not.toContain("comfyui");
  });
});

describe("checkComfyWorkflowConfig", () => {
  it("acepta un workflow en formato API con ids arbitrarios", () => {
    const r = checkComfyWorkflowConfig("image", CONFIG);
    expect(r.ok).toBe(true);
  });

  it("reconoce el formato del editor y pide el de API", () => {
    expect(checkComfyApiWorkflow({ nodes: [], links: [], version: 0.4 })).toMatch(
      /API format/,
    );
    expect(checkComfyApiWorkflow({ "1": { inputs: {} } })).toMatch(/class_type/);
    expect(checkComfyApiWorkflow({})).toMatch(/no nodes/);
  });

  it("rechaza un nodo o input que no está, un link y un tipo equivocado", () => {
    const at = (patch: Partial<ComfyWorkflowConfig>) =>
      checkComfyWorkflowConfig("image", { ...CONFIG, ...patch });
    expect(at({ prompt: { nodeId: "zz", input: "text" } })).toMatchObject({ ok: false });
    expect(at({ prompt: { nodeId: "a1", input: "nope" } })).toMatchObject({ ok: false });
    const link = at({ prompt: { nodeId: "a1", input: "clip" } });
    expect(link.ok === false && link.message).toMatch(/wired/);
    const type = at({ seed: { nodeId: "a1", input: "text" } });
    expect(type.ok === false && type.message).toMatch(/not a number/);
  });

  it("width sin height no; imagen de entrada sólo en video; video pide duración", () => {
    const { height: _h, ...noHeight } = CONFIG;
    expect(checkComfyWorkflowConfig("image", noHeight).ok).toBe(false);
    const withImage: ComfyWorkflowConfig = {
      ...CONFIG,
      workflow: {
        ...WORKFLOW,
        li: { class_type: "LoadImage", inputs: { image: "x.png" } },
      },
      image: { nodeId: "li", input: "image" },
    };
    expect(checkComfyWorkflowConfig("image", withImage).ok).toBe(false);
    expect(checkComfyWorkflowConfig("video", withImage).ok).toBe(false);
    const video = checkComfyWorkflowConfig("video", { ...withImage, durationSeconds: 5 });
    expect(video.ok).toBe(true);
  });
});

describe("applyTaskUpdate con comfyui", () => {
  it("guarda el workflow; sin workflow es error de campo; otro proveedor no lo lleva", () => {
    const saved = applyTaskUpdate(
      "image",
      undefined,
      { provider: "comfyui", model: "sd15", comfyWorkflow: CONFIG },
      NOW,
    );
    expect(saved.ok && saved.config).toMatchObject({
      provider: "comfyui",
      baseUrl: "http://127.0.0.1:8188",
      model: "sd15",
      comfyWorkflow: CONFIG,
    });

    const missing = applyTaskUpdate(
      "image",
      undefined,
      { provider: "comfyui", model: "x" },
      NOW,
    );
    expect(missing).toMatchObject({ ok: false, field: "comfyWorkflow" });

    // Ausente = se conserva el guardado.
    if (!saved.ok) throw new Error("unreachable");
    const kept = applyTaskUpdate(
      "image",
      saved.config,
      { provider: "comfyui", model: "renamed" },
      NOW,
    );
    expect(kept.ok && kept.config.comfyWorkflow).toEqual(CONFIG);

    const bad = applyTaskUpdate(
      "image",
      undefined,
      {
        provider: "comfyui",
        model: "x",
        comfyWorkflow: { ...CONFIG, prompt: { nodeId: "zz", input: "text" } },
      },
      NOW,
    );
    expect(bad).toMatchObject({ ok: false, field: "comfyWorkflow" });

    const fal = applyTaskUpdate(
      "image",
      saved.config,
      { provider: "fal", model: "fal-ai/flux/schnell", apiKey: "k-1234567890abcd" },
      NOW,
    );
    expect(fal.ok && fal.config.comfyWorkflow).toBeUndefined();
  });

  it("comfyui no sirve para texto", () => {
    const r = applyTaskUpdate(
      "text",
      undefined,
      { provider: "comfyui", model: "x", comfyWorkflow: CONFIG },
      NOW,
    );
    expect(r).toMatchObject({ ok: false, field: "provider" });
  });
});

describe("resolveGenAiConfig y la vista pública con comfyui", () => {
  const snapshot: ModelRegistrySnapshot = {
    tasks: {
      image: {
        provider: "comfyui",
        baseUrl: "http://127.0.0.1:8188",
        model: "sd15",
        comfyWorkflow: CONFIG,
      },
    },
  };

  it("se resuelve sin key y con el workflow", () => {
    expect(resolveGenAiConfig("image", snapshot, {})).toEqual({
      task: "image",
      provider: "comfyui",
      baseUrl: "http://127.0.0.1:8188",
      model: "sd15",
      apiKey: "",
      comfyWorkflow: CONFIG,
    });
  });

  it("sin workflow (archivo editado a mano) no hay con qué generar", () => {
    const entry = snapshot.tasks.image;
    if (entry === undefined) throw new Error("unreachable");
    const { comfyWorkflow: _w, ...rest } = entry;
    expect(resolveGenAiConfig("image", { tasks: { image: rest } }, {})).toBeNull();
  });

  it("la vista pública lleva el workflow para editarlo, y está ready sin key", () => {
    const view = toPublicTaskConfig("image", snapshot, null, {});
    expect(view.status).toBe("ready");
    expect(view.comfyWorkflow).toEqual(CONFIG);
    expect(toPublicTaskConfig("video", snapshot, null, {}).comfyWorkflow).toBeNull();
  });
});

describe("costo 0 y la imagen de entrada local", () => {
  it("una generación gratis entra aunque el mes esté pasado de tope", () => {
    const ledger = {
      ...EMPTY_SPEND_LEDGER,
      budgetUsd: 1,
      months: {
        "2026-09": {
          g: {
            usd: 5,
            state: "charged" as const,
            provider: "fal",
            model: "m",
            kind: "image" as const,
            companyId: "c",
            at: NOW,
          },
        },
      },
    };
    const summary = budgetSummary(ledger, "2026-09", {});
    expect(fitsBudget(summary, 0.01)).toBe(false);
    expect(fitsBudget(summary, 0)).toBe(true);
  });

  it("http:// sólo vale como imagen de entrada con un proveedor local", () => {
    const spec = {
      id: "w",
      label: "w",
      kind: "video" as const,
      aspectRatios: [],
      aspectFromImage: true,
      counts: [1],
      durationsSeconds: [5],
      promptRequired: true,
      imageInput: "required" as const,
      maxReferenceImages: 0,
      docsUrl: "https://docs.comfy.org",
      listPrice: null,
    };
    const input = {
      kind: "video" as const,
      model: "w",
      prompt: "x",
      aspectRatio: "16:9" as const,
      count: 1,
      durationSeconds: 5,
      imageUrl: "http://localhost:9000/fastgram/media/a.png",
    };
    expect(checkGenerationInput(spec, input).ok).toBe(false);
    expect(checkGenerationInput(spec, input, { localImageFetch: true }).ok).toBe(true);
  });
});
