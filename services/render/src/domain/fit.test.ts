/** `P2-RENDER-012` / `EXT-006` — recorte inteligente en vez de stretch. */
import { describe, expect, it } from "vitest";
import { computePlacement, DEFAULT_FIT_MODE } from "./fit.js";

const target = { x: 0, y: 0, width: 1080, height: 1350 };

describe("computePlacement", () => {
  it("el default es cover: se recorta, no se deforma", () => {
    expect(DEFAULT_FIT_MODE).toBe("cover");
  });

  it("cover recorta a los costados una fuente más ancha que el destino", () => {
    // 1920×1080 (16:9) dentro de 1080×1350 (4:5).
    const placement = computePlacement({ width: 1920, height: 1080 }, target);
    expect(placement.crop.height).toBe(1080);
    expect(placement.crop.width).toBe(864); // 1080 * (1080/1350)
    expect(placement.crop.x).toBe(528); // centrado: (1920-864)/2
    expect(placement.crop.y).toBe(0);
    expect(placement.draw).toEqual(target);
    // La ventana de recorte tiene exactamente la ratio del destino: sin deformar.
    expect(placement.crop.width / placement.crop.height).toBeCloseTo(1080 / 1350, 5);
  });

  it("cover recorta arriba y abajo una fuente más alta que el destino", () => {
    const placement = computePlacement({ width: 1080, height: 1920 }, target);
    expect(placement.crop.width).toBe(1080);
    expect(placement.crop.height).toBe(1350);
    expect(placement.crop.y).toBe(285);
  });

  it("el punto focal decide qué sobrevive al recorte", () => {
    const top = computePlacement({ width: 1080, height: 1920 }, target, "cover", {
      x: 50,
      y: 0,
    });
    expect(top.crop.y).toBe(0);
    const bottom = computePlacement({ width: 1080, height: 1920 }, target, "cover", {
      x: 50,
      y: 100,
    });
    expect(bottom.crop.y).toBe(1920 - 1350);
  });

  it("no se sale de la fuente aunque el focal esté en el borde", () => {
    const placement = computePlacement({ width: 1920, height: 1080 }, target, "cover", {
      x: 0,
      y: 0,
    });
    expect(placement.crop.x).toBeGreaterThanOrEqual(0);
    expect(placement.crop.x + placement.crop.width).toBeLessThanOrEqual(1920);
  });

  it("stretch mantiene la paridad con la v1 del PRD: deforma", () => {
    const placement = computePlacement({ width: 1920, height: 1080 }, target, "stretch");
    expect(placement.crop).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(placement.draw).toEqual(target);
  });

  it("contain entra entero y centra, dejando banda", () => {
    const placement = computePlacement({ width: 1920, height: 1080 }, target, "contain");
    expect(placement.draw.width).toBe(1080);
    expect(placement.draw.height).toBe(608);
    expect(placement.draw.y).toBe(Math.round((1350 - 608) / 2));
  });

  it("una fuente con la misma ratio no se recorta", () => {
    const placement = computePlacement({ width: 2160, height: 2700 }, target);
    expect(placement.crop).toEqual({ x: 0, y: 0, width: 2160, height: 2700 });
  });

  it("rechaza fuentes sin dimensiones", () => {
    expect(() => computePlacement({ width: 0, height: 10 }, target)).toThrow(RangeError);
  });
});
