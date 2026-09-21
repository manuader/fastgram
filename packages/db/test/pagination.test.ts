/**
 * Cursor opaco — la parte que no necesita base (PRD §9.10).
 * La estabilidad real ante inserciones concurrentes se prueba contra Postgres en
 * `pagination.int.test.ts`; acá sólo la codificación y el clamp del límite.
 */

import { describe, expect, it } from "vitest";

import {
  buildPage,
  decodeCursor,
  encodeCursor,
  fetchLimit,
  InvalidCursorError,
  normalizeLimit,
} from "../src/pagination";
import { PAGINATION } from "../src/limits";

describe("normalizeLimit", () => {
  it("usa el default del PRD cuando no se pide nada", () => {
    expect(normalizeLimit()).toBe(PAGINATION.limitDefault);
    expect(normalizeLimit(undefined)).toBe(20);
  });

  it("clampa al rango 1–100 en vez de fallar", () => {
    expect(normalizeLimit(0)).toBe(1);
    expect(normalizeLimit(-7)).toBe(1);
    expect(normalizeLimit(101)).toBe(100);
    expect(normalizeLimit(10_000)).toBe(100);
  });

  it("respeta los extremos exactos", () => {
    expect(normalizeLimit(1)).toBe(1);
    expect(normalizeLimit(100)).toBe(100);
  });

  it("trunca fraccionales y descarta NaN/Infinity", () => {
    expect(normalizeLimit(20.9)).toBe(20);
    expect(normalizeLimit(Number.NaN)).toBe(20);
    expect(normalizeLimit(Number.POSITIVE_INFINITY)).toBe(20);
  });
});

describe("cursor", () => {
  const key = {
    createdAt: new Date("2026-09-21T10:11:12.345Z"),
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  };

  it("hace round-trip sin perder precisión de milisegundos", () => {
    const decoded = decodeCursor(encodeCursor(key));
    expect(decoded.createdAt.toISOString()).toBe("2026-09-21T10:11:12.345Z");
    expect(decoded.id).toBe(key.id);
  });

  it("es opaco: no expone el id en claro", () => {
    expect(encodeCursor(key)).not.toContain(key.id);
  });

  it("es url-safe (viaja como query param)", () => {
    expect(encodeCursor(key)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rechaza basura en vez de devolver una página arbitraria", () => {
    expect(() => decodeCursor("no-es-un-cursor")).toThrow(InvalidCursorError);
    expect(() => decodeCursor("")).toThrow(InvalidCursorError);
    expect(() =>
      decodeCursor(Buffer.from("sin-separador", "utf8").toString("base64url")),
    ).toThrow(InvalidCursorError);
    expect(() =>
      decodeCursor(Buffer.from("fecha-mala|abc", "utf8").toString("base64url")),
    ).toThrow(InvalidCursorError);
  });
});

describe("buildPage", () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({
    id: `id-${i}`,
    createdAt: new Date(2026, 0, 1 + i),
  }));
  const keyOf = (row: (typeof rows)[number]) => ({
    createdAt: row.createdAt,
    id: row.id,
  });

  it("pide una fila de más para saber si hay siguiente", () => {
    expect(fetchLimit(20)).toBe(21);
  });

  it("recorta la fila extra y devuelve cursor cuando hay más", () => {
    const page = buildPage(rows, 3, keyOf);
    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).not.toBeNull();
    // El cursor apunta a la última fila *devuelta*, no a la que se descartó.
    expect(decodeCursor(page.cursor as string).id).toBe("id-2");
  });

  it("cursor null en la última página — el contrato lo exige", () => {
    const page = buildPage(rows.slice(0, 2), 3, keyOf);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it("página vacía", () => {
    const page = buildPage([], 20, keyOf);
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
  });
});
