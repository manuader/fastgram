/**
 * Dónde cae el texto en el lienzo — `FR-051`, decisión del dueño 2026-09-24.
 *
 * `position` es el **centro** de la caja en % del lienzo; `widthPercent` es el
 * ancho de la caja; el texto hace wrap a ese ancho y crece hacia arriba y abajo
 * desde el centro. Estos tests miden el resultado de verdad: dibujan el overlay
 * y buscan el rectángulo de píxeles no transparentes. Un test sobre la
 * geometría calculada no detectaría un `composite` que la ignora.
 *
 * Tolerancias: los glifos tienen side bearings de unos pocos píxeles y el
 * contorno se sintetiza con un anillo de desplazamientos, así que el borde de
 * tinta no coincide al píxel con el borde de la caja. 3 px sobre 1080 no se ven;
 * el error que esto persigue (esquina en vez de centro, alineación ignorada) se
 * mide en cientos.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Canvas } from "../domain/canvas.js";
import type { TextObject } from "../domain/text.js";
import { renderTextOverlay } from "./textLayer.js";

const FONTS = { fontDir: null, strict: false } as const;
const TOL = 3;

function box(overrides: Partial<TextObject> = {}): TextObject {
  return {
    id: "t",
    text: "Centro",
    position: { x: 50, y: 50 },
    widthPercent: 80,
    align: "center",
    font: { family: "inter", weight: 700, size: 18 },
    color: "#FFFFFF",
    stroke: { width: 0, color: "#000000" },
    background: null,
    ...overrides,
  };
}

interface Bbox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Rectángulo de los píxeles con alfa > 0. `maxX`/`maxY` exclusivos. */
async function inkBbox(png: Buffer): Promise<Bbox> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3] ?? 0;
      if (alpha === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + 1 > maxX) maxX = x + 1;
      if (y + 1 > maxY) maxY = y + 1;
    }
  }
  if (minX === Infinity) throw new Error("el overlay salió vacío");
  return { minX, minY, maxX, maxY };
}

async function bboxOf(boxes: TextObject[], canvas: Canvas): Promise<Bbox> {
  const overlay = await renderTextOverlay(boxes, canvas, FONTS);
  return inkBbox(overlay.png);
}

const center = (b: Bbox) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });

describe("una caja en (50, 50) queda centrada en el lienzo", () => {
  it("1080×1350", async () => {
    const b = await bboxOf([box()], { width: 1080, height: 1350 });
    expect(Math.abs(center(b).x - 540)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(center(b).y - 675)).toBeLessThanOrEqual(TOL);
  });

  it("1080×1920, con varias líneas: crece hacia arriba y abajo desde el centro", async () => {
    const texto = "Una línea larga que tiene que partirse en varias dentro de la caja";
    const b = await bboxOf([box({ text: texto, widthPercent: 50 })], {
      width: 1080,
      height: 1920,
    });
    expect(Math.abs(center(b).x - 540)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(center(b).y - 960)).toBeLessThanOrEqual(TOL);
    // Hizo wrap: más alto que una línea (54 px de fuente) y no más ancho que la caja.
    expect(b.maxY - b.minY).toBeGreaterThan(54 * 2);
    expect(b.maxX - b.minX).toBeLessThanOrEqual(540);
  });
});

describe("la caja se mueve con `position`, medida por su centro", () => {
  it("(20, 75) en 1080×1920 → centro de tinta en (216, 1440)", async () => {
    const b = await bboxOf([box({ position: { x: 20, y: 75 }, widthPercent: 30 })], {
      width: 1080,
      height: 1920,
    });
    expect(Math.abs(center(b).x - 216)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(center(b).y - 1440)).toBeLessThanOrEqual(TOL);
  });

  it("cambiar la fuente no mueve el centro", async () => {
    const chica = await bboxOf([box({ position: { x: 70, y: 30 } })], {
      width: 1080,
      height: 1350,
    });
    const grande = await bboxOf(
      [
        box({
          position: { x: 70, y: 30 },
          font: { family: "inter", weight: 700, size: 36 },
        }),
      ],
      { width: 1080, height: 1350 },
    );
    expect(Math.abs(center(chica).x - center(grande).x)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(center(chica).y - center(grande).y)).toBeLessThanOrEqual(TOL);
    expect(grande.maxX - grande.minX).toBeGreaterThan((chica.maxX - chica.minX) * 1.5);
  });
});

describe("la alineación se resuelve contra la caja, no contra el texto", () => {
  // Caja de 80 % centrada: de 108 a 972 px.
  it("left: el texto arranca en el borde izquierdo de la caja", async () => {
    const b = await bboxOf([box({ align: "left" })], { width: 1080, height: 1350 });
    expect(b.minX).toBeGreaterThanOrEqual(108);
    expect(b.minX).toBeLessThanOrEqual(108 + 8);
  });

  it("right: el texto termina en el borde derecho de la caja", async () => {
    const b = await bboxOf([box({ align: "right" })], { width: 1080, height: 1350 });
    expect(b.maxX).toBeLessThanOrEqual(972);
    expect(b.maxX).toBeGreaterThanOrEqual(972 - 8);
  });
});

describe("fondo full-width", () => {
  it("la banda cubre todo el ancho aunque la caja no esté centrada", async () => {
    const b = await bboxOf(
      [
        box({
          position: { x: 30, y: 50 },
          widthPercent: 40,
          background: { color: "#000000", opacity: 1, style: "full-width" },
        }),
      ],
      { width: 1080, height: 1350 },
    );
    expect(b.minX).toBe(0);
    expect(b.maxX).toBe(1080);
  });
});
