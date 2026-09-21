import { describe, expect, it } from "vitest";
import { emptyStatePresets, resolveStatePreset } from "../../i18n/presets.js";
import { emptyStateVariants } from "./empty-state.variants.js";

describe("emptyStateVariants", () => {
  it("por defecto es md y sin borde", () => {
    expect(emptyStateVariants()).toBe("fg-state fg-state--md");
  });

  it("cubre los tres tamaños y el borde punteado", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      expect(emptyStateVariants({ size })).toContain(`fg-state--${size}`);
    }
    expect(emptyStateVariants({ bordered: true })).toContain("fg-state--bordered");
  });
});

describe("EmptyState con preset del PRD", () => {
  it("ERR-E04 renderiza el copy literal del Media Bank vacío", () => {
    expect(resolveStatePreset(emptyStatePresets["ERR-E04"])).toEqual({
      title: "No images uploaded yet",
    });
  });

  it("ERR-E02 trae título y descripción", () => {
    expect(resolveStatePreset(emptyStatePresets["ERR-E02"])).toEqual({
      title: "No results",
      description: "Try a different search or clear your filters.",
    });
  });

  it("ERR-E13 interpola el handle del perfil social", () => {
    expect(
      resolveStatePreset(emptyStatePresets["ERR-E13"], { handle: "fastgram" }),
    ).toEqual({
      title:
        "@fastgram doesn't have enough posts yet. Add another source or describe your brand.",
    });
  });

  it("ERR-E12 trae además el label de su acción", () => {
    const resolved = resolveStatePreset(emptyStatePresets["ERR-E12"]);
    expect(resolved.actionLabel).toBe("+ Add source");
  });
});
