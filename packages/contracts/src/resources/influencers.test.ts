import { describe, expect, it } from "vitest";
import {
  createInfluencerRequestSchema,
  influencerImageRequestSchema,
  influencerSchema,
  INFLUENCER_AGE_DEFAULT,
  INFLUENCER_AGE_MAX,
  INFLUENCER_AGE_MIN,
  INFLUENCER_CREDITS_BASE_IMAGE,
  INFLUENCER_CREDITS_CREATE,
  INFLUENCER_CREDITS_IMAGE_GENERATION,
  INFLUENCER_CREDITS_VIDEO_GENERATION,
  INFLUENCER_PROGRESS_MAX,
  INFLUENCER_PROGRESS_MIN,
  MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE,
} from "./influencers.js";

const valid = { name: "Ella", gender: "woman", ethnicity: "White" };

describe("rango de edad · FR-080 · PRD:1496", () => {
  it("va de 18 a 60 y el default es 25", () => {
    expect(INFLUENCER_AGE_MIN).toBe(18);
    expect(INFLUENCER_AGE_MAX).toBe(60);
    expect(INFLUENCER_AGE_DEFAULT).toBe(25);
  });

  it("acepta los extremos 18 y 60", () => {
    expect(createInfluencerRequestSchema.parse({ ...valid, age: 18 }).age).toBe(18);
    expect(createInfluencerRequestSchema.parse({ ...valid, age: 60 }).age).toBe(60);
  });

  it("rechaza 17 y 61", () => {
    expect(() => createInfluencerRequestSchema.parse({ ...valid, age: 17 })).toThrow();
    expect(() => createInfluencerRequestSchema.parse({ ...valid, age: 61 })).toThrow();
  });

  it("sin age queda sin edad (PU-LATER-004: el 25 es el valor inicial del slider)", () => {
    expect(createInfluencerRequestSchema.parse(valid).age).toBeUndefined();
  });
});

describe("caps y progreso · FR-080 · PRD:1513 · DATA-013 · PRD:2102", () => {
  it("50 influencers activos por workspace", () => {
    expect(MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE).toBe(50);
  });

  it("progress es entero 0–100", () => {
    expect(INFLUENCER_PROGRESS_MIN).toBe(0);
    expect(INFLUENCER_PROGRESS_MAX).toBe(100);
    const base = {
      _id: "inf_1",
      name: "Ella",
      gender: "woman",
      age: 25,
      ethnicity: "White",
      baseImageUrl: "https://cdn.example.com/a.png",
      status: "training" as const,
      isActive: true,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(influencerSchema.parse({ ...base, progress: 0 }).progress).toBe(0);
    expect(influencerSchema.parse({ ...base, progress: 100 }).progress).toBe(100);
    expect(() => influencerSchema.parse({ ...base, progress: 101 })).toThrow();
    expect(() => influencerSchema.parse({ ...base, progress: 50.5 })).toThrow();
  });
});

describe("costes en créditos · FR-080 · PRD:1517", () => {
  it("4 la imagen base, 250 la creación, 4 por imagen generada, 60 por video", () => {
    expect(INFLUENCER_CREDITS_BASE_IMAGE).toBe(4);
    expect(INFLUENCER_CREDITS_CREATE).toBe(250);
    expect(INFLUENCER_CREDITS_IMAGE_GENERATION).toBe(4);
    expect(INFLUENCER_CREDITS_VIDEO_GENERATION).toBe(60);
  });
});

describe("creación", () => {
  it("rechaza campos desconocidos", () => {
    expect(() =>
      createInfluencerRequestSchema.parse({ ...valid, hairColor: "red" }),
    ).toThrow();
  });

  it("acepta la ruta `Upload your own` con baseImageUploadId · PRD:1494", () => {
    expect(
      createInfluencerRequestSchema.parse({ ...valid, baseImageUploadId: "up_1" })
        .baseImageUploadId,
    ).toBe("up_1");
  });
});

describe("PU-LATER-004 — personaje con fotos de referencia", () => {
  const ids = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );

  it("4–20 fotos únicas; los rasgos son opcionales", () => {
    const ok = createInfluencerRequestSchema.parse({
      name: "Emily",
      referenceMediaIds: ids(4),
    });
    expect(ok.gender).toBeUndefined();
    expect(() =>
      createInfluencerRequestSchema.parse({ name: "E", referenceMediaIds: ids(3) }),
    ).toThrow();
    expect(() =>
      createInfluencerRequestSchema.parse({ name: "E", referenceMediaIds: ids(21) }),
    ).toThrow();
    const dup = [...ids(3), ids(1)[0]];
    expect(() =>
      createInfluencerRequestSchema.parse({ name: "E", referenceMediaIds: dup }),
    ).toThrow();
  });

  it("fotos de referencia y base image son excluyentes", () => {
    expect(() =>
      createInfluencerRequestSchema.parse({
        name: "E",
        referenceMediaIds: ids(4),
        baseImageUploadId: "up_1",
      }),
    ).toThrow();
  });

  it("pedido de imágenes: 9:16 y 1 por default, count 1 o 4, sin 4:5", () => {
    const r = influencerImageRequestSchema.parse({ prompt: "at the gym" });
    expect(r).toEqual({ prompt: "at the gym", aspectRatio: "9:16", count: 1 });
    expect(influencerImageRequestSchema.parse({ prompt: "x", count: 4 }).count).toBe(4);
    expect(() => influencerImageRequestSchema.parse({ prompt: "x", count: 2 })).toThrow();
    expect(() =>
      influencerImageRequestSchema.parse({ prompt: "x", aspectRatio: "4:5" }),
    ).toThrow();
    expect(() => influencerImageRequestSchema.parse({ prompt: "  " })).toThrow();
  });
});
