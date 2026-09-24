import { describe, expect, it } from "vitest";
import type { GenModelSpec } from "@fastgram/ports";

import {
  generationErrorFromPort,
  markFailed,
  markReady,
  markSubmitted,
  mediaCategoriesFor,
  newGenerationRecord,
  parseGenerationRecord,
  sortGenerations,
} from "./record.js";
import {
  checkGenerationInput,
  parseAiStudioGenerationJob,
  pollDelayMs,
} from "./request.js";

const NOW = "2026-09-24T12:00:00.000Z";

const base = newGenerationRecord({
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  kind: "image",
  provider: "fal",
  model: "fal-ai/flux/schnell",
  prompt: "  a sunset  ",
  aspectRatio: "9:16",
  count: 2,
  durationSeconds: 5,
  imageUrl: null,
  estimate: { usd: 0.0055, source: "price_list", basis: "x", sourceUrl: null },
  spendMonth: "2026-09",
  now: NOW,
});

describe("GenerationRecord", () => {
  it("nace queued, recorta el prompt y una imagen no lleva duración", () => {
    expect(base).toMatchObject({
      status: "queued",
      prompt: "a sunset",
      durationSeconds: null,
    });
  });

  it("ida y vuelta por JSON en cada estado; algo con otra forma es null", () => {
    const submitted = markSubmitted(
      base,
      { requestId: "r", statusUrl: "https://queue.fal.run/x/status", responseUrl: null },
      NOW,
    );
    const ready = markReady(submitted, ["m1", "m2"], NOW);
    const failed = markFailed(
      submitted,
      { code: "generation_failed", message: "no" },
      NOW,
    );
    for (const r of [base, submitted, ready, failed]) {
      expect(parseGenerationRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
    }
    expect(parseGenerationRecord({ ...base, status: "weird" })).toBeNull();
    expect(parseGenerationRecord({ ...base, version: 2 })).toBeNull();
    expect(
      parseGenerationRecord({ ...base, error: { code: "made_up", message: "x" } }),
    ).toBeNull();
    expect(parseGenerationRecord(null)).toBeNull();
  });

  it("nsfw_rejected deja el estado nsfw; lo demás, failed", () => {
    expect(markFailed(base, { code: "nsfw_rejected", message: "x" }, NOW).status).toBe(
      "nsfw",
    );
    expect(markFailed(base, { code: "budget_exceeded", message: "x" }, NOW).status).toBe(
      "failed",
    );
  });

  it("más nuevas primero", () => {
    const older = { ...base, id: "a", createdAt: "2026-09-01T00:00:00.000Z" };
    const newer = { ...base, id: "b", createdAt: "2026-09-02T00:00:00.000Z" };
    expect(sortGenerations([older, newer]).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("categorías: imágenes elegibles como slide y como fondo; videos como fondo", () => {
    expect(mediaCategoriesFor("image")).toEqual([
      "slideshow-image",
      "green-screen-background",
    ]);
    expect(mediaCategoriesFor("video")).toEqual(["background-video"]);
  });

  it("los códigos de puerto se traducen a los estables", () => {
    expect(generationErrorFromPort("forbidden")).toBe("unauthorized");
    expect(generationErrorFromPort("quota_exceeded")).toBe("quota_exceeded");
    expect(generationErrorFromPort("provider_unavailable")).toBe("provider_unavailable");
  });
});

const flux: GenModelSpec = {
  id: "fal-ai/flux/schnell",
  label: "FLUX",
  kind: "image",
  aspectRatios: ["1:1", "9:16"],
  aspectFromImage: false,
  counts: [1, 2, 3, 4],
  durationsSeconds: [],
  promptRequired: true,
  imageInput: "none",
  maxReferenceImages: 0,
  docsUrl: "https://fal.ai",
  listPrice: null,
};
const i2v: GenModelSpec = {
  ...flux,
  id: "i2v",
  kind: "video",
  aspectRatios: [],
  aspectFromImage: true,
  counts: [1],
  durationsSeconds: [5, 10],
  promptRequired: false,
  imageInput: "required",
};

describe("checkGenerationInput", () => {
  const ok = {
    kind: "image" as const,
    model: flux.id,
    prompt: "x",
    aspectRatio: "9:16" as const,
    count: 2,
  };

  it("un pedido válido pasa", () => {
    expect(checkGenerationInput(flux, ok)).toEqual({ ok: true });
  });

  it.each([
    ["modelo desconocido", undefined, ok, "model"],
    ["clase equivocada", flux, { ...ok, kind: "video" as const }, "model"],
    ["sin prompt", flux, { ...ok, prompt: "  " }, "prompt"],
    [
      "relación no soportada",
      flux,
      { ...ok, aspectRatio: "4:5" as const },
      "aspectRatio",
    ],
    ["cantidad no soportada", flux, { ...ok, count: 5 }, "count"],
    ["imagen donde no va", flux, { ...ok, imageUrl: "https://x.test/a.png" }, "imageUrl"],
  ])("%s → campo %s", (_, spec, input, field) => {
    const r = checkGenerationInput(spec, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe(field);
  });

  it("image-to-video: pide imagen https y duración del modelo; la relación sale de la imagen", () => {
    const video = {
      kind: "video" as const,
      model: "i2v",
      prompt: "",
      aspectRatio: "4:5" as const,
      count: 1,
      durationSeconds: 5,
    };
    expect(checkGenerationInput(i2v, video)).toMatchObject({
      ok: false,
      field: "imageUrl",
    });
    expect(
      checkGenerationInput(i2v, { ...video, imageUrl: "http://localhost:9000/a.png" }),
    ).toMatchObject({ ok: false, field: "imageUrl" });
    expect(
      checkGenerationInput(i2v, {
        ...video,
        imageUrl: "https://x.test/a.png",
        durationSeconds: 7,
      }),
    ).toMatchObject({ ok: false, field: "durationSeconds" });
    expect(
      checkGenerationInput(i2v, { ...video, imageUrl: "https://x.test/a.png" }),
    ).toEqual({
      ok: true,
    });
  });
});

describe("job y polling", () => {
  it("el payload sólo lleva ids válidos", () => {
    expect(
      parseAiStudioGenerationJob({ companyId: base.companyId, generationId: base.id }).ok,
    ).toBe(true);
    expect(
      parseAiStudioGenerationJob({ companyId: "../x", generationId: base.id }).ok,
    ).toBe(false);
    expect(parseAiStudioGenerationJob(null).ok).toBe(false);
  });

  it("2 s, ×1,5 hasta 10 s, más hasta 0,5 s de jitter (docs de Higgsfield)", () => {
    expect(pollDelayMs(0, 0)).toBe(2000);
    expect(pollDelayMs(1, 0)).toBe(3000);
    expect(pollDelayMs(2, 0)).toBe(4500);
    expect(pollDelayMs(10, 0)).toBe(10_000);
    expect(pollDelayMs(10, 1)).toBe(10_500);
  });
});
