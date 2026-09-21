import { describe, expect, it } from "vitest";
import {
  PAGINATION,
  buildPage,
  decodeCursor,
  encodeCursor,
  normaliseLimit,
} from "./pagination.js";

describe("límites del PRD §9.10", () => {
  it("limit 1–100, default 20", () => {
    expect(PAGINATION).toEqual({ minLimit: 1, maxLimit: 100, defaultLimit: 20 });
  });

  it("recorta fuera de rango en vez de fallar", () => {
    expect(normaliseLimit(undefined)).toBe(20);
    expect(normaliseLimit(0)).toBe(1);
    expect(normaliseLimit(1000)).toBe(100);
    expect(normaliseLimit(50)).toBe(50);
    expect(normaliseLimit(7.5)).toBe(20);
  });
});

describe("cursor", () => {
  it("ida y vuelta", () => {
    const p = { createdAtMs: 1_700_000_000_000, id: "ct_abc" };
    expect(decodeCursor(encodeCursor(p))).toEqual(p);
  });

  it("un cursor corrupto devuelve null, no una excepción", () => {
    // Entrada inválida del cliente, no un 500 nuestro.
    expect(decodeCursor("no-es-base64!!")).toBeNull();
    expect(decodeCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("buildPage", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `r${i}`, createdAtMs: 1000 + i }));
  const toCursor = (r: { id: string; createdAtMs: number }) => r;

  it("sin fila de más, no hay siguiente página", () => {
    const page = buildPage(rows(20), 20, toCursor);
    expect(page.data).toHaveLength(20);
    expect(page.pagination).toEqual({ cursor: null, hasMore: false });
  });

  it("con la fila 21 leída, hay más y el cursor apunta a la 20", () => {
    // Leer `limit + 1` es lo que evita un COUNT(*) para saber si hay más.
    const page = buildPage(rows(21), 20, toCursor);
    expect(page.data).toHaveLength(20);
    expect(page.pagination.hasMore).toBe(true);
    expect(decodeCursor(page.pagination.cursor ?? "")).toEqual({
      id: "r19",
      createdAtMs: 1019,
    });
  });

  it("una página vacía no rompe", () => {
    expect(buildPage([], 20, toCursor).pagination).toEqual({
      cursor: null,
      hasMore: false,
    });
  });
});
