import { describe, expect, it } from "vitest";
import {
  ANGLE_DESCRIPTION_MAX,
  ANGLE_GENERATION_RATE_LIMIT_PER_MIN,
  ANGLE_TARGET_AUDIENCE_MAX,
  ANGLE_TITLE_MAX,
  MAX_ANGLES_PER_INFLUENCER,
  MAX_ANGLES_PER_WORKSPACE,
  createContentAngleRequestSchema,
  generateContentAngleRequestSchema,
  generatedContentAngleSchema,
  updateContentAngleRequestSchema,
} from "./angles.js";

const valid = {
  title: "One Idea, Everywhere",
  description: "Focuses on the constant pressure businesses face to feed social.",
  targetAudience: "Founders without a marketing team",
};

describe("caps y longitudes de content angles · FR-056 · PRD:1314-1319", () => {
  it("title ≤ 200 · PRD:1313", () => {
    expect(ANGLE_TITLE_MAX).toBe(200);
    expect(
      createContentAngleRequestSchema.parse({ ...valid, title: "t".repeat(200) }).title,
    ).toHaveLength(200);
    expect(() =>
      createContentAngleRequestSchema.parse({ ...valid, title: "t".repeat(201) }),
    ).toThrow();
  });

  it("description ≤ 2000 · PRD:1314", () => {
    expect(ANGLE_DESCRIPTION_MAX).toBe(2000);
    expect(() =>
      createContentAngleRequestSchema.parse({ ...valid, description: "d".repeat(2001) }),
    ).toThrow();
  });

  it("targetAudience ≤ 500 · PRD:1315", () => {
    expect(ANGLE_TARGET_AUDIENCE_MAX).toBe(500);
    expect(() =>
      createContentAngleRequestSchema.parse({
        ...valid,
        targetAudience: "a".repeat(501),
      }),
    ).toThrow();
  });

  it("100 ángulos por workspace · PRD:1319", () => {
    expect(MAX_ANGLES_PER_WORKSPACE).toBe(100);
  });

  it("10 ángulos por influencer · PRD:1319", () => {
    expect(MAX_ANGLES_PER_INFLUENCER).toBe(10);
  });

  it("5 sugerencias exitosas por minuto · PRD:1321", () => {
    expect(ANGLE_GENERATION_RATE_LIMIT_PER_MIN).toBe(5);
  });

  it("los tres campos de texto son obligatorios · PRD:1313-1314", () => {
    expect(() =>
      createContentAngleRequestSchema.parse({ title: "t", description: "d" }),
    ).toThrow();
  });
});

describe("influencerIds · FR-056 · PRD:1319", () => {
  it("deben ser únicos", () => {
    expect(() =>
      createContentAngleRequestSchema.parse({
        ...valid,
        influencerIds: ["inf_1", "inf_1"],
      }),
    ).toThrow();
    expect(
      createContentAngleRequestSchema.parse({
        ...valid,
        influencerIds: ["inf_1", "inf_2"],
      }).influencerIds,
    ).toHaveLength(2);
  });
});

describe("PATCH de un ángulo", () => {
  it("un body vacío se rechaza", () => {
    expect(() => updateContentAngleRequestSchema.parse({})).toThrow();
  });

  it("isActive se puede volver a poner en true: el borrado es soft-delete · PRD:1319", () => {
    expect(updateContentAngleRequestSchema.parse({ isActive: true }).isActive).toBe(true);
  });

  it("rechaza campos desconocidos", () => {
    expect(() => updateContentAngleRequestSchema.parse({ color: "orange" })).toThrow();
  });
});

describe("generación asistida · AI-005 · PRD:2613-2619", () => {
  it("el body es vacío `{}` y no admite más claves", () => {
    expect(generateContentAngleRequestSchema.parse({})).toEqual({});
    expect(() => generateContentAngleRequestSchema.parse({ prompt: "algo" })).toThrow();
  });

  it("la respuesta trae brandRevision para reenviarlo como expectedBrandRevision", () => {
    const generated = generatedContentAngleSchema.parse({ ...valid, brandRevision: 7 });
    expect(generated.brandRevision).toBe(7);
    expect(
      createContentAngleRequestSchema.parse({
        ...valid,
        expectedBrandRevision: generated.brandRevision,
      }).expectedBrandRevision,
    ).toBe(7);
  });
});
