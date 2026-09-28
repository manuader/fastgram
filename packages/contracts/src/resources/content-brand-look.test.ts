/**
 * Sprint 9 (S): la marca en las piezas clásicas — familia `brand:<id>` y capa
 * de logo en el contrato, todo aditivo.
 */
import { describe, expect, it } from "vitest";

import {
  brandLogoLayerSchema,
  buildLogoSchema,
  contentBuildPayloadSchema,
  isFontWeightAllowed,
  textFontSchema,
  updateContentRequestSchema,
} from "./content.js";

const text = {
  content: "hola",
  x: 540,
  y: 960,
  width: 900,
  fontSize: 32,
  color: "#FFFFFF",
  textAlign: "center",
} as const;
const media = {
  url: "https://s3.test/media/c/a.jpg",
  drawX: 0,
  drawY: 0,
  drawW: 1080,
  drawH: 1920,
};
const greenScreen = {
  canvas: { width: 1080, height: 1920 },
  image: media,
  video: { ...media, url: "https://s3.test/media/c/v.mp4" },
  text,
};

describe("familia de marca en la caja (FR-051 + brand:<id>)", () => {
  it("acepta las 12 con su tabla de pesos y brand:<id> con cualquier centena", () => {
    expect(
      textFontSchema.safeParse({ family: "inter", weight: 700, size: 20 }).success,
    ).toBe(true);
    expect(
      textFontSchema.safeParse({ family: "anton", weight: 700, size: 20 }).success,
    ).toBe(false);
    expect(
      textFontSchema.safeParse({ family: "brand:rotis-semi-sans", weight: 800, size: 20 })
        .success,
    ).toBe(true);
    expect(
      textFontSchema.safeParse({ family: "brand:rotis-semi-sans", weight: 450, size: 20 })
        .success,
    ).toBe(false);
  });

  it("rechaza formas que no son brand:<id> ni una registrada", () => {
    for (const family of ["brand:", "brand:Rotis", "brand:-x", "Rotis", "brand:a/b"]) {
      expect(textFontSchema.safeParse({ family, weight: 400, size: 20 }).success).toBe(
        false,
      );
    }
  });

  it("isFontWeightAllowed sigue la tabla de FR-051", () => {
    expect(isFontWeightAllowed("playfair", 300)).toBe(false);
    expect(isFontWeightAllowed("playfair", 400)).toBe(true);
    expect(isFontWeightAllowed("brand:x", 100)).toBe(true);
    expect(isFontWeightAllowed("nope", 400)).toBe(false);
  });

  it("el texto del payload de build lleva fontFamily opcional (aditivo)", () => {
    expect(contentBuildPayloadSchema.safeParse(greenScreen).success).toBe(true);
    const branded = { ...greenScreen, text: { ...text, fontFamily: "brand:rotis" } };
    expect(contentBuildPayloadSchema.safeParse(branded).success).toBe(true);
    const bad = { ...greenScreen, text: { ...text, fontFamily: "comic-sans" } };
    expect(contentBuildPayloadSchema.safeParse(bad).success).toBe(false);
  });
});

describe("capa de logo", () => {
  it("es un enum cerrado de esquina y tamaño, con opacidad acotada", () => {
    expect(
      buildLogoSchema.safeParse({ corner: "top-right", size: "small", opacity: 0.9 })
        .success,
    ).toBe(true);
    expect(
      buildLogoSchema.safeParse({ corner: "center", size: "small", opacity: 0.9 })
        .success,
    ).toBe(false);
    expect(
      buildLogoSchema.safeParse({ corner: "top-left", size: "huge", opacity: 0.9 })
        .success,
    ).toBe(false);
    expect(
      buildLogoSchema.safeParse({ corner: "top-left", size: "small", opacity: 0.05 })
        .success,
    ).toBe(false);
    expect(
      buildLogoSchema.safeParse({
        corner: "top-left",
        size: "small",
        opacity: 1,
        url: "https://x",
      }).success,
    ).toBe(false);
  });

  it("viaja en los cuatro payloads sin cambiar cómo discrimina la unión", () => {
    const logo = { corner: "bottom-left", size: "medium", opacity: 1 };
    const parsed = contentBuildPayloadSchema.safeParse({ ...greenScreen, logo });
    expect(parsed.success).toBe(true);
    // Sigue siendo un green-screen: `image` + `video`, no un wall-of-text.
    expect(parsed.success && "image" in parsed.data).toBe(true);
    const slideshow = {
      num_images: 1,
      images: [
        {
          canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
          image: media,
          texts: [text],
        },
      ],
      logo,
    };
    expect(contentBuildPayloadSchema.safeParse(slideshow).success).toBe(true);
  });

  it("el PATCH lo prende, lo saca (null) o no lo toca (ausente)", () => {
    const base = {
      revision: 1,
      textBoxes: [
        {
          id: "slide-0-text-0",
          text: "a",
          position: { x: 50, y: 50 },
          widthPercent: 80,
          font: { family: "brand:rotis", weight: 700, size: 20 },
          color: "#FFFFFF",
          stroke: { width: 0, color: "#000000" },
          background: null,
        },
      ],
    };
    expect(updateContentRequestSchema.safeParse(base).success).toBe(true);
    expect(updateContentRequestSchema.safeParse({ ...base, logo: null }).success).toBe(
      true,
    );
    expect(
      updateContentRequestSchema.safeParse({
        ...base,
        logo: { corner: "top-right", size: "large", opacity: 0.5 },
      }).success,
    ).toBe(true);
  });

  it("la preferencia por marca", () => {
    expect(
      brandLogoLayerSchema.safeParse({
        enabled: true,
        corner: "top-right",
        size: "small",
        opacity: 0.9,
      }).success,
    ).toBe(true);
    expect(brandLogoLayerSchema.safeParse({ enabled: true }).success).toBe(false);
  });
});
