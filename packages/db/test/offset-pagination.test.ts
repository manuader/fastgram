/**
 * Paginación numerada — el `Page X of Y` que PRD §9.10 marca CONFIRMED.
 *
 * Es la aritmética de los bordes, que es donde esto se rompe siempre: la página 0,
 * la lista vacía, el total que es múltiplo exacto del tamaño de página, y la página
 * que quedó más allá del final porque alguien borró filas mientras el usuario miraba.
 */
import { describe, expect, it } from "vitest";

import { buildOffsetPage, normalizePage, offsetOf } from "../src/pagination";

describe("normalizePage", () => {
  it("la primera página es 1, no 0", () => {
    expect(normalizePage(1)).toBe(1);
    expect(normalizePage(undefined)).toBe(1);
  });

  it("una página inválida es la primera, no un error", () => {
    // Llega de un query param. Un 400 por `?page=0` sería correcto y también sería
    // una pantalla de error donde alcanzaba con mostrar la primera página.
    expect(normalizePage(0)).toBe(1);
    expect(normalizePage(-7)).toBe(1);
    expect(normalizePage(Number.NaN)).toBe(1);
    expect(normalizePage(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("trunca decimales en vez de redondear", () => {
    expect(normalizePage(2.9)).toBe(2);
  });
});

describe("offsetOf", () => {
  it("la página 1 no saltea nada", () => {
    expect(offsetOf(1, 20)).toBe(0);
  });

  it("la página 3 con 20 por página empieza en la fila 40", () => {
    expect(offsetOf(3, 20)).toBe(40);
  });
});

describe("buildOffsetPage", () => {
  it("cuenta las páginas hacia arriba: 21 filas de a 20 son 2 páginas", () => {
    const page = buildOffsetPage([], 1, 20, 21);
    expect(page.totalPages).toBe(2);
    expect(page.hasMore).toBe(true);
  });

  it("un total que es múltiplo exacto no agrega una página vacía", () => {
    // El error clásico es `floor(total/size) + 1`, que con 40 filas de a 20 ofrece
    // una página 3 que no existe y que devuelve una lista vacía.
    expect(buildOffsetPage([], 2, 20, 40).totalPages).toBe(2);
    expect(buildOffsetPage([], 2, 20, 40).hasMore).toBe(false);
  });

  it("sin resultados hay una página, no cero", () => {
    // "Page 1 of 0" no es una posición que exista. La UI muestra la primera página
    // con la lista vacía.
    const page = buildOffsetPage([], 1, 20, 0);
    expect(page.totalPages).toBe(1);
    expect(page.page).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(page.items).toEqual([]);
  });

  it("una página más allá del final no dice que hay más", () => {
    // Pasa de verdad: el usuario está en la página 5 y alguien borra filas.
    const page = buildOffsetPage([], 5, 20, 21);
    expect(page.totalPages).toBe(2);
    expect(page.hasMore).toBe(false);
  });

  it("devuelve las filas tal cual, sin recortar", () => {
    // Al revés que la paginación por cursor, acá el `LIMIT` ya dejó el tamaño justo:
    // no se pide una fila de más porque el `COUNT(*)` ya dijo cuántas hay.
    const rows = [{ id: "a" }, { id: "b" }];
    expect(buildOffsetPage(rows, 1, 20, 2).items).toEqual(rows);
  });
});
