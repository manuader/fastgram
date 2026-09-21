import { describe, expect, it } from "vitest";
import { textareaVariants } from "./textarea.variants.js";

describe("textareaVariants", () => {
  it("por defecto sólo se estira en vertical", () => {
    expect(textareaVariants()).toBe("fg-textarea fg-textarea--resize-y");
  });

  it("cubre los tres modos de resize", () => {
    expect(textareaVariants({ resize: "none" })).toContain("fg-textarea--resize-none");
    expect(textareaVariants({ resize: "vertical" })).toContain("fg-textarea--resize-y");
    expect(textareaVariants({ resize: "both" })).toContain("fg-textarea--resize-both");
  });

  it("marca el estado inválido", () => {
    expect(textareaVariants({ invalid: true })).toContain("fg-textarea--invalid");
  });
});
