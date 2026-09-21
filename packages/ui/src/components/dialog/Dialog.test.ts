import { describe, expect, it } from "vitest";
import { resolveTrapTarget } from "../../lib/focus.js";
import { dialogVariants } from "./dialog.variants.js";

describe("dialogVariants", () => {
  it("por defecto es md", () => {
    expect(dialogVariants()).toBe("fg-dialog fg-dialog--md");
  });

  it("cubre los cinco anchos", () => {
    for (const size of ["sm", "md", "lg", "xl", "full"] as const) {
      expect(dialogVariants({ size })).toContain(`fg-dialog--${size}`);
    }
  });
});

describe("trampa de foco del diálogo", () => {
  // El modal M-04 del PRD: "What would you like to do?" con dos opciones y
  // Cancel. Tabular en círculo no puede sacar el foco del modal.
  const modal = ["close", "saveToLibrary", "schedulePost", "cancel"] as const;

  it("el recorrido completo con Tab vuelve al principio sin escaparse", () => {
    let current: (typeof modal)[number] = "close";
    const visited: string[] = [current];
    for (let step = 0; step < modal.length; step += 1) {
      const next: (typeof modal)[number] | null = resolveTrapTarget(
        modal,
        current,
        false,
      );
      if (next !== null) {
        current = next;
      } else {
        const index = modal.indexOf(current);
        const following = modal[index + 1];
        if (following === undefined) throw new Error("orden de tabulación inconsistente");
        current = following;
      }
      visited.push(current);
    }
    expect(visited).toEqual([
      "close",
      "saveToLibrary",
      "schedulePost",
      "cancel",
      "close",
    ]);
  });
});
