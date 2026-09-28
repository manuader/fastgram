import { describe, expect, it } from "vitest";

import {
  brandFontListSchema,
  isBrandFamilyRef,
  isWeightAllowedForField,
  MAX_BRAND_FONTS,
  pickBrandFace,
} from "./fonts.js";
import { textObjectSchema } from "./text.js";

const base = {
  id: "t",
  text: "hola",
  position: { x: 50, y: 50 },
  widthPercent: 80,
};

describe("familias de marca en una caja (sprint 9, M)", () => {
  it("brand:<id> con id en minúsculas, dígitos y guiones", () => {
    expect(isBrandFamilyRef("brand:rotis-semi-sans")).toBe(true);
    expect(isBrandFamilyRef("brand:")).toBe(false);
    expect(isBrandFamilyRef("brand:Rotis")).toBe(false);
    expect(isBrandFamilyRef("brand:../x")).toBe(false);
    expect(isBrandFamilyRef("montserrat")).toBe(false);
  });

  it("el schema de la caja acepta una de las 12 o brand:<id>, y nada más", () => {
    expect(
      textObjectSchema.safeParse({
        ...base,
        font: { family: "brand:rotis", weight: 300 },
      }).success,
    ).toBe(true);
    expect(
      textObjectSchema.safeParse({ ...base, font: { family: "anton", weight: 400 } })
        .success,
    ).toBe(true);
    expect(
      textObjectSchema.safeParse({ ...base, font: { family: "Rotis", weight: 400 } })
        .success,
    ).toBe(false);
    // La tabla de pesos de las 12 sigue mandando; la de marca acepta centenas.
    expect(
      textObjectSchema.safeParse({ ...base, font: { family: "anton", weight: 700 } })
        .success,
    ).toBe(false);
    expect(isWeightAllowedForField("brand:x", 800)).toBe(true);
    expect(isWeightAllowedForField("brand:x", 450)).toBe(false);
  });

  it("la cara más cercana: normal antes que itálica, empate → la más liviana", () => {
    const faces = [
      { id: "r", weight: 300, style: "normal" },
      { id: "r", weight: 400, style: "italic" },
      { id: "r", weight: 700, style: "normal" },
      { id: "o", weight: 400, style: "normal" },
    ];
    expect(pickBrandFace(faces, "r", 400)).toEqual({
      id: "r",
      weight: 300,
      style: "normal",
    });
    expect(pickBrandFace(faces, "r", 500)).toEqual({
      id: "r",
      weight: 300,
      style: "normal",
    });
    expect(pickBrandFace(faces, "r", 600)).toEqual({
      id: "r",
      weight: 700,
      style: "normal",
    });
    expect(pickBrandFace(faces, "x", 400)).toBeNull();
  });

  it("tope de caras por request", () => {
    const face = { id: "r", weight: 400, url: "https://cdn.test/f" };
    expect(
      brandFontListSchema.safeParse(Array.from({ length: MAX_BRAND_FONTS }, () => face))
        .success,
    ).toBe(true);
    expect(
      brandFontListSchema.safeParse(
        Array.from({ length: MAX_BRAND_FONTS + 1 }, () => face),
      ).success,
    ).toBe(false);
  });
});
