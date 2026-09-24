import { describe, expect, it } from "vitest";

import {
  dataUrlBytes,
  missingProfilingAnswers,
  OTHER_CHOICE,
  profilingDraftFrom,
  toProfilingRequest,
  weightsValid,
} from "./intel";

describe("cuestionario de perfilado · F-006", () => {
  it("lo guardado vuelve al borrador: opciones conocidas tildadas, el resto en «Other»", () => {
    const draft = profilingDraftFrom({
      coreIdentity: "",
      productOffering: "",
      uniqueBenefits: "",
      problemSolution: "",
      marketAndCompetition: "",
      ownerRole: "Head of growth",
      teamSize: "2–10",
      businessCategories: ["E-commerce", "Pets"],
      expectations: [],
      brandRevision: 1,
      status: "ready",
      fieldMeta: {},
    });
    expect(draft.chosen.ownerRole).toEqual([OTHER_CHOICE]);
    expect(draft.other.ownerRole).toBe("Head of growth");
    expect(draft.chosen.teamSize).toEqual(["2–10"]);
    expect(draft.chosen.businessCategories).toEqual(["E-commerce"]);
    expect(draft.other.businessCategories).toBe("Pets");
    expect(missingProfilingAnswers(draft)).toEqual([
      "businessModel",
      "monthlyRevenueBand",
    ]);
  });

  it("arma el cuerpo con «Other» incluido; expectations es opcional", () => {
    const empty = profilingDraftFrom(undefined);
    expect(missingProfilingAnswers(empty)).toEqual([
      "ownerRole",
      "teamSize",
      "businessModel",
      "businessCategories",
      "monthlyRevenueBand",
    ]);
    const draft = {
      chosen: {
        ...empty.chosen,
        ownerRole: [OTHER_CHOICE],
        teamSize: ["Just me"],
        businessModel: ["B2C"],
        businessCategories: ["Education"],
        monthlyRevenueBand: ["Pre-revenue"],
      },
      other: {
        ...empty.other,
        ownerRole: " Teacher ",
        businessCategories: "Music, , Art",
      },
    };
    expect(missingProfilingAnswers(draft)).toEqual([]);
    expect(toProfilingRequest(draft)).toEqual({
      ownerRole: "Teacher",
      teamSize: "Just me",
      businessModel: "B2C",
      businessCategories: ["Education", "Music", "Art"],
      monthlyRevenueBand: "Pre-revenue",
      expectations: [],
    });
  });
});

describe("pesos de ángulos · FR-055", () => {
  it("suman exactamente 100, enteros entre 0 y 100", () => {
    expect(weightsValid({ a: 34, b: 33, c: 33 })).toBe(true);
    expect(weightsValid({ a: 50, b: 40 })).toBe(false);
    expect(weightsValid({ a: 100.5, b: -0.5 })).toBe(false);
    expect(weightsValid({})).toBe(false);
  });
});

describe("data: URL", () => {
  it("cuenta los bytes decodificados", () => {
    expect(dataUrlBytes("data:image/png;base64,AAAA")).toBe(3);
    expect(dataUrlBytes("data:image/png;base64,AAA=")).toBe(2);
    expect(dataUrlBytes("data:image/png;base64,AA==")).toBe(1);
  });
});
