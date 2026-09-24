import { describe, expect, it } from "vitest";
import { badgeVariants, PLATFORM_TONES } from "./badge.variants";

describe("badgeVariants", () => {
  it("por defecto es neutral/md", () => {
    expect(badgeVariants()).toBe("fg-badge fg-badge--neutral fg-badge--md");
  });

  it("tiene un tono por cada plataforma que publica el producto", () => {
    expect([...PLATFORM_TONES]).toEqual([
      "tiktok",
      "instagram",
      "youtube",
      "linkedin",
      "reddit",
      "x",
      "threads",
      "facebook",
    ]);
    for (const tone of PLATFORM_TONES) {
      expect(badgeVariants({ tone })).toContain(`fg-badge--${tone}`);
    }
  });

  it("cubre los tonos semánticos", () => {
    for (const tone of ["success", "warning", "danger", "info", "outline"] as const) {
      expect(badgeVariants({ tone })).toContain(`fg-badge--${tone}`);
    }
  });
});
