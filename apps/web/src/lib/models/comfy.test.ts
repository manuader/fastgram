import { describe, expect, it } from "vitest";
import {
  comfyDirty,
  comfyDraftFrom,
  comfyErrors,
  detectBindings,
  parseWorkflow,
  refKey,
  toComfyWorkflow,
  withRef,
  withWorkflowText,
} from "./comfy";

/** txt2img con ids arbitrarios: el negativo aparece **antes** que el positivo. */
const TXT2IMG = {
  n1: { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["ck", 1] } },
  ck: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } },
  p9: { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["ck", 1] } },
  lt: {
    class_type: "EmptyLatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  sm: {
    class_type: "KSampler",
    inputs: {
      seed: 5,
      positive: ["p9", 0],
      negative: ["n1", 0],
      latent_image: ["lt", 0],
    },
  },
  sv: { class_type: "SaveImage", inputs: { filename_prefix: "a", images: ["sm", 0] } },
};

/** image-to-video: el positivo pasa por un nodo intermedio. */
const I2V = {
  "12": { class_type: "LoadImage", inputs: { image: "in.png" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "runs", clip: ["1", 0] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "static", clip: ["1", 0] } },
  "50": {
    class_type: "WanImageToVideo",
    inputs: {
      width: 832,
      height: 480,
      length: 81,
      positive: ["6", 0],
      negative: ["7", 0],
      start_image: ["12", 0],
    },
  },
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 1,
      positive: ["50", 0],
      negative: ["50", 1],
      latent_image: ["50", 2],
    },
  },
};

describe("parseWorkflow", () => {
  it("formato API sí; editor, JSON roto y objetos sin class_type no", () => {
    expect(parseWorkflow(JSON.stringify(TXT2IMG)).ok).toBe(true);
    const editor = parseWorkflow(JSON.stringify({ nodes: [], links: [] }));
    expect(editor.ok === false && editor.message).toMatch(/API format/);
    expect(parseWorkflow("{nope").ok).toBe(false);
    expect(parseWorkflow('{"1": {"inputs": {}}}').ok).toBe(false);
  });
});

describe("detectBindings", () => {
  it("txt2img: el positivo (no el negativo), el latente y la semilla del sampler", () => {
    expect(detectBindings(TXT2IMG, "image")).toEqual({
      prompt: { nodeId: "p9", input: "text" },
      width: { nodeId: "lt", input: "width" },
      height: { nodeId: "lt", input: "height" },
      seed: { nodeId: "sm", input: "seed" },
    });
  });

  it("i2v: sigue el positivo a través del nodo intermedio y encuentra LoadImage", () => {
    const found = detectBindings(I2V, "video");
    expect(found.prompt).toEqual({ nodeId: "6", input: "text" });
    expect(found.width).toEqual({ nodeId: "50", input: "width" });
    expect(found.image).toEqual({ nodeId: "12", input: "image" });
    // En imagen no se ofrece imagen de entrada.
    expect(detectBindings(I2V, "image").image).toBeUndefined();
  });
});

describe("borrador → comfyWorkflow", () => {
  it("pegar detecta; guardar arma el objeto; video pide duración", () => {
    let draft = withWorkflowText(comfyDraftFrom(null), JSON.stringify(I2V), "video");
    expect(draft.detected).toBe(true);
    expect(comfyErrors(draft, "video")).toHaveProperty("duration");
    expect(toComfyWorkflow(draft, "video")).toBeNull();
    draft = { ...draft, duration: "5" };
    expect(toComfyWorkflow(draft, "video")).toEqual({
      workflow: I2V,
      prompt: { nodeId: "6", input: "text" },
      width: { nodeId: "50", input: "width" },
      height: { nodeId: "50", input: "height" },
      seed: { nodeId: "3", input: "seed" },
      image: { nodeId: "12", input: "image" },
      durationSeconds: 5,
    });
  });

  it("cambiar un binding a mano apaga el aviso de detectado; width sin height es error", () => {
    const draft = withWorkflowText(
      comfyDraftFrom(null),
      JSON.stringify(TXT2IMG),
      "image",
    );
    const edited = withRef(draft, "height", "");
    expect(edited.detected).toBe(false);
    expect(comfyErrors(edited, "image")).toHaveProperty("size");
    const noPrompt = withRef(draft, "prompt", "");
    expect(comfyErrors(noPrompt, "image")).toHaveProperty("prompt");
  });

  it("lo guardado no está sucio aunque el texto tenga otro formato", () => {
    const saved = {
      workflow: TXT2IMG,
      prompt: { nodeId: "p9", input: "text" },
    };
    const draft = comfyDraftFrom(saved);
    expect(comfyDirty(draft, saved)).toBe(false);
    expect(comfyDirty({ ...draft, text: JSON.stringify(TXT2IMG) }, saved)).toBe(false);
    expect(
      comfyDirty(withRef(draft, "seed", refKey({ nodeId: "sm", input: "seed" })), saved),
    ).toBe(true);
  });
});
