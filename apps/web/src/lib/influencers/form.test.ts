/**
 * La lógica pura de influencers — `PU-LATER-004`.
 */
import { describe, expect, it } from "vitest";
import {
  INITIAL_WIZARD,
  canLeaveStep,
  generationsRefetchInterval,
  influencersRefetchInterval,
  toCreateRequest,
  toImageRequest,
  toggleReference,
  traitsLine,
  type WizardForm,
} from "./form";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${String(i)}`);

describe("wizard", () => {
  it("paso 1 pide nombre; paso 2 pide 4–20 fotos", () => {
    expect(canLeaveStep(INITIAL_WIZARD, 1)).toBe(false);
    expect(canLeaveStep({ ...INITIAL_WIZARD, name: " Emily " }, 1)).toBe(true);
    expect(canLeaveStep({ ...INITIAL_WIZARD, referenceMediaIds: ids(3) }, 2)).toBe(false);
    expect(canLeaveStep({ ...INITIAL_WIZARD, referenceMediaIds: ids(4) }, 2)).toBe(true);
    expect(canLeaveStep({ ...INITIAL_WIZARD, referenceMediaIds: ids(20) }, 2)).toBe(true);
  });

  it("marcar/desmarcar, sin pasar de 20", () => {
    let f: WizardForm = { ...INITIAL_WIZARD, referenceMediaIds: ids(20) };
    f = toggleReference(f, "otra");
    expect(f.referenceMediaIds).toHaveLength(20);
    f = toggleReference(f, "id-0");
    expect(f.referenceMediaIds).toHaveLength(19);
    f = toggleReference(f, "otra");
    expect(f.referenceMediaIds).toContain("otra");
  });

  it("el pedido omite los rasgos vacíos", () => {
    expect(
      toCreateRequest({ ...INITIAL_WIZARD, name: " Emily ", referenceMediaIds: ids(4) }),
    ).toEqual({ name: "Emily", referenceMediaIds: ids(4) });
    expect(
      toCreateRequest({
        ...INITIAL_WIZARD,
        name: "Emily",
        gender: "female",
        age: 70,
        ethnicity: " Latina ",
        details: "freckles",
        referenceMediaIds: ids(4),
      }),
    ).toEqual({
      name: "Emily",
      gender: "female",
      age: 60,
      ethnicity: "Latina",
      additionalDetails: "freckles",
      referenceMediaIds: ids(4),
    });
  });
});

describe("vista", () => {
  it("rasgos con lo que haya", () => {
    expect(traitsLine({ gender: "male", age: 25, ethnicity: "White" } as never)).toBe(
      "male · 25 · White",
    );
    expect(traitsLine({} as never)).toBe("");
  });

  it("se hace polling sólo mientras algo entrena o genera", () => {
    expect(influencersRefetchInterval([{ status: "ready" }])).toBe(false);
    expect(influencersRefetchInterval([{ status: "training" }])).not.toBe(false);
    expect(generationsRefetchInterval([{ status: "ready" }, { status: "failed" }])).toBe(
      false,
    );
    expect(generationsRefetchInterval([{ status: "queued" }])).not.toBe(false);
  });

  it("sin prompt no hay pedido", () => {
    expect(toImageRequest({ prompt: "  ", aspectRatio: "9:16", count: 1 })).toBeNull();
    expect(toImageRequest({ prompt: " gym ", aspectRatio: "1:1", count: 4 })).toEqual({
      prompt: "gym",
      aspectRatio: "1:1",
      count: 4,
    });
  });
});
