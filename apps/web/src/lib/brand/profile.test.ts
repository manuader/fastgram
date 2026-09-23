/**
 * La lógica pura de `/brand` · `FR-020`, `F-022`, `F-025`.
 *
 * El test que más importa es el primero: el `PATCH` lleva **sólo** lo que
 * cambió, porque cada clave del cuerpo sale de la API marcada `editedByUser` y
 * deja de recibir análisis (ver la cabecera de `profile.ts`).
 */
import {
  brandSourceSchema,
  companyProfileSchema,
  type BrandSource,
  type CompanyProfile,
  type FieldMeta,
} from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import {
  buildProfilePatch,
  confidenceOf,
  conflictingSources,
  fieldOrigin,
  isTooLong,
  parseCategories,
  PROFILE_FIELD_MAX,
  PROFILE_SECTIONS,
  revisionMovedDuring,
  toDraft,
  worthAQuickCheck,
} from "./profile";

const SRC = "11111111-1111-4111-8111-111111111111";
const GONE = "33333333-3333-4333-8333-333333333333";

function profile(overrides: Readonly<Record<string, unknown>> = {}): CompanyProfile {
  return companyProfileSchema.parse({
    coreIdentity: "We make shoes",
    productOffering: "Running shoes",
    uniqueBenefits: "Light",
    problemSolution: "Sore feet",
    marketAndCompetition: "Crowded",
    businessCategories: ["Retail", "Sport"],
    toneOfVoice: "Friendly",
    targetAudience: "Runners",
    brandRevision: 3,
    status: "ready",
    fieldMeta: {},
    ...overrides,
  });
}

function source(): BrandSource {
  return brandSourceSchema.parse({
    _id: SRC,
    sourceType: "instagram",
    handle: "mimarca",
    canonicalUrl: "https://instagram.com/mimarca",
    displayName: null,
    avatarUrl: null,
    isPrimary: true,
    acquisitionTier: "B_public_api",
    status: "ready",
    lastAnalysedAt: 1,
    analysisCount: 1,
    createdAt: 1,
    updatedAt: 1,
  });
}

const meta = (m: Partial<FieldMeta> = {}): FieldMeta => ({
  confidence: "high",
  sourceId: SRC as FieldMeta["sourceId"],
  excerptRef: "snap#coreIdentity",
  editedByUser: false,
  ...m,
});

const identity = PROFILE_SECTIONS[0]?.fields ?? [];
const market = PROFILE_SECTIONS[1]?.fields ?? [];

describe("buildProfilePatch · sólo lo que cambió", () => {
  it("un campo cambiado entre cuatro → un cuerpo de una clave", () => {
    const base = toDraft(profile());
    const draft = { ...base, productOffering: "Trail shoes" };
    expect(buildProfilePatch(base, draft, identity)).toEqual({
      productOffering: "Trail shoes",
    });
  });

  it("sin cambios → `null` (un PATCH subiría `brandRevision` y marcaría campos)", () => {
    const base = toDraft(profile());
    expect(buildProfilePatch(base, { ...base }, identity)).toBeNull();
  });

  it("un espacio al final no es una edición", () => {
    const base = toDraft(profile());
    const draft = { ...base, coreIdentity: "We make shoes   " };
    expect(buildProfilePatch(base, draft, identity)).toBeNull();
  });

  it("sólo mira los campos de la sección: otro cambiado no viaja", () => {
    const base = toDraft(profile());
    const draft = { ...base, toneOfVoice: "Formal", coreIdentity: "Shoes, Inc." };
    expect(buildProfilePatch(base, draft, identity)).toEqual({
      coreIdentity: "Shoes, Inc.",
    });
  });

  it("categorías: texto separado por comas ↔ array, sin vacíos ni espacios", () => {
    const base = toDraft(profile());
    expect(base.businessCategories).toBe("Retail, Sport");
    expect(
      buildProfilePatch(base, { ...base, businessCategories: "Retail,Sport ," }, market),
    ).toBeNull();
    expect(
      buildProfilePatch(
        base,
        { ...base, businessCategories: "Retail, , Outdoor" },
        market,
      ),
    ).toEqual({ businessCategories: ["Retail", "Outdoor"] });
    expect(parseCategories("  ")).toEqual([]);
  });

  it("vaciar un campo es una edición y viaja como cadena vacía", () => {
    const base = toDraft(profile());
    expect(buildProfilePatch(base, { ...base, uniqueBenefits: "" }, identity)).toEqual({
      uniqueBenefits: "",
    });
  });

  it("los opcionales ausentes se editan como cadena vacía", () => {
    const base = toDraft(
      profile({ toneOfVoice: undefined, businessCategories: undefined }),
    );
    expect(base.toneOfVoice).toBe("");
    expect(base.businessCategories).toBe("");
  });
});

