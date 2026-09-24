/**
 * `PU-EDIT-004` — la geometría del preview es la del render.
 *
 * Los esperados son **los mismos números literales** que fijan
 * `packages/core/src/content/text-boxes-to-build-payload.test.ts` (centro +
 * ancho en px de canvas) y `services/render` (`18` → 54 px en 1080). No se
 * recalculan con la fórmula: si alguien cambia el mapeo de un lado, este
 * archivo tiene que dejar de coincidir.
 */
import { describe, expect, it } from "vitest";
import {
  boxToCanvasGeometry,
  boxToPreviewGeometry,
  clampWidthPercent,
  editorUnitsToCanvasPx,
  moveBox,
  nudgeFor,
  panRect,
  pointerDeltaToPercent,
  previewHeight,
  renderedBackground,
  resizeFromEdge,
  zoomPercentOf,
  zoomRect,
} from "./geometry";

const P1350 = { width: 1080, height: 1350 };
const P1920 = { width: 1080, height: 1920 };

const box = (over: Partial<Parameters<typeof boxToCanvasGeometry>[0]> = {}) => ({
  position: { x: 50, y: 50 },
  widthPercent: 80,
  font: { family: "inter" as const, weight: 700, size: 18 },
  stroke: { width: 3, color: "#000000" },
  ...over,
});

describe("escala 360 (decisión 2026-09-23)", () => {
  it("18 unidades en 1080 → 54 px; 3 → 9", () => {
    expect(editorUnitsToCanvasPx(18, 1080)).toBe(54);
    expect(editorUnitsToCanvasPx(3, 1080)).toBe(9);
  });

  it("redondea a entero como el render: 17 en 1000 → 47", () => {
    expect(editorUnitsToCanvasPx(17, 1000)).toBe(47);
  });
});

describe("caja → px de canvas (centro + ancho, decisión 2026-09-24)", () => {
  it("(50,50) al 80 % en 1080×1350 → centro (540, 675), ancho 864", () => {
    const g = boxToCanvasGeometry(box(), P1350);
    expect([g.x, g.y, g.width]).toEqual([540, 675, 864]);
    expect([g.fontSizePx, g.strokeWidthPx]).toEqual([54, 9]);
  });

  it("(50,50) al 80 % en 1080×1920 → centro (540, 960), ancho 864", () => {
    const g = boxToCanvasGeometry(box(), P1920);
    expect([g.x, g.y, g.width]).toEqual([540, 960, 864]);
  });

  it("(25,10) al 50 % en 1080×1920 → (270, 192), ancho 540", () => {
    const g = boxToCanvasGeometry(
      box({ position: { x: 25, y: 10 }, widthPercent: 50 }),
      P1920,
    );
    expect([g.x, g.y, g.width]).toEqual([270, 192, 540]);
  });

  it("33,3 % no arrastra ruido de coma flotante (round4)", () => {
    expect(boxToCanvasGeometry(box({ position: { x: 33.3, y: 0 } }), P1920).x).toBe(
      359.64,
    );
  });
});

describe("px de canvas → preview", () => {
  it("a 360 de ancho las unidades de editor son px (salvo el redondeo del render)", () => {
    const g = boxToPreviewGeometry(box(), P1920, 360);
    expect(g.centerX).toBe(180);
    expect(g.centerY).toBe(320);
    expect(g.width).toBe(288);
    expect(g.fontSize).toBe(18);
    expect(g.strokeWidth).toBe(3);
    // Ancho útil: 864 − 2·9 = 846 px de canvas → 282 en el preview.
    expect(g.wrapWidth).toBe(282);
    // Padding del fondo: round(54 · 0,35) = 19 px de canvas.
    expect(g.backgroundPadding).toBeCloseTo(19 / 3, 10);
  });

  it("el alto respeta el aspecto del canvas", () => {
    expect(previewHeight(360, P1920)).toBe(640);
    expect(previewHeight(360, P1350)).toBe(450);
  });
});

describe("movimiento", () => {
  it("un drag de 36 px en un preview de 360×640 es 10 % en x y 5,625 % en y", () => {
    expect(pointerDeltaToPercent(36, 36, { width: 360, height: 640 })).toEqual({
      dx: 10,
      dy: 5.625,
    });
  });

  it("moveBox acota a [0, 100]", () => {
    expect(moveBox(box({ position: { x: 98, y: 2 } }), 5, -5).position).toEqual({
      x: 100,
      y: 0,
    });
  });

  it("flechas: 1 %, Shift 5 %; otra tecla, null", () => {
    expect(nudgeFor("ArrowRight", false)).toEqual({ dx: 1, dy: 0 });
    expect(nudgeFor("ArrowUp", true)).toEqual({ dx: 0, dy: -5 });
    expect(nudgeFor("a", false)).toBeNull();
  });

  it("el ancho queda en [25, 100]", () => {
    expect(clampWidthPercent(10)).toBe(25);
    expect(clampWidthPercent(140)).toBe(100);
  });

  it("arrastrar el borde 18 px en 360 agrega 10 % (crece a los dos lados)", () => {
    expect(resizeFromEdge(50, 18, 360)).toBe(60);
    expect(resizeFromEdge(30, -100, 360)).toBe(25);
  });
});

describe("video del green-screen", () => {
  const base = { drawX: 0, drawY: 0, drawW: 1080, drawH: 1920 };

  it("zoom 150 % alrededor del centro", () => {
    expect(zoomRect(base, base, 1.5)).toEqual({
      drawX: -270,
      drawY: -480,
      drawW: 1620,
      drawH: 2880,
    });
    expect(zoomPercentOf(base, { ...base, drawW: 1620 })).toBe(150);
  });

  it("arrastrar 36 px en un preview de 360 mueve 108 px de canvas", () => {
    expect(panRect(base, 36, -36, 360, P1920)).toMatchObject({ drawX: 108, drawY: -108 });
  });
});

describe("el fondo que sale en el video", () => {
  it("cualquier fondo visible sale como pill opaco del mismo color", () => {
    expect(
      renderedBackground({ color: "#112233", opacity: 0.4, style: "full-width" }),
    ).toEqual({ color: "#112233", radius: "pill" });
  });

  it("opacidad 0 o null: sin fondo", () => {
    expect(
      renderedBackground({ color: "#112233", opacity: 0, style: "pill" }),
    ).toBeNull();
    expect(renderedBackground(null)).toBeNull();
  });
});
