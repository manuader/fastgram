import { describe, expect, it } from "vitest";
import { errorStatePresets, resolveStatePreset } from "../../i18n/presets.js";
import { errorStateVariants } from "./error-state.variants.js";

describe("errorStateVariants", () => {
  it("por defecto es md, tono danger y sin borde", () => {
    expect(errorStateVariants()).toBe("fg-state fg-state--md fg-state--danger");
  });

  it("permite bajar el tono", () => {
    expect(errorStateVariants({ tone: "warning" })).toContain("fg-state--warning");
    expect(errorStateVariants({ tone: "neutral" })).toBe("fg-state fg-state--md");
  });
});

describe("ErrorState con preset del PRD", () => {
  it("el preset por defecto es el error genérico con reintento", () => {
    expect(resolveStatePreset(errorStatePresets.generic)).toEqual({
      title: "Something went wrong",
      actionLabel: "Try again",
    });
  });

  it("ERR-U01 trae el copy literal de Access Denied", () => {
    expect(resolveStatePreset(errorStatePresets["ERR-U01"])).toEqual({
      title: "Access Denied",
      description:
        "You don't have permission to view this lead. It may belong to another account.",
    });
  });

  it("los errores de cuota no ofrecen reintentar, porque reintentar no arregla nada", () => {
    for (const id of ["ERR-R02", "ERR-R03", "ERR-R04"] as const) {
      expect(resolveStatePreset(errorStatePresets[id]).actionLabel).toBeUndefined();
    }
  });

  it("ERR-R03 fija el copy de cuota mensual agotada", () => {
    expect(resolveStatePreset(errorStatePresets["ERR-R03"]).title).toBe(
      "Monthly content quota reached for your plan",
    );
  });
});
