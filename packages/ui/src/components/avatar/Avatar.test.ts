import { describe, expect, it } from "vitest";
import { getInitials } from "../../lib/initials.js";
import { avatarVariants } from "./avatar.variants.js";

describe("avatarVariants", () => {
  it("por defecto es md y circular", () => {
    expect(avatarVariants()).toBe("fg-avatar fg-avatar--md fg-avatar--circle");
  });

  it("cubre los cinco tamaños y las dos formas", () => {
    for (const size of ["xs", "sm", "md", "lg", "xl"] as const) {
      expect(avatarVariants({ size })).toContain(`fg-avatar--${size}`);
    }
    for (const shape of ["circle", "square"] as const) {
      expect(avatarVariants({ shape })).toContain(`fg-avatar--${shape}`);
    }
  });
});

describe("fallback del avatar", () => {
  it("las iniciales salen del nombre del influencer", () => {
    expect(getInitials("Mia Carter")).toBe("MC");
  });
});
