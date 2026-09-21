import { describe, expect, it } from "vitest";
import { SeededRng } from "./index.js";

describe("SeededRng", () => {
  it("misma semilla, misma secuencia", () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it("un peso de 0 nunca sale — lo necesita angleWeights del PRD", () => {
    const rng = new SeededRng(7);
    const items = [
      { value: "nunca", weight: 0 },
      { value: "siempre", weight: 1 },
    ];
    for (let i = 0; i < 500; i++) expect(rng.weightedPick(items)).toBe("siempre");
  });

  it("respeta la proporción de pesos", () => {
    const rng = new SeededRng(3);
    const items = [
      { value: "a", weight: 3 },
      { value: "b", weight: 1 },
    ];
    let a = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (rng.weightedPick(items) === "a") a++;
    expect(a / n).toBeGreaterThan(0.71);
    expect(a / n).toBeLessThan(0.79);
  });

  it("rechaza lista vacía y suma de pesos no positiva", () => {
    const rng = new SeededRng();
    expect(() => rng.weightedPick([])).toThrow(/vacía/);
    expect(() => rng.weightedPick([{ value: "x", weight: 0 }])).toThrow(/no es positiva/);
  });
});
