import { describe, expect, it } from "vitest";
import { nextRovingIndex } from "./roving.js";

describe("nextRovingIndex", () => {
  it("avanza y retrocede en horizontal", () => {
    expect(nextRovingIndex({ current: 0, count: 3, key: "ArrowRight" })).toBe(1);
    expect(nextRovingIndex({ current: 1, count: 3, key: "ArrowLeft" })).toBe(0);
  });

  it("da la vuelta cuando loop está activo (patrón tablist de ARIA)", () => {
    expect(nextRovingIndex({ current: 2, count: 3, key: "ArrowRight" })).toBe(0);
    expect(nextRovingIndex({ current: 0, count: 3, key: "ArrowLeft" })).toBe(2);
  });

  it("se frena en los extremos con loop desactivado", () => {
    expect(nextRovingIndex({ current: 2, count: 3, key: "ArrowRight", loop: false })).toBe(2);
    expect(nextRovingIndex({ current: 0, count: 3, key: "ArrowLeft", loop: false })).toBe(0);
  });

  it("en vertical responde a las flechas verticales, no a las horizontales", () => {
    const vertical = { current: 0, count: 3, orientation: "vertical" as const };
    expect(nextRovingIndex({ ...vertical, key: "ArrowDown" })).toBe(1);
    expect(nextRovingIndex({ ...vertical, key: "ArrowUp" })).toBe(2);
    expect(nextRovingIndex({ ...vertical, key: "ArrowRight" })).toBeNull();
  });

  it("Home y End van a los extremos", () => {
    expect(nextRovingIndex({ current: 1, count: 4, key: "Home" })).toBe(0);
    expect(nextRovingIndex({ current: 1, count: 4, key: "End" })).toBe(3);
  });

  it("devuelve null para teclas ajenas, para no comerse el evento", () => {
    expect(nextRovingIndex({ current: 0, count: 3, key: "a" })).toBeNull();
    expect(nextRovingIndex({ current: 0, count: 3, key: "Enter" })).toBeNull();
  });

  it("no revienta con una lista vacía", () => {
    expect(nextRovingIndex({ current: 0, count: 0, key: "ArrowRight" })).toBeNull();
  });
});
