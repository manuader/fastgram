import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button.variants.js";

describe("buttonVariants", () => {
  it("aplica primary/md por defecto", () => {
    expect(buttonVariants()).toBe("fg-btn fg-btn--primary fg-btn--md");
  });

  it("combina variante y tamaño", () => {
    expect(buttonVariants({ variant: "danger", size: "lg" })).toBe(
      "fg-btn fg-btn--danger fg-btn--lg",
    );
  });

  it("expone las cinco variantes y los cuatro tamaños del sistema", () => {
    const variants = ["primary", "secondary", "ghost", "danger", "link"] as const;
    const sizes = ["sm", "md", "lg", "icon"] as const;
    for (const variant of variants) {
      expect(buttonVariants({ variant })).toContain(`fg-btn--${variant}`);
    }
    for (const size of sizes) {
      expect(buttonVariants({ size })).toContain(`fg-btn--${size}`);
    }
  });

  it("fullWidth sólo añade clase cuando es true", () => {
    expect(buttonVariants({ fullWidth: true })).toContain("fg-btn--full");
    expect(buttonVariants({ fullWidth: false })).not.toContain("fg-btn--full");
    expect(buttonVariants()).not.toContain("fg-btn--full");
  });

  it("siempre lleva la clase base, que es la que trae el anillo de foco", () => {
    expect(buttonVariants({ variant: "link", size: "sm" }).split(" ")).toContain(
      "fg-btn",
    );
  });
});
