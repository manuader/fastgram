/**
 * Sprint 9 (S), `PU-S9-003`: la marca en las piezas clásicas.
 */
import { describe, expect, it } from "vitest";

import { DomainError } from "../errors.js";
import { readDesignSystemTokens } from "../design-system/document.js";
import type { DesignSystemTokens, DsFontFamily } from "../design-system/types.js";
import {
  BRAND_FONT_UNAVAILABLE,
  assertBrandFamiliesAvailable,
  brandDefaultLogo,
  brandTextFamilies,
  effectiveLogo,
  planBrandFonts,
  readLogoOverride,
  stampBrandLook,
  withLogoOverride,
} from "./brand-look.js";
import { assertValidTextBox, type ContentTextBox } from "./text-boxes.js";

const rotis = (licenseConfirmed: boolean): DsFontFamily => ({
  name: "Rotis Semi Sans",
  id: "rotis-semi-sans",
  origin: "file",
  category: "sans",
  license: "needs_confirmation",
  licenseConfirmed,
  faces: [
    { weight: 300, style: "normal", file: "fonts/Rotis-Light.otf" },
    { weight: 700, style: "normal", file: "fonts/Rotis-Bold.otf" },
    { weight: 800, style: "normal", file: "fonts/Rotis-ExtraBold.otf" },
    { weight: 400, style: "italic", file: "fonts/Rotis-Italic.otf" },
  ],
  weights: [300, 400, 700, 800],
  fallback: "inter",
});

const serif: DsFontFamily = {
  name: "Source Serif 4",
  id: "source-serif-4",
  origin: "google",
  category: "serif",
  license: "open",
  licenseConfirmed: false,
  faces: [],
  weights: [400, 700],
  fallback: "playfair",
};

function tokens(
  licensed: boolean,
  extra: Partial<DesignSystemTokens> = {},
): DesignSystemTokens {
  return {
    colors: [],
    semantic: {
      surfaceDark: "#111111",
      surfaceLight: "#F5F5F5",
      textOnDark: "#FFFFFF",
      textOnLight: "#111111",
      accents: [],
    },
    families: [rotis(licensed), serif],
    roles: [
      {
        role: "display",
        stack: ["Rotis Semi Sans", "sans-serif"],
        familyId: "rotis-semi-sans",
      },
      { role: "body", stack: ["Source Serif 4", "serif"], familyId: "source-serif-4" },
    ],
    spacing: [],
    ...extra,
  };
}

const files = [
  {
    familyId: "rotis-semi-sans",
    weight: 300,
    style: "normal" as const,
    url: "https://s3/fonts/c/r-300.otf",
  },
  {
    familyId: "rotis-semi-sans",
    weight: 700,
    style: "normal" as const,
    url: "https://s3/fonts/c/r-700.otf",
  },
  {
    familyId: "rotis-semi-sans",
    weight: 400,
    style: "italic" as const,
    url: "https://s3/fonts/c/r-400i.otf",
  },
];

const text = (extra: Record<string, unknown> = {}) => ({
  content: "hola",
  x: 540,
  y: 960,
  width: 900,
  fontSize: 32,
  color: "#FFFFFF",
  textAlign: "center" as const,
  ...extra,
});

const box = (family: string, weight = 400): ContentTextBox => ({
  id: "slide-0-text-0",
  slideIndex: 0,
  text: "a",
  position: { x: 50, y: 50 },
  widthPercent: 80,
  font: { family, weight, size: 20 },
  color: "#FFFFFF",
  stroke: { width: 0, color: "#000000" },
  background: null,
});

