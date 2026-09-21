import { describe, expect, it } from "vitest";
import { inputVariants } from "./input.variants.js";

describe("inputVariants", () => {
  it("por defecto es md y válido", () => {
    expect(inputVariants()).toBe("fg-input fg-input--md");
  });

  it("cubre los tres tamaños", () => {
    for (const inputSize of ["sm", "md", "lg"] as const) {
      expect(inputVariants({ inputSize })).toContain(`fg-input--${inputSize}`);
    }
  });

  it("marca el estado inválido con una clase propia", () => {
    expect(inputVariants({ invalid: true })).toContain("fg-input--invalid");
    expect(inputVariants({ invalid: false })).not.toContain("fg-input--invalid");
  });

  it("reserva espacio para el icono sólo cuando hay icono", () => {
    expect(inputVariants({ hasLeadingIcon: true })).toContain("fg-input--with-icon");
    expect(inputVariants({ hasLeadingIcon: false })).not.toContain("fg-input--with-icon");
  });
});
