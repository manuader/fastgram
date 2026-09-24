import { describe, expect, it } from "vitest";

import {
  applyVerification,
  buildFieldVerificationState,
  confidenceFromVerification,
  FIELD_VERIFIER_QUESTIONS,
  isVerifiable,
  parseFieldVerifierAnswers,
  type FieldVerifierAnswers,
} from "./field-verifier.js";
import { materializeField, type DerivedField } from "./synthesis.js";

const answers = (probability: number, specificity: number): FieldVerifierAnswers => ({
  supported: { kind: "noul", probability },
  specificity: {
    kind: "score",
    value: specificity,
    probabilities: [0, 1, 0],
    confidence: 1,
  },
});

const field: DerivedField = {
  field: "productOffering",
  value: "Handmade ceramic mugs",
  excerpt: "We make handmade ceramic mugs in Rosario.",
  confidence: "low",
  confidenceSource: "synthesizer",
  sourceId: "src-1",
  sourceType: "instagram",
};

describe("JV-4 · mapeo literal del PRD §25.3", () => {
  it("supported > 0.85 y specificity ≥ 2 → high", () => {
    expect(confidenceFromVerification(answers(0.9, 2))).toBe("high");
    expect(confidenceFromVerification(answers(0.86, 3))).toBe("high");
  });
  it("supported > 0.85 con specificity < 2 → medium, no high", () => {
    expect(confidenceFromVerification(answers(0.95, 1.9))).toBe("medium");
  });
  it("los bordes son estrictos: 0.85 no es high y 0.6 no es medium", () => {
    expect(confidenceFromVerification(answers(0.85, 3))).toBe("medium");
    expect(confidenceFromVerification(answers(0.6, 3))).toBe("low");
    expect(confidenceFromVerification(answers(0.61, 1))).toBe("medium");
  });
});

describe("JV-4 · preguntas y estado", () => {
  it("un noul y un score de 3 niveles, con ids únicos", () => {
    expect(FIELD_VERIFIER_QUESTIONS.map((q) => [q.id, q.kind])).toEqual([
      ["supported", "noul"],
      ["specificity", "score"],
    ]);
    const spec = FIELD_VERIFIER_QUESTIONS[1];
    expect(spec.levels).toHaveLength(3);
  });

  it("el estado es el del PRD y viene limpio de invisibles", () => {
    const state = buildFieldVerificationState({
      ...field,
      value: "Mugs​ hechos‮ a mano",
    });
    expect(state).toEqual({
      fieldName: "productOffering",
      derivedValue: "Mugs hechos a mano",
      sourceExcerpt: field.excerpt,
      sourceType: "instagram",
    });
  });

  it("sin extracto o sin valor no se verifica", () => {
    expect(isVerifiable(field)).toBe(true);
    expect(isVerifiable({ ...field, excerpt: undefined })).toBe(false);
    expect(isVerifiable({ ...field, value: "  " })).toBe(false);
  });
});

describe("JV-4 · lectura y aplicación", () => {
  it("una respuesta rota es null (el llamador cae a low)", () => {
    expect(parseFieldVerifierAnswers(null)).toBeNull();
    expect(
      parseFieldVerifierAnswers({ supported: { kind: "noul", probability: 2 } }),
    ).toBeNull();
    expect(
      parseFieldVerifierAnswers({
        supported: { kind: "noul", probability: 0.9 },
        specificity: { kind: "score", value: 7, probabilities: [] },
      }),
    ).toBeNull();
  });

  it("verificado, el campo deja de recortarse a low", () => {
    const before = materializeField(field);
    expect(before.confidence).toBe("low");
    const parsed = parseFieldVerifierAnswers(answers(0.95, 2.4));
    expect(parsed).not.toBeNull();
    const after = materializeField(
      applyVerification(field, parsed as FieldVerifierAnswers),
    );
    expect(after).toMatchObject({ confidence: "high", status: "materialized" });
  });

  it("un high del verificador sin extracto sigue vacío: el guardarraíl manda", () => {
    const verified = applyVerification(
      { ...field, excerpt: undefined },
      answers(0.99, 3),
    );
    expect(materializeField(verified).status).toBe("empty");
  });
});
