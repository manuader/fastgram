import { describe, expect, it } from "vitest";
import { getPaginationRange } from "./pagination.js";

describe("getPaginationRange", () => {
  it("sin páginas devuelve una lista vacía", () => {
    expect(getPaginationRange({ current: 1, total: 0 })).toEqual([]);
  });

  it("muestra todas las páginas cuando entran sin elipsis", () => {
    expect(getPaginationRange({ current: 1, total: 7 })).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("elipsis sólo a la derecha cerca del principio", () => {
    expect(getPaginationRange({ current: 1, total: 100 })).toEqual([
      1, 2, 3, 4, 5, "ellipsis", 100,
    ]);
  });

  it("elipsis a los dos lados en el medio", () => {
    expect(getPaginationRange({ current: 50, total: 100 })).toEqual([
      1, "ellipsis", 49, 50, 51, "ellipsis", 100,
    ]);
  });

  it("elipsis sólo a la izquierda cerca del final", () => {
    expect(getPaginationRange({ current: 100, total: 100 })).toEqual([
      1, "ellipsis", 96, 97, 98, 99, 100,
    ]);
  });

  it("el ancho del control no cambia al moverse de página", () => {
    const widths = new Set<number>();
    for (let page = 1; page <= 100; page += 1) {
      widths.add(getPaginationRange({ current: page, total: 100 }).length);
    }
    expect([...widths]).toEqual([7]);
  });

  it("acota una página fuera de rango en vez de romper", () => {
    expect(getPaginationRange({ current: 0, total: 5 })).toEqual([1, 2, 3, 4, 5]);
    expect(getPaginationRange({ current: 99, total: 5 })).toEqual([1, 2, 3, 4, 5]);
  });

  it("respeta siblings y boundaries", () => {
    expect(getPaginationRange({ current: 50, total: 100, siblings: 2 })).toEqual([
      1, "ellipsis", 48, 49, 50, 51, 52, "ellipsis", 100,
    ]);
    expect(
      getPaginationRange({ current: 50, total: 100, siblings: 0, boundaries: 2 }),
    ).toEqual([1, 2, "ellipsis", 50, "ellipsis", 99, 100]);
  });
});
