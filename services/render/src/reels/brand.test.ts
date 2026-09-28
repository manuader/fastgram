/**
 * Sprint 9 (U, `PU-S9-014`): la marca en el motor de reels — fuentes
 * `brand:<id>` con `@font-face` desde su archivo, sus URLs en la política, el
 * instante del póster y la luminancia de los logos.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

import { sampleReel } from "./__fixtures__/spec.js";
import { reelMediaReferences } from "./assets.js";
import { compileReel, requiredFonts } from "./compose/index.js";
import { defaultPosterSec, visibleLuminance } from "./poster.js";
import { reelSpecSchema, type ReelSpec } from "./spec.js";

const FONT = "https://s3.test/bucket/fonts/c1/rotis-700.otf";

function branded(): ReelSpec {
  const spec = sampleReel() as ReelSpec;
  const layers = spec.layers.map((l) =>
    l.kind === "text" && l.id === spec.layers.find((x) => x.kind === "text")?.id
      ? { ...l, font: { family: "brand:rotis-semi-sans" as const, weight: 700, size: 40 } }
      : l,
  );
  return {
    ...spec,
    brandFonts: [{ id: "rotis-semi-sans", weight: 700, style: "normal", url: FONT }],
    layers,
  };
}

describe("fuentes de marca en el reel", () => {
  it("el espejo del contrato acepta brand:<id> con archivo y rechaza sin él", () => {
    expect(reelSpecSchema.safeParse(branded()).success).toBe(true);
    const { brandFonts: _, ...without } = branded();
    expect(reelSpecSchema.safeParse(without).success).toBe(false);
  });

  it("sus URLs entran a la política como imagen (grant con fonts/)", () => {
    const refs = reelMediaReferences(branded());
    expect(refs[0]).toEqual({ url: FONT, role: "image", path: ["spec", "brandFonts", 0, "url"] });
  });

  it("@font-face sin format() y con un nombre CSS sin `:`", () => {
    const spec = branded();
    expect(requiredFonts(spec)).toContain("brand:rotis-semi-sans-700");
    const html = compileReel(spec, {
      visual: new Map(),
      sound: new Map(),
      fonts: new Map([["brand:rotis-semi-sans-700", "fonts/brand-rotis-semi-sans-700.ttf"]]),
      captions: new Map(),
    }).html;
    expect(html).toContain(
      '@font-face{font-family:"fg-brand-rotis-semi-sans";src:url("fonts/brand-rotis-semi-sans-700.ttf");font-weight:700;font-style:normal;font-display:block}',
    );
    expect(html).toContain("font-family:'fg-brand-rotis-semi-sans'");
    expect(html).not.toContain("fg-brand:");
  });
});

describe("póster", () => {
  it("cuando el gancho ya entró, sin pasar el reel", () => {
    const spec = sampleReel() as ReelSpec;
    const withHook: ReelSpec = {
      ...spec,
      layers: spec.layers.map((l, i) => (i === 1 ? { ...l, id: "hook", start: 0.2 } : l)),
    };
    expect(defaultPosterSec(withHook)).toBe(1.1);
    expect(defaultPosterSec({ layers: [], durationSec: 0.5 })).toBe(0.4);
  });

  it("luminancia de lo visible: el fondo transparente no cuenta", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fg-lum-"));
    try {
      const white = path.join(dir, "white-on-clear.png");
      const dark = path.join(dir, "dark.png");
      const clear = path.join(dir, "clear.png");
      // 100×100 transparente con un cuadrado blanco de 20×20 en el medio.
      await sharp({
        create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([
          {
            input: await sharp({
              create: { width: 20, height: 20, channels: 4, background: "#ffffff" },
            })
              .png()
              .toBuffer(),
            left: 40,
            top: 40,
          },
        ])
        .png()
        .toFile(white);
      await sharp({ create: { width: 10, height: 10, channels: 3, background: "#0a0a0b" } })
        .png()
        .toFile(dark);
      await sharp({
        create: { width: 10, height: 10, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 0 } },
      })
        .png()
        .toFile(clear);
      expect(await visibleLuminance(white)).toBeGreaterThan(0.95);
      expect(await visibleLuminance(dark)).toBeLessThan(0.01);
      expect(await visibleLuminance(clear)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
