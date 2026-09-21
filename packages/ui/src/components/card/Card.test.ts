import { describe, expect, it } from "vitest";
import { cardVariants } from "./card.variants.js";

describe("cardVariants", () => {
  it("por defecto es superficie con padding md y no interactiva", () => {
    expect(cardVariants()).toBe("fg-card fg-card--default fg-card--pad-md");
  });

  it("cubre los cuatro tonos", () => {
    for (const tone of ["default", "raised", "sunken", "outline"] as const) {
      expect(cardVariants({ tone })).toContain(`fg-card--${tone}`);
    }
  });

  it("cubre los cuatro paddings", () => {
    for (const padding of ["none", "sm", "md", "lg"] as const) {
      expect(cardVariants({ padding })).toContain(`fg-card--pad-${padding}`);
    }
  });

  it("interactive sólo añade clase cuando es true", () => {
    expect(cardVariants({ interactive: true })).toContain("fg-card--interactive");
    expect(cardVariants({ interactive: false })).not.toContain("fg-card--interactive");
  });
});