describe("familia de marca en la caja", () => {
  it("brand:<id> pasa la validación con cualquier centena; 450 no", () => {
    expect(() => assertValidTextBox(box("brand:rotis-semi-sans", 800))).not.toThrow();
    expect(() => assertValidTextBox(box("brand:rotis-semi-sans", 450))).toThrow(
      DomainError,
    );
    expect(() => assertValidTextBox(box("brand:", 400))).toThrow(DomainError);
    expect(() => assertValidTextBox(box("brand:Rotis", 400))).toThrow(DomainError);
  });

  it("al guardar: la familia tiene que existir en el design system activo y tener licencia", () => {
    expect(() =>
      assertBrandFamiliesAvailable([box("brand:rotis-semi-sans", 700)], tokens(true)),
    ).not.toThrow();
    for (const [family, t] of [
      ["brand:rotis-semi-sans", tokens(false)], // licencia sin tildar
      ["brand:no-existe", tokens(true)],
      ["brand:rotis-semi-sans", null], // sin design system
    ] as const) {
      try {
        assertBrandFamiliesAvailable([box(family, 700)], t);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(DomainError);
        expect((e as DomainError).details?.["reason"]).toBe(BRAND_FONT_UNAVAILABLE);
      }
    }
    // Las 12 no dependen del design system.
    expect(() => assertBrandFamiliesAvailable([box("inter", 400)], null)).not.toThrow();
  });
});

describe("defaults de las cajas desde el design system", () => {
  it("con licencia: título en la familia de marca, cuerpo en el reemplazo OFL de la Google", () => {
    const f = brandTextFamilies(tokens(true));
    expect(f.title).toEqual({
      family: "brand:rotis-semi-sans",
      weight: 700,
      weights: [300, 700, 800],
    });
    // Source Serif 4 no está entre las 12 → playfair.
    expect(f.body.family).toBe("playfair");
  });

  it("sin licencia: el título cae al reemplazo (inter), nunca a brand:", () => {
    const f = brandTextFamilies(tokens(false));
    expect(f.title.family).toBe("inter");
    expect(f.title.family.startsWith("brand:")).toBe(false);
  });

  it("estampa familia y peso en un green-screen sin familia; respeta la que ya viene", () => {
    const payload = {
      canvas: { width: 1080, height: 1920 },
      text: text({ fontWeight: 600 }),
    };
    const look = { families: brandTextFamilies(tokens(true)), logo: null };
    const out = stampBrandLook(payload, look);
    expect(out.changed).toBe(true);
    // 600 → la cara más cercana que existe (700).
    expect(out.payload.text).toMatchObject({
      fontFamily: "brand:rotis-semi-sans",
      fontWeight: 700,
    });

    const chosen = { ...payload, text: text({ fontFamily: "anton", fontWeight: 400 }) };
    const kept = stampBrandLook(chosen, look);
    expect(kept.changed).toBe(false);
    expect(kept.payload).toBe(chosen);
  });

  it("slideshow: primer slide con el título, el resto con el cuerpo", () => {
    const slide = (texts: unknown[]) => ({
      canvas: { width: 1080, height: 1350 },
      texts,
    });
    const payload = { num_images: 2, images: [slide([text()]), slide([text(), text()])] };
    const out = stampBrandLook(payload as never, {
      families: brandTextFamilies(tokens(true)),
      logo: null,
    });
    const p = out.payload as unknown as {
      images: { texts: { fontFamily: string; fontWeight: number }[] }[];
    };
    expect(p.images[0]?.texts[0]?.fontFamily).toBe("brand:rotis-semi-sans");
    expect(p.images[1]?.texts.map((t) => t.fontFamily)).toEqual(["playfair", "playfair"]);
    expect(p.images[1]?.texts[0]?.fontWeight).toBe(400);
  });

  it("sin design system no cambia nada", () => {
    const payload = { canvas: { width: 1080, height: 1920 }, text: text() };
    const out = stampBrandLook(payload, { families: null, logo: null });
    expect(out).toEqual({ payload, changed: false });
  });
});

