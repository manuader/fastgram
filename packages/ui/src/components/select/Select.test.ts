import { describe, expect, it } from "vitest";
import { selectVariants } from "./select.variants.js";

describe("selectVariants", () => {
  it("por defecto es md y válido", () => {
    expect(selectVariants()).toBe("fg-select__control fg-select__control--md");
  });

  it("cubre los tres tamaños", () => {
    for (const selectSize of ["sm", "md", "lg"] as const) {
      expect(selectVariants({ selectSize })).toContain(`fg-select__control--${selectSize}`);
    }
  });

  it("marca el estado inválido", () => {
    expect(selectVariants({ invalid: true })).toContain("fg-select__control--invalid");
  });
});
