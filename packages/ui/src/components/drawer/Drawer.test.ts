import { describe, expect, it } from "vitest";
import { drawerVariants } from "./drawer.variants";

describe("drawerVariants", () => {
  it("por defecto entra por la derecha con ancho md", () => {
    expect(drawerVariants()).toBe("fg-drawer fg-drawer--right fg-drawer--md");
  });

  it("cubre los cuatro lados", () => {
    for (const side of ["left", "right", "top", "bottom"] as const) {
      expect(drawerVariants({ side })).toContain(`fg-drawer--${side}`);
    }
  });

  it("cubre los tres anchos", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      expect(drawerVariants({ size })).toContain(`fg-drawer--${size}`);
    }
  });
});
