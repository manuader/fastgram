import { fontFamilySchema } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import { EDITOR_FONTS, closestWeight, cssFontFamily, googleFontsUrl } from "./fonts";

describe("las 12 familias de FR-051 en el navegador", () => {
  it("están las 12, en el orden del contrato", () => {
    expect(EDITOR_FONTS.map((f) => f.key)).toEqual(fontFamilySchema.options);
  });

  it("los nombres son los que resuelve el render (pangoFamily)", () => {
    expect(cssFontFamily("playfair")).toContain('"Playfair Display"');
    expect(cssFontFamily("bebas")).toContain('"Bebas Neue"');
  });

  it("tiktok y snapchat no tienen archivo: caen a Inter, como el render", () => {
    expect(cssFontFamily("tiktok").startsWith('"Inter"')).toBe(true);
  });

  it("una URL estable, con ejes sólo donde hay más de un peso", () => {
    const url = googleFontsUrl(["anton", "inter", "inter", "tiktok"]);
    expect(url).toBe(
      "https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@300;400;500;600;700&display=swap",
    );
    expect(googleFontsUrl([])).toBeNull();
  });

  it("al cambiar de familia, el peso más cercano permitido", () => {
    expect(closestWeight("anton", 700)).toBe(400);
    expect(closestWeight("playfair", 300)).toBe(400);
    expect(closestWeight("inter", 600)).toBe(600);
  });
});
