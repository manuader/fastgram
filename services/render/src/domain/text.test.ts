/**
 * Los números de `FR-051` son normativos. Regla de IMPL §4: "toda regla de
 * negocio con un número en el PRD lleva un test que fija ese número".
 */
import { describe, expect, it } from "vitest";
import {
  EDITOR_REFERENCE_WIDTH,
  editorUnitsToCanvasPx,
  textObjectListSchema,
  textObjectSchema,
} from "./text.js";

const base = {
  id: "t1",
  text: "hola",
  position: { x: 50, y: 50 },
  widthPercent: 80,
  font: { family: "montserrat", weight: 500, size: 24 },
} as const;

function parse(overrides: Record<string, unknown> = {}) {
  return textObjectSchema.safeParse({ ...base, ...overrides });
}

describe("text object — rangos de FR-051", () => {
  it("acepta el mínimo viable y aplica los defaults del inspector", () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Defaults literales del inspector de `FR-051`.
    expect(result.data.color).toBe("#FFFFFF");
    expect(result.data.stroke).toEqual({ width: 3, color: "#000000" });
    expect(result.data.background).toBeNull();
    expect(result.data.align).toBe("center");
  });

  it("text ≤ 5000 caracteres y puede estar vacío", () => {
    expect(parse({ text: "" }).success).toBe(true);
    expect(parse({ text: "a".repeat(5000) }).success).toBe(true);
    expect(parse({ text: "a".repeat(5001) }).success).toBe(false);
  });

  it("position.x / position.y ∈ [0, 100]", () => {
    expect(parse({ position: { x: 0, y: 0 } }).success).toBe(true);
    expect(parse({ position: { x: 100, y: 100 } }).success).toBe(true);
    expect(parse({ position: { x: -0.1, y: 0 } }).success).toBe(false);
    expect(parse({ position: { x: 0, y: 100.1 } }).success).toBe(false);
  });

  it("widthPercent ∈ [25, 100]", () => {
    expect(parse({ widthPercent: 25 }).success).toBe(true);
    expect(parse({ widthPercent: 100 }).success).toBe(true);
    expect(parse({ widthPercent: 24.9 }).success).toBe(false);
    expect(parse({ widthPercent: 100.1 }).success).toBe(false);
  });

  it("font.size ∈ [8, 72]", () => {
    expect(parse({ font: { family: "inter", weight: 400, size: 8 } }).success).toBe(true);
    expect(parse({ font: { family: "inter", weight: 400, size: 72 } }).success).toBe(
      true,
    );
    expect(parse({ font: { family: "inter", weight: 400, size: 7 } }).success).toBe(
      false,
    );
    expect(parse({ font: { family: "inter", weight: 400, size: 73 } }).success).toBe(
      false,
    );
  });

  it("stroke.width ∈ [0, 8]", () => {
    expect(parse({ stroke: { width: 0, color: "#000000" } }).success).toBe(true);
    expect(parse({ stroke: { width: 8, color: "#000000" } }).success).toBe(true);
    expect(parse({ stroke: { width: 8.1, color: "#000000" } }).success).toBe(false);
    expect(parse({ stroke: { width: -1, color: "#000000" } }).success).toBe(false);
  });

  it("los colores son #RRGGBB", () => {
    expect(parse({ color: "#ff00AA" }).success).toBe(true);
    expect(parse({ color: "#fff" }).success).toBe(false);
    expect(parse({ color: "white" }).success).toBe(false);
    expect(parse({ color: "rgb(1,2,3)" }).success).toBe(false);
  });

  it("background.opacity ∈ [0,1] y style ∈ {pill, full-width}; null elimina el fondo", () => {
    expect(parse({ background: null }).success).toBe(true);
    expect(
      parse({ background: { color: "#FFFFFF", opacity: 0, style: "pill" } }).success,
    ).toBe(true);
    expect(
      parse({ background: { color: "#FFFFFF", opacity: 1, style: "full-width" } })
        .success,
    ).toBe(true);
    expect(
      parse({ background: { color: "#FFFFFF", opacity: 1.1, style: "pill" } }).success,
    ).toBe(false);
    expect(
      parse({ background: { color: "#FFFFFF", opacity: 1, style: "rounded" } }).success,
    ).toBe(false);
  });

  it("textAlign ∈ {left, center, right}", () => {
    for (const align of ["left", "center", "right"]) {
      expect(parse({ align }).success).toBe(true);
    }
    expect(parse({ align: "justify" }).success).toBe(false);
  });

  it("rechaza campos desconocidos", () => {
    expect(parse({ shadow: true }).success).toBe(false);
    expect(
      textObjectSchema.safeParse({
        ...base,
        font: { family: "inter", weight: 400, size: 12, italic: true },
      }).success,
    ).toBe(false);
  });
});

describe("lista de cajas — FR-051", () => {
  it("rechaza textBoxes vacío", () => {
    expect(textObjectListSchema.safeParse([]).success).toBe(false);
  });

  it("rechaza IDs duplicados", () => {
    const result = textObjectListSchema.safeParse([base, { ...base, text: "otro" }]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((issue) => issue.message.includes("id duplicado")),
    ).toBe(true);
  });

  it("acepta IDs distintos", () => {
    expect(textObjectListSchema.safeParse([base, { ...base, id: "t2" }]).success).toBe(
      true,
    );
  });
});

describe("unidades de editor → píxeles del lienzo (PRD, «Payloads de build»)", () => {
  it("la vista previa de referencia mide 360 px de ancho", () => {
    expect(EDITOR_REFERENCE_WIDTH).toBe(360);
  });

  it("en un canvas de 360 el factor es ×1", () => {
    expect(editorUnitsToCanvasPx(18, 360)).toBe(18);
    expect(editorUnitsToCanvasPx(3, 360)).toBe(3);
  });

  it("en 1080 el factor es ×3: el 18 por defecto sale a 54 px y el stroke 3 a 9", () => {
    expect(editorUnitsToCanvasPx(18, 1080)).toBe(54);
    expect(editorUnitsToCanvasPx(3, 1080)).toBe(9);
    expect(editorUnitsToCanvasPx(8, 1080)).toBe(24);
    expect(editorUnitsToCanvasPx(72, 1080)).toBe(216);
  });

  it("en un canvas impar redondea al entero más cercano", () => {
    // 1001 / 360 = 2.78…: 18 → 50.05, 20 → 55.61, 3 → 8.34.
    expect(editorUnitsToCanvasPx(18, 1001)).toBe(50);
    expect(editorUnitsToCanvasPx(20, 1001)).toBe(56);
    expect(editorUnitsToCanvasPx(3, 1001)).toBe(8);
  });

  it("stroke 0 sigue siendo 0 en cualquier canvas", () => {
    expect(editorUnitsToCanvasPx(0, 1080)).toBe(0);
  });
});
