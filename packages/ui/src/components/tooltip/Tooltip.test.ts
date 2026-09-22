import { describe, expect, it } from "vitest";
import { tooltipVariants } from "./tooltip.variants";

describe("tooltipVariants", () => {
  it("por defecto aparece arriba", () => {
    expect(tooltipVariants()).toBe("fg-tooltip__content fg-tooltip__content--top");
  });

  it("cubre los cuatro lados", () => {
    for (const side of ["top", "right", "bottom", "left"] as const) {
      expect(tooltipVariants({ side })).toContain(`fg-tooltip__content--${side}`);
    }
  });
});
