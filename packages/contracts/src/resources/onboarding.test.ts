/**
 * Los números y la forma de `FR-010`, fijados.
 *
 * El que más vale de todos es el de las **seis claves**: es la mitad de
 * `P1-ONB-004` que se puede cerrar sin inventar copy, y es una decisión que
 * desde el código no se ve —un `z.object` con seis campos obligatorios se lee
 * igual que uno con cinco y un olvido—. Acá queda dicho cuál de las dos es.
 */
import { describe, expect, it } from "vitest";

import {
  ONBOARDING_ANSWER_MAX_CHARS,
  ONBOARDING_COMPANY_NAME_MIN_CHARS,
  ONBOARDING_STEPS,
  onboardingCompletionSchema,
  onboardingStateSchema,
  submitOnboardingProfilingRequestSchema,
} from "./onboarding.js";

// `Record<string, unknown>` para poder quitarle una clave por nombre en el
// `it.each` de abajo: con el tipo inferido, `{ [key]: _, ...resto }` con `key`
// de tipo `string` no compila.
const ANSWERS: Record<string, unknown> = {
  ownerRole: "founder",
  teamSize: "1-5",
  businessModel: "b2c",
  businessCategories: ["retail"],
  monthlyRevenueBand: "0-10k",
  expectations: ["more reach"],
};

describe("números literales de FR-010", () => {
  it("«Each answer is limited to 4,000 characters.» (PRD:767)", () => {
    expect(ONBOARDING_ANSWER_MAX_CHARS).toBe(4000);
  });

  it("«Company name must be at least 2 characters» (PRD:767)", () => {
    expect(ONBOARDING_COMPANY_NAME_MIN_CHARS).toBe(2);
  });

  it("los cinco pasos observados, en orden (PRD:741-749)", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "brand_source",
      "company_details",
      "profiling",
      "processing",
      "ready",
    ]);
  });
});

describe("el cuestionario exige las seis claves de F-006", () => {
  it("un cuerpo completo pasa", () => {
    expect(submitOnboardingProfilingRequestSchema.safeParse(ANSWERS).success).toBe(true);
  });

  it.each(Object.keys(ANSWERS))("falta %s → rechazado", (key) => {
    const { [key]: _omitida, ...parcial } = ANSWERS;
    expect(submitOnboardingProfilingRequestSchema.safeParse(parcial).success).toBe(false);
  });

  it("`expectations` tiene que venir, pero puede venir vacía", () => {
    // La lista de **Validation** de `FR-010` (PRD:767) da un mensaje de error
    // para las otras cinco preguntas y **ninguno** para expectativas. Exigir
    // contenido sería inventar copy; exigir la clave no.
    expect(
      submitOnboardingProfilingRequestSchema.safeParse({ ...ANSWERS, expectations: [] })
        .success,
    ).toBe(true);
  });

  it("una respuesta vacía **pasa el schema**: la juzga el dominio", () => {
    // A propósito. Si el schema la rechazara, Fastify respondería antes con su
    // error genérico y la copy CONFIRMED del PRD ("Please select your role")
    // no se mostraría nunca.
    expect(
      submitOnboardingProfilingRequestSchema.safeParse({ ...ANSWERS, ownerRole: "" })
        .success,
    ).toBe(true);
  });

  it("un campo de más se rechaza (`.strict()`)", () => {
    expect(
      submitOnboardingProfilingRequestSchema.safeParse({ ...ANSWERS, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("el estado del wizard", () => {
  const STATE = {
    step: "brand_source",
    sources: [],
    manualBranch: false,
    details: null,
    profiling: null,
    oauthConsents: 0,
  };

  it("`details` y `profiling` son nullable, no opcionales", () => {
    // `null` significa "ese paso no se respondió", que es información. Omitir
    // el campo obligaría al cliente a distinguir ausencia de vacío.
    expect(onboardingStateSchema.safeParse(STATE).success).toBe(true);
    const { details: _d, ...sinDetails } = STATE;
    expect(onboardingStateSchema.safeParse(sinDetails).success).toBe(false);
  });

  it("la respuesta del cierre añade `discoveryRefillQueued` y nada más", () => {
    expect(onboardingCompletionSchema.safeParse(STATE).success).toBe(false);
    expect(
      onboardingCompletionSchema.safeParse({ ...STATE, discoveryRefillQueued: true })
        .success,
    ).toBe(true);
    expect(
      onboardingCompletionSchema.safeParse({
        ...STATE,
        discoveryRefillQueued: true,
        workspaceCreated: true,
      }).success,
    ).toBe(false);
  });
});
