import { describe, expect, it } from "vitest";
import {
  createInfluencerRequestSchema,
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

  it("sin age aplica el default 25", () => {
    expect(createInfluencerRequestSchema.parse(valid).age).toBe(25);
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
