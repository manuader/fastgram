import { describe, expect, it } from "vitest";
import { en } from "./messages";
import { emptyStatePresets, errorStatePresets, type StatePreset } from "./presets";
import { t } from "./t";

const allPresets: Array<[string, StatePreset]> = [
  ...Object.entries(emptyStatePresets),
  ...Object.entries(errorStatePresets),
];

describe("presets de estado", () => {
  it("cubre los trece estados vacíos del PRD §19.1", () => {
    const expected = Array.from(
      { length: 13 },
      (_, i) => `ERR-E${String(i + 1).padStart(2, "0")}`,
    );
    expect(Object.keys(emptyStatePresets).sort()).toEqual(expected.sort());
  });

  it("cada clave de cada preset existe en el catálogo", () => {
    for (const [id, preset] of allPresets) {
      expect(en[preset.titleKey], `${id}.titleKey`).toBeTypeOf("string");
      if (preset.descriptionKey !== undefined) {
        expect(en[preset.descriptionKey], `${id}.descriptionKey`).toBeTypeOf("string");
      }
      if (preset.actionKey !== undefined) {
        expect(en[preset.actionKey], `${id}.actionKey`).toBeTypeOf("string");
      }
    }
  });

  it("los estados de error recuperables ofrecen una acción de reintento", () => {
    expect(t(errorStatePresets.generic.titleKey)).toBe("Something went wrong");
    expect(errorStatePresets.generic.actionKey).toBe("common.tryAgain");
  });

  it("ERR-E12 trae el copy literal y su acción `+ Add source`", () => {
    const preset = emptyStatePresets["ERR-E12"];
    expect(t(preset.titleKey)).toBe(
      "No sources yet. Add your website or a social profile so we can learn your brand.",
    );
    expect(preset.actionKey).toBe("empty.brandSources.action");
  });
});
