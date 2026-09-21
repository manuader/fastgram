import { describe, expect, it } from "vitest";
import { skeletonVariants } from "./skeleton.variants.js";

describe("skeletonVariants", () => {
  it("por defecto es un rectángulo", () => {
    expect(skeletonVariants()).toBe("fg-skeleton fg-skeleton--rect");
  });

  it("cubre texto, rectángulo y círculo", () => {
    for (const shape of ["text", "rect", "circle"] as const) {
      expect(skeletonVariants({ shape })).toContain(`fg-skeleton--${shape}`);
    }
  });
});
