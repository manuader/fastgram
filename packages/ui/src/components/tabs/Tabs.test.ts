import { describe, expect, it } from "vitest";
import { nextRovingIndex } from "../../lib/roving";

// Las tabs de Library, PRD §3.3.
const LIBRARY_TABS = ["My Posts", "My Content", "My Media Bank"] as const;

describe("navegación con teclado de Tabs", () => {
  it("la flecha derecha avanza y da la vuelta al final", () => {
    const steps: string[] = [];
    let index = 0;
    for (let i = 0; i < LIBRARY_TABS.length; i += 1) {
      const next = nextRovingIndex({
        current: index,
        count: LIBRARY_TABS.length,
        key: "ArrowRight",
      });
      expect(next).not.toBeNull();
      index = next ?? index;
      const tab = LIBRARY_TABS[index];
      if (tab !== undefined) steps.push(tab);
    }
    expect(steps).toEqual(["My Content", "My Media Bank", "My Posts"]);
  });

  it("End salta a la última pestaña", () => {
    expect(nextRovingIndex({ current: 0, count: LIBRARY_TABS.length, key: "End" })).toBe(
      2,
    );
  });

  it("en una tablist horizontal las flechas verticales no hacen nada", () => {
    expect(
      nextRovingIndex({ current: 0, count: LIBRARY_TABS.length, key: "ArrowDown" }),
    ).toBeNull();
  });
});
