/** `P2-RENDER-008` — las 12 familias de `FR-051` y sus pesos permitidos. */
import { describe, expect, it } from "vitest";
import {
  FONT_FAMILIES,
  FONT_REGISTRY,
  allowedWeights,
  isWeightAllowed,
  requiredFontFiles,
} from "./fonts.js";
import { textObjectSchema } from "./text.js";

describe("registro tipográfico", () => {
  it("tiene exactamente las 12 familias que nombra FR-051", () => {
    expect(FONT_FAMILIES).toHaveLength(12);
    expect([...FONT_FAMILIES].sort()).toEqual(
      [
        "anton",
        "bangers",
        "bebas",
        "caveat",
        "inter",
        "montserrat",
        "oswald",
        "pacifico",
        "playfair",
        "poppins",
        "snapchat",
        "tiktok",
      ].sort(),
    );
  });

  it("las seis primeras aceptan 300–700 en pasos de 100", () => {
    for (const family of [
      "tiktok",
      "snapchat",
      "montserrat",
      "poppins",
      "inter",
      "oswald",
    ] as const) {
      expect(allowedWeights(family)).toEqual([300, 400, 500, 600, 700]);
    }
  });

  it("playfair y caveat aceptan 400–700", () => {
    for (const family of ["playfair", "caveat"] as const) {
      expect(allowedWeights(family)).toEqual([400, 500, 600, 700]);
      expect(isWeightAllowed(family, 300)).toBe(false);
    }
  });

  it("anton, bebas, bangers y pacifico sólo aceptan 400", () => {
    for (const family of ["anton", "bebas", "bangers", "pacifico"] as const) {
      expect(allowedWeights(family)).toEqual([400]);
      expect(isWeightAllowed(family, 500)).toBe(false);
      expect(isWeightAllowed(family, 300)).toBe(false);
    }
  });

  it("el esquema de texto rechaza un peso no permitido para la familia", () => {
    const base = {
      id: "t1",
      text: "x",
      position: { x: 50, y: 50 },
      widthPercent: 50,
    };
    expect(
      textObjectSchema.safeParse({
        ...base,
        font: { family: "anton", weight: 400, size: 20 },
      }).success,
    ).toBe(true);
    expect(
      textObjectSchema.safeParse({
        ...base,
        font: { family: "anton", weight: 700, size: 20 },
      }).success,
    ).toBe(false);
    expect(
      textObjectSchema.safeParse({
        ...base,
        font: { family: "caveat", weight: 300, size: 20 },
      }).success,
    ).toBe(false);
  });

  it("no inventa familias fuera del PRD", () => {
    const base = {
      id: "t1",
      text: "x",
      position: { x: 50, y: 50 },
      widthPercent: 50,
    };
    expect(
      textObjectSchema.safeParse({
        ...base,
        font: { family: "helvetica", weight: 400, size: 20 },
      }).success,
    ).toBe(false);
  });

  it("lista los archivos que hacen falta: 6×5 + 2×4 + 4×1 = 42", () => {
    expect(requiredFontFiles()).toHaveLength(6 * 5 + 2 * 4 + 4 * 1);
    expect(requiredFontFiles()).toContain("montserrat-700.ttf");
    expect(requiredFontFiles()).toContain("anton-400.ttf");
  });

  it("tiktok es TikTok Sans y snapchat es Inter (sustituto): las 12 son OFL", () => {
    expect(FONT_REGISTRY.tiktok.pangoFamily).toBe("TikTok Sans");
    expect(FONT_REGISTRY.snapchat.pangoFamily).toBe("Inter");
    expect(Object.values(FONT_REGISTRY).every((f) => f.licence === "ofl")).toBe(true);
    expect(FONT_REGISTRY.montserrat.licence).toBe("ofl");
  });
});
