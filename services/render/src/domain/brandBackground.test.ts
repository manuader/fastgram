import { describe, expect, it } from "vitest";
import {
  blobOffsetAt,
  luma,
  normalizePalette,
  planBackground,
  seededRandom,
} from "./brandBackground.js";

const PALETTE = ["#1B1F3B", "#FF6B6B", "#FFD93D", "#6BCB77"];

describe("seededRandom", () => {
  it("la misma semilla da la misma secuencia, y otra semilla otra", () => {
    const a = seededRandom("marca-1");
    const b = seededRandom("marca-1");
    const c = seededRandom("marca-2");
    const sa = Array.from({ length: 8 }, () => a());
    const sb = Array.from({ length: 8 }, () => b());
    const sc = Array.from({ length: 8 }, () => c());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    for (const v of sa) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("planBackground — PU-MEDIA-002", () => {
  it("es determinista por (paleta, semilla)", () => {
    expect(planBackground(PALETTE, "s-1")).toEqual(planBackground(PALETTE, "s-1"));
  });

  it("no depende de mayúsculas ni duplicados en la paleta", () => {
    const lower = PALETTE.map((c) => c.toLowerCase());
    expect(planBackground([...lower, lower[0] ?? ""], "s-1")).toEqual(
      planBackground(PALETTE, "s-1"),
    );
  });

  it("varía con la semilla: veinte semillas no dan veinte veces lo mismo", () => {
    const specs = Array.from({ length: 20 }, (_, i) =>
      planBackground(PALETTE, `s-${String(i)}`),
    );
    const distinct = new Set(specs.map((s) => JSON.stringify(s)));
    expect(distinct.size).toBe(20);
    // Y los tres estilos aparecen: la variedad no es sólo de números.
    expect(new Set(specs.map((s) => s.style))).toEqual(
      new Set(["linear", "radial", "mesh"]),
    );
  });

  it("sólo usa colores de la paleta", () => {
    for (let i = 0; i < 30; i += 1) {
      const spec = planBackground(PALETTE, `c-${String(i)}`);
      const used = [...spec.stops.map((s) => s.color), ...spec.blobs.map((b) => b.color)];
      for (const color of used) expect(PALETTE).toContain(color);
    }
  });

  it("los degradés van ordenados por luminancia (en un sentido o en el otro)", () => {
    for (let i = 0; i < 30; i += 1) {
      const lumas = planBackground(PALETTE, `l-${String(i)}`).stops.map((s) =>
        luma(s.color),
      );
      const asc = lumas.every((v, j) => j === 0 || v >= (lumas[j - 1] ?? 0));
      const desc = lumas.every((v, j) => j === 0 || v <= (lumas[j - 1] ?? 0));
      expect(asc || desc).toBe(true);
    }
  });

  it("lanza con menos de dos colores distintos", () => {
    expect(() => planBackground(["#FFFFFF", "#ffffff"], "x")).toThrow(/dos colores/);
  });
});

describe("blobOffsetAt — el loop cierra por construcción", () => {
  it("t = 0 y t = D dan la misma posición para toda mancha", () => {
    for (let i = 0; i < 20; i += 1) {
      const spec = planBackground(PALETTE, `loop-${String(i)}`);
      for (const blob of spec.blobs) {
        for (const period of [6, 8, 10]) {
          const start = blobOffsetAt(blob, 0, period);
          const end = blobOffsetAt(blob, period, period);
          expect(end.dx).toBeCloseTo(start.dx, 10);
          expect(end.dy).toBeCloseTo(start.dy, 10);
        }
      }
    }
  });

  it("y en el medio se movió: no es un video quieto", () => {
    const spec = planBackground(PALETTE, "moves");
    const moved = spec.blobs.some((blob) => {
      const a = blobOffsetAt(blob, 0, 8);
      const b = blobOffsetAt(blob, 2, 8);
      return Math.abs(a.dx - b.dx) > 0.01 || Math.abs(a.dy - b.dy) > 0.01;
    });
    expect(moved).toBe(true);
  });
});

describe("normalizePalette", () => {
  it("mayúsculas, sin duplicados, en el orden recibido", () => {
    expect(normalizePalette(["#abcdef", "#123456", "#ABCDEF"])).toEqual([
      "#ABCDEF",
      "#123456",
    ]);
  });
});
