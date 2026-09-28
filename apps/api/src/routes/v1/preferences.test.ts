/**
 * El vocabulario de preferencias está escrito dos veces: en `core` (lo que se
 * extrae) y en `contracts` (lo que sale por la API), porque `contracts` no
 * importa `core`. Este test es lo que las mantiene iguales: agregar una
 * familia en un lado sin el otro haría que `GET /preferences` fallara la
 * validación de la respuesta en la web.
 */
import { describe, expect, it } from "vitest";
import {
  PREFERENCE_ASPECT_VALUES,
  PREFERENCE_EXPLORATION_MAX,
  PREFERENCE_EXPLORATION_MIN,
  PREFERENCE_FAMILY_VALUES,
  PREFERENCE_HALF_LIFE_MAX_DAYS,
  PREFERENCE_HALF_LIFE_MIN_DAYS,
  resetPreferencesRequestSchema,
  updatePreferenceSettingsRequestSchema,
} from "@fastgram/contracts";
import {
  PREFERENCE_ASPECTS,
  PREFERENCE_EXPLORATION_RANGE,
  PREFERENCE_FEATURE_FAMILY_NAMES,
  PREFERENCE_HALF_LIFE_RANGE_DAYS,
} from "@fastgram/core";
import { PREFERENCE_SETTINGS_LIMITS } from "@fastgram/db";

describe("vocabulario de preferencias: core ↔ contracts ↔ db", () => {
  it("las mismas familias", () => {
    expect([...PREFERENCE_FAMILY_VALUES].sort()).toEqual(
      [...PREFERENCE_FEATURE_FAMILY_NAMES].sort(),
    );
  });

  it("los mismos aspectos", () => {
    expect([...PREFERENCE_ASPECT_VALUES]).toEqual([...PREFERENCE_ASPECTS]);
  });

  it("los mismos rangos de configuración (los CHECK de la migración también)", () => {
    expect([PREFERENCE_EXPLORATION_MIN, PREFERENCE_EXPLORATION_MAX]).toEqual([
      PREFERENCE_EXPLORATION_RANGE.min,
      PREFERENCE_EXPLORATION_RANGE.max,
    ]);
    expect([PREFERENCE_HALF_LIFE_MIN_DAYS, PREFERENCE_HALF_LIFE_MAX_DAYS]).toEqual([
      PREFERENCE_HALF_LIFE_RANGE_DAYS.min,
      PREFERENCE_HALF_LIFE_RANGE_DAYS.max,
    ]);
    expect(PREFERENCE_SETTINGS_LIMITS).toEqual({
      explorationMin: PREFERENCE_EXPLORATION_RANGE.min,
      explorationMax: PREFERENCE_EXPLORATION_RANGE.max,
      halfLifeMinDays: PREFERENCE_HALF_LIFE_RANGE_DAYS.min,
      halfLifeMaxDays: PREFERENCE_HALF_LIFE_RANGE_DAYS.max,
    });
  });

  it("reset exige confirm: true; el PATCH vacío no pasa", () => {
    expect(resetPreferencesRequestSchema.safeParse({ scope: "brand" }).success).toBe(
      false,
    );
    expect(
      resetPreferencesRequestSchema.safeParse({ scope: "owner", confirm: true }).success,
    ).toBe(true);
    expect(updatePreferenceSettingsRequestSchema.safeParse({}).success).toBe(false);
    expect(
      updatePreferenceSettingsRequestSchema.safeParse({ exploration: null }).success,
    ).toBe(true);
  });
});
