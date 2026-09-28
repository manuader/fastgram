/**
 * Sprint 9 (U, `PU-S9-014`): la marca en el spec del reel — familias
 * `brand:<id>` con sus archivos, el plan semanal y la cola de Blitz con reels.
 */
import { describe, expect, it } from "vitest";
import {
  REEL_DEFAULT_THEME,
  reelFontUrls,
  reelPlanViewSchema,
  reelSpecSchema,
  type ReelSpec,
} from "./reel.js";
import { blitzSuggestionSchema } from "./blitz.js";

const FONT_URL = "https://s3.test/bucket/fonts/c1/rotis-700.otf";

function spec(family: string, weight = 700, brandFonts?: ReelSpec["brandFonts"]): unknown {
  return {
    version: 1,
    durationSec: 6,
    canvas: { width: 1080, height: 1920 },
    fps: 30,
    theme: REEL_DEFAULT_THEME,
    ...(brandFonts === undefined ? {} : { brandFonts }),
    mix: { duckMusic: true, duckLevel: 0.3 },
    layers: [
      {
        id: "bg",
        kind: "background",
        start: 0,
        end: 6,
        z: 0,
        fill: { type: "color", color: "#0A0A0B" },
        transitionIn: { kind: "cut", durationSec: 0.4 },
      },
      {
        id: "hook",
        kind: "text",
        start: 0.2,
        end: 3,
        z: 10,
        text: "Mirar no alcanza",
        font: { family, weight, size: 40 },
        color: "#FFFFFF",
        stroke: { width: 0, color: "#000000" },
        background: null,
        position: { x: 50, y: 20 },
        widthPercent: 90,
        animation: "pop",
        exit: "fade",
      },
    ],
  };
}

const rotis = [{ id: "rotis-semi-sans", weight: 700, style: "normal" as const, url: FONT_URL }];

describe("familias de marca en el reel", () => {
  it("brand:<id> con su archivo valida, y sus URLs salen aparte", () => {
    const parsed = reelSpecSchema.safeParse(spec("brand:rotis-semi-sans", 700, rotis));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(reelFontUrls(parsed.data)).toEqual([FONT_URL]);
  });

  it("brand:<id> sin archivo en brandFonts no valida", () => {
    const parsed = reelSpecSchema.safeParse(spec("brand:rotis-semi-sans", 700));
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("brandFonts");
  });

  it("peso de marca: cualquier centena; id con forma de slug", () => {
    expect(reelSpecSchema.safeParse(spec("brand:rotis-semi-sans", 300, rotis)).success).toBe(
      true,
    );
    expect(reelSpecSchema.safeParse(spec("brand:rotis-semi-sans", 350, rotis)).success).toBe(
      false,
    );
    expect(reelSpecSchema.safeParse(spec("brand:Rotis Semi", 700, rotis)).success).toBe(false);
    expect(reelSpecSchema.safeParse(spec("comic-sans", 400)).success).toBe(false);
  });

  it("las 12 registradas siguen con su tabla de pesos", () => {
    expect(reelSpecSchema.safeParse(spec("anton", 400)).success).toBe(true);
    expect(reelSpecSchema.safeParse(spec("anton", 700)).success).toBe(false);
  });
});

describe("plan y cola", () => {
  it("una sugerencia reel con póster valida en el contrato de la cola", () => {
    expect(
      blitzSuggestionSchema.safeParse({
        id: "s1",
        contentType: "reel",
        generatedText: "Mirar no alcanza",
        preview: { reel: { posterUrl: "https://s3.test/p.jpg", durationSec: 12.2 } },
      }).success,
    ).toBe(true);
    expect(
      blitzSuggestionSchema.safeParse({ id: "s1", contentType: "custom" }).success,
    ).toBe(false);
  });

  it("la vista del plan", () => {
    expect(
      reelPlanViewSchema.safeParse({ plan: null, weeklyQuota: 0, reelWeight: 0 }).success,
    ).toBe(true);
  });
});
