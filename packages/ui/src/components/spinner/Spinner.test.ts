import { describe, expect, it } from "vitest";
import { spinnerVariants } from "./spinner.variants";

describe("spinnerVariants", () => {
  it("por defecto es md y hereda el color del texto", () => {
    expect(spinnerVariants()).toBe("fg-spinner fg-spinner--md fg-spinner--current");
  });

  it("cubre los cuatro tamaños", () => {
    for (const size of ["xs", "sm", "md", "lg"] as const) {
      expect(spinnerVariants({ size })).toContain(`fg-spinner--${size}`);
    }
  });

  it("permite forzar el tono", () => {
    expect(spinnerVariants({ tone: "accent" })).toContain("fg-spinner--accent");
  });
});