describe("logo por marca", () => {
  const on = {
    enabled: true,
    corner: "bottom-left" as const,
    size: "medium" as const,
    opacity: 0.8,
  };

  it("sólo con la preferencia prendida y un logo disponible", () => {
    expect(brandDefaultLogo(tokens(true), true)).toBeNull(); // sin preferencia = apagado
    expect(
      brandDefaultLogo(tokens(true, { logoLayer: { ...on, enabled: false } }), true),
    ).toBeNull();
    expect(brandDefaultLogo(tokens(true, { logoLayer: on }), false)).toBeNull();
    expect(brandDefaultLogo(tokens(true, { logoLayer: on }), true)).toEqual({
      corner: "bottom-left",
      size: "medium",
      opacity: 0.8,
    });
  });

  it("se estampa si el payload no tiene logo, y no pisa uno que ya tiene", () => {
    const payload = {
      canvas: { width: 1080, height: 1920 },
      text: text({ fontFamily: "inter" }),
    };
    const logo = { corner: "top-left" as const, size: "small" as const, opacity: 1 };
    const out = stampBrandLook(payload, { families: null, logo });
    expect(out.changed).toBe(true);
    expect(out.payload.logo).toEqual(logo);
    const other = { ...payload, logo: { ...logo, corner: "bottom-right" as const } };
    expect(stampBrandLook(other, { families: null, logo }).changed).toBe(false);
  });

  it("la preferencia sobrevive a releer los tokens (una edición de paleta no la apaga)", () => {
    const raw = JSON.parse(JSON.stringify(tokens(true, { logoLayer: on }))) as unknown;
    expect(readDesignSystemTokens(raw)?.logoLayer).toEqual(on);
    const broken = { ...(raw as object), logoLayer: { enabled: "yes" } };
    expect(readDesignSystemTokens(broken)?.logoLayer).toBeUndefined();
  });

  it("override del editor en studioState: prende, saca, o no toca", () => {
    const payloadLogo = { corner: "top-right", size: "small", opacity: 0.9 };
    expect(readLogoOverride(null)).toEqual({ set: false });
    expect(effectiveLogo(payloadLogo, null)).toEqual(payloadLogo);
    const off = withLogoOverride({ assets: { audio: null } }, null);
    expect(off).toEqual({ assets: { audio: null }, logo: null });
    expect(effectiveLogo(payloadLogo, off)).toBeNull();
    const moved = withLogoOverride(off, {
      corner: "bottom-left",
      size: "large",
      opacity: 0.5,
    });
    expect(effectiveLogo(undefined, moved)).toEqual({
      corner: "bottom-left",
      size: "large",
      opacity: 0.5,
    });
    // Forma rota = no tocado.
    expect(effectiveLogo(payloadLogo, { logo: { corner: "center" } })).toEqual(
      payloadLogo,
    );
  });
});

describe("fuentes de marca al renderizar", () => {
  it("con licencia: manda las caras de la familia, sin reemplazos", () => {
    const plan = planBrandFonts(["brand:rotis-semi-sans", "inter"], tokens(true), files);
    expect(plan.substitutes).toEqual({});
    expect(plan.faces).toEqual([
      {
        id: "rotis-semi-sans",
        weight: 300,
        style: "normal",
        url: "https://s3/fonts/c/r-300.otf",
      },
      {
        id: "rotis-semi-sans",
        weight: 700,
        style: "normal",
        url: "https://s3/fonts/c/r-700.otf",
      },
      {
        id: "rotis-semi-sans",
        weight: 400,
        style: "italic",
        url: "https://s3/fonts/c/r-400i.otf",
      },
    ]);
  });

  it("licencia destildada después de guardar: no se manda, se reemplaza por el plan B", () => {
    const plan = planBrandFonts(["brand:rotis-semi-sans"], tokens(false), files);
    expect(plan.faces).toEqual([]);
    expect(plan.substitutes).toEqual({ "brand:rotis-semi-sans": "inter" });
  });

  it("sin design system o familia que ya no está: inter", () => {
    expect(planBrandFonts(["brand:x"], null, []).substitutes).toEqual({
      "brand:x": "inter",
    });
    expect(planBrandFonts(["brand:x"], tokens(true), files).substitutes).toEqual({
      "brand:x": "inter",
    });
  });

  it("más de 16 caras: primero las normales", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      familyId: "rotis-semi-sans",
      weight: 100 + (i % 9) * 100,
      style: (i < 10 ? "italic" : "normal") as "italic" | "normal",
      url: `https://s3/fonts/c/${String(i)}.otf`,
    }));
    const plan = planBrandFonts(["brand:rotis-semi-sans"], tokens(true), many);
    expect(plan.faces).toHaveLength(16);
    expect(plan.faces.slice(0, 10).every((f) => f.style === "normal")).toBe(true);
  });
});
