import { describe, expect, it } from "vitest";

import {
  acceptedProposalWrite,
  brandRevisionMatches,
  computeProfileProposals,
  withDismissedProposal,
} from "./proposals.js";

const values = {
  coreIdentity: "We are Acme",
  productOffering: "My own words about the offer",
  uniqueBenefits: null,
  problemSolution: null,
  marketAndCompetition: null,
  toneOfVoice: null,
  targetAudience: null,
  businessCategories: [] as string[],
};

const snapshot = {
  snapshotId: "snap-1",
  sourceId: "src-1",
  sourceType: "website" as const,
  isPrimary: true,
  derivedFields: {
    productOffering: {
      value: "Handmade mugs",
      excerpt: "we sell handmade mugs",
      confidence: "high",
      confidenceSource: "verifier",
    },
    coreIdentity: {
      value: "We are Acme",
      excerpt: "We are Acme",
      confidence: "high",
      confidenceSource: "verifier",
    },
  },
};

const editedMeta = {
  productOffering: {
    confidence: "high",
    sourceId: null,
    excerptRef: null,
    editedByUser: true,
  },
  coreIdentity: {
    confidence: "high",
    sourceId: "src-1",
    excerptRef: "snap-1#coreIdentity",
    editedByUser: false,
  },
};

describe("propuestas del re-análisis · ERR-B14", () => {
  it("un campo editado a mano con otra propuesta aparece; uno igual, no", () => {
    const out = computeProfileProposals({
      snapshots: [snapshot],
      values,
      fieldMeta: editedMeta,
    });
    expect(out).toEqual([
      {
        field: "productOffering",
        value: "Handmade mugs",
        currentValue: "My own words about the offer",
        confidence: "high",
        sourceId: "src-1",
        sourceType: "website",
        excerpt: "we sell handmade mugs",
        excerptRef: "snap-1#productOffering",
        reason: "edited_by_user",
      },
    ]);
  });

  it("descartada, no vuelve; un snapshot nuevo sí", () => {
    const dismissed = withDismissedProposal(
      editedMeta,
      "productOffering",
      "snap-1#productOffering",
    );
    expect(
      computeProfileProposals({ snapshots: [snapshot], values, fieldMeta: dismissed }),
    ).toEqual([]);
    const next = { ...snapshot, snapshotId: "snap-2" };
    expect(
      computeProfileProposals({ snapshots: [next], values, fieldMeta: dismissed }).map(
        (p) => p.excerptRef,
      ),
    ).toEqual(["snap-2#productOffering"]);
  });

  it("descartar conserva el resto de la meta del campo", () => {
    const d = withDismissedProposal(editedMeta, "productOffering", "r") as Record<
      string,
      Record<string, unknown>
    >;
    expect(d["productOffering"]).toMatchObject({
      editedByUser: true,
      dismissedProposal: "r",
    });
  });

  it("aceptar deja de ser editedByUser y guarda la procedencia", () => {
    const [p] = computeProfileProposals({
      snapshots: [snapshot],
      values,
      fieldMeta: editedMeta,
    });
    expect(p).toBeDefined();
    expect(acceptedProposalWrite(p!)).toEqual({
      value: "Handmade mugs",
      meta: {
        confidence: "high",
        sourceId: "src-1",
        excerptRef: "snap-1#productOffering",
        editedByUser: false,
      },
    });
  });

  it("sin snapshots, nada", () => {
    expect(computeProfileProposals({ snapshots: [], values, fieldMeta: {} })).toEqual([]);
  });

  it("guarda de revisión: sin esperada pasa; distinta no", () => {
    expect(brandRevisionMatches(3, undefined)).toBe(true);
    expect(brandRevisionMatches(3, 3)).toBe(true);
    expect(brandRevisionMatches(4, 3)).toBe(false);
  });
});
