import { describe, expect, it } from "vitest";
import { switchVariants } from "./switch.variants.js";

describe("switchVariants", () => {
  it("por defecto es md", () => {
    expect(switchVariants()).toBe("fg-switch fg-switch--md");
  });

  it("cubre los dos tamaños", () => {
    for (const switchSize of ["sm", "md"] as const) {
      expect(switchVariants({ switchSize })).toContain(`fg-switch--${switchSize}`);
    }
  });
});
