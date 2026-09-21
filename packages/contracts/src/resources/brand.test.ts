import { describe, expect, it } from "vitest";
import {
  BRAND_FREE_TEXT_ANSWER_MAX,
  BRAND_SOURCE_ITEMS_PER_ANALYSIS_DEFAULT,
  BRAND_SOURCE_LINK_FOLLOW_DEPTH,
  BRAND_SOURCE_LINK_FOLLOW_MAX_TARGETS,
  BRAND_SOURCE_REANALYSES_PER_DAY_DEFAULT,
  BRAND_SOURCE_STALE_AFTER_DAYS,
  MAX_BRAND_SOURCES_PER_WORKSPACE,
  acquisitionTierSchema,
  brandSourceFailureReasonSchema,
  brandSourceStatusSchema,
  brandSourceTypeSchema,
  companyProfileStatusSchema,
  createBrandSourceRequestSchema,
  fieldConfidenceSchema,
  resolveBrandSourceResponseSchema,
  updateBrandSourceRequestSchema,
  updateCompanyProfileRequestSchema,
} from "./brand.js";

describe("límites de Brand Sources · §9.14 · PRD:2377-2384 (EXTENSION)", () => {
  it("5 fuentes por workspace · PRD:2377", () => {
    expect(MAX_BRAND_SOURCES_PER_WORKSPACE).toBe(5);
  });

  it("3 re-análisis por fuente y día (default) · PRD:2378", () => {
    expect(BRAND_SOURCE_REANALYSES_PER_DAY_DEFAULT).toBe(3);
  });

  it("24 ítems analizados por fuente (default) · PRD:2380", () => {
    expect(BRAND_SOURCE_ITEMS_PER_ANALYSIS_DEFAULT).toBe(24);
  });

  it("90 días para pasar a `stale` · DATA-031 · PRD:2193", () => {
    expect(BRAND_SOURCE_STALE_AFTER_DAYS).toBe(90);
  });

  it("seguimiento de enlaces: 1 nivel, 5 destinos · PRD:2384", () => {
    expect(BRAND_SOURCE_LINK_FOLLOW_DEPTH).toBe(1);
    expect(BRAND_SOURCE_LINK_FOLLOW_MAX_TARGETS).toBe(5);
  });

  it("descripción libre de la marca ≤ 4000 por respuesta · AI-001 · PRD:2545", () => {
    expect(BRAND_FREE_TEXT_ANSWER_MAX).toBe(4000);
  });
});

describe("enums de Brand Source · DATA-031 · PRD:2183-2192", () => {
  it("sourceType", () => {
    expect(brandSourceTypeSchema.options).toEqual([
      "website",
      "instagram",
      "tiktok",
      "x",
      "youtube",
      "linkedin",
      "other_url",
      "manual",
    ]);
  });

  it("acquisitionTier sigue el orden de FR-011.4", () => {
    expect(acquisitionTierSchema.options).toEqual([
      "A_oauth",
      "B_public_api",
      "C_page_fetch",
      "D_assisted",
    ]);
  });

  it("status incluye `partial` y `stale`", () => {
    expect(brandSourceStatusSchema.options).toEqual([
      "pending",
      "analyzing",
      "ready",
      "partial",
      "failed",
      "stale",
    ]);
  });

  it("failureReason", () => {
    expect(brandSourceFailureReasonSchema.options).toEqual([
      "not_found",
      "private",
      "insufficient_content",
      "rate_limited",
      "provider_unavailable",
      "unsupported_platform",
      "already_registered",
    ]);
  });

  it("un sourceType inventado se rechaza", () => {
    expect(() => brandSourceTypeSchema.parse("facebook")).toThrow();
  });
});

describe("endpoints de Brand · §9.14 · PRD:2368-2374", () => {
  it("resolve devuelve la forma literal del PRD", () => {
    const parsed = resolveBrandSourceResponseSchema.parse({
      sourceType: "instagram",
      handle: "ellaparkergrowth",
      canonicalUrl: "https://instagram.com/ellaparkergrowth",
      displayName: "Ella Parker",
      avatarUrl: null,
      available: true,
    });
    expect(parsed.available).toBe(true);
  });

  it("crear una fuente exige handle o canonicalUrl", () => {
    expect(() =>
      createBrandSourceRequestSchema.parse({ sourceType: "instagram" }),
    ).toThrow();
    expect(
      createBrandSourceRequestSchema.parse({ sourceType: "instagram", handle: "ella" })
        .handle,
    ).toBe("ella");
  });

  it("PATCH de una fuente sólo acepta isPrimary · PRD:2372", () => {
    expect(updateBrandSourceRequestSchema.parse({ isPrimary: true }).isPrimary).toBe(
      true,
    );
    expect(() => updateBrandSourceRequestSchema.parse({ handle: "otro" })).toThrow();
  });
});

describe("Company Profile · DATA-004 · PRD:2046-2059", () => {
  it("la confianza por campo es high | medium | low", () => {
    expect(fieldConfidenceSchema.options).toEqual(["high", "medium", "low"]);
  });

  it("el status del perfil incluye `partial` (EXTENSION)", () => {
    expect(companyProfileStatusSchema.options).toEqual([
      "pending",
      "ready",
      "failed",
      "partial",
    ]);
  });

  it("el PATCH del perfil no deja tocar fieldMeta, brandRevision ni status", () => {
    expect(() => updateCompanyProfileRequestSchema.parse({ brandRevision: 9 })).toThrow();
    expect(() => updateCompanyProfileRequestSchema.parse({ fieldMeta: {} })).toThrow();
    expect(() => updateCompanyProfileRequestSchema.parse({ status: "ready" })).toThrow();
  });

  it("un body vacío se rechaza", () => {
    expect(() => updateCompanyProfileRequestSchema.parse({})).toThrow();
  });
});