describe("límite de 4 000 (FR-020 Validation, INFERRED)", () => {
  it("4 000 pasa, 4 001 no", () => {
    expect(PROFILE_FIELD_MAX).toBe(4000);
    expect(isTooLong("a".repeat(4000))).toBe(false);
    expect(isTooLong("a".repeat(4001))).toBe(true);
  });
});

describe("fieldOrigin / confidenceOf · F-025", () => {
  it("editado a mano gana sobre el `sourceId` que `markEditedByUser` conserva", () => {
    const m = meta({ editedByUser: true, confidence: "low" });
    expect(fieldOrigin(m, [source()])).toEqual({ kind: "edited" });
    // La confianza vieja describe un extracto que ya no es el valor.
    expect(confidenceOf(m)).toBeNull();
  });

  it("fuente presente → la fuente; ausente → `removedSource`", () => {
    expect(fieldOrigin(meta(), [source()])).toMatchObject({ kind: "source" });
    expect(
      fieldOrigin(meta({ sourceId: GONE as FieldMeta["sourceId"] }), [source()]),
    ).toEqual({
      kind: "removedSource",
    });
  });

  it("sin listado todavía no se afirma nada (no se pinta `removed` por cargar)", () => {
    expect(fieldOrigin(meta(), undefined)).toEqual({ kind: "unknown" });
  });

  it("sin `fieldMeta` o sin `sourceId` → sin origen", () => {
    expect(fieldOrigin(undefined, [source()])).toEqual({ kind: "none" });
    expect(fieldOrigin(meta({ sourceId: null }), [source()])).toEqual({ kind: "none" });
    expect(confidenceOf(meta({ confidence: "medium" }))).toBe("medium");
  });

  it("`conflictsWith` → sólo las fuentes que siguen existiendo", () => {
    const m = meta({ conflictsWith: [SRC, GONE] as FieldMeta["conflictsWith"] });
    expect(conflictingSources(m, [source()]).map((s) => s._id)).toEqual([SRC]);
    expect(conflictingSources(meta(), [source()])).toEqual([]);
  });
});

describe("Worth a quick check · FR-011.2", () => {
  it("los `low` en orden de pantalla, sin los editados a mano", () => {
    const p = profile({
      fieldMeta: {
        targetAudience: meta({ confidence: "low" }),
        coreIdentity: meta({ confidence: "low" }),
        productOffering: meta({ confidence: "low", editedByUser: true }),
        uniqueBenefits: meta({ confidence: "medium" }),
      },
    });
    expect(worthAQuickCheck(p)).toEqual(["coreIdentity", "targetAudience"]);
  });
});

describe("revisionMovedDuring · F-022", () => {
  it("avisa sólo si la revisión del servidor se movió", () => {
    expect(revisionMovedDuring(3, profile())).toBe(false);
    expect(revisionMovedDuring(3, profile({ brandRevision: 4 }))).toBe(true);
    expect(revisionMovedDuring(3, undefined)).toBe(false);
  });
});
