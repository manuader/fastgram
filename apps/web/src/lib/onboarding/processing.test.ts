/**
 * Paso 4 · lo que se dice de cada fuente, y cuándo se deja de preguntar.
 *
 * El caso que justifica el archivo es el primero: hoy **nada consume**
 * `brand-source-analysis`, así que toda fuente real se queda en `pending`. La
 * pantalla no puede saberlo, pero sí puede no decir "seguimos trabajando".
 */
import { brandSourceSchema, type BrandSource } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_EXPECTED_MS,
  ANALYSIS_SUBSTEPS,
  BRAND_ANALYSIS_POLL_INTERVAL_MS,
  onboardingPollInterval,
  processingPhase,
  sourceNotice,
} from "./processing";

const T0 = Date.UTC(2026, 8, 23, 12);

function source(overrides: Readonly<Record<string, unknown>> = {}): BrandSource {
  return brandSourceSchema.parse({
    _id: "11111111-1111-4111-8111-111111111111",
    sourceType: "instagram",
    handle: "mimarca",
    canonicalUrl: "https://instagram.com/mimarca",
    displayName: null,
    avatarUrl: null,
    isPrimary: true,
    acquisitionTier: "B_public_api",
    status: "pending",
    lastAnalysedAt: null,
    analysisCount: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

function state(sources: readonly BrandSource[]) {
  return {
    step: "brand_source" as const,
    sources: [...sources],
    manualBranch: false,
    details: null,
    profiling: null,
    oauthConsents: 0,
  };
}

describe("sourceNotice", () => {
  it("`pending` recién creado no dice nada; pasados 3 min dice que NO empezó", () => {
    const s = source();
    expect(sourceNotice(s, T0 + ANALYSIS_EXPECTED_MS - 1)).toBeNull();
    expect(sourceNotice(s, T0 + ANALYSIS_EXPECTED_MS)).toEqual({
      key: "brand.pendingTooLong",
      problem: false,
    });
  });

  it("`analyzing` largo usa ERR-L09 contando desde que pasó a analyzing, no desde el alta", () => {
    const s = source({ status: "analyzing", updatedAt: T0 + 60_000 });
    expect(sourceNotice(s, T0 + ANALYSIS_EXPECTED_MS)).toBeNull();
    expect(sourceNotice(s, T0 + 60_000 + ANALYSIS_EXPECTED_MS)?.key).toBe(
      "loading.aiStudioSlow",
    );
  });

  it("cada `failureReason` tiene su copy de §19.5.1, con handle y plataforma", () => {
    expect(
      sourceNotice(source({ status: "failed", failureReason: "not_found" }), T0),
    ).toEqual({
      key: "error.brand.handleNotFound.title",
      vars: { handle: "mimarca", platform: "Instagram" },
      problem: true,
    });
    expect(
      sourceNotice(source({ status: "failed", failureReason: "private" }), T0)?.key,
    ).toBe("error.brand.privateProfile.title");
  });

  it("`unsupported_platform` nombra la plataforma y no promete el tier D que no existe", () => {
    const notice = sourceNotice(
      source({
        status: "failed",
        failureReason: "unsupported_platform",
        acquisitionTier: "D_assisted",
      }),
      T0,
    );
    expect(notice).toEqual({
      key: "brand.failure.unsupportedPlatform",
      vars: { handle: "mimarca", platform: "Instagram" },
      problem: true,
    });
  });

  it("`partial` es ERR-B09 y no es un problema: no bloquea el alta", () => {
    expect(sourceNotice(source({ status: "partial" }), T0)).toEqual({
      key: "error.brand.thinProfile.title",
      problem: false,
    });
  });
});

describe("onboardingPollInterval", () => {
  it("pregunta cada 10 s (la constante de NFR-002) mientras alguna esté en curso", () => {
    expect(BRAND_ANALYSIS_POLL_INTERVAL_MS).toBe(10_000);
    expect(
      onboardingPollInterval(
        state([source({ status: "ready" }), source({ status: "pending" })]),
      ),
    ).toBe(10_000);
    expect(onboardingPollInterval(state([source({ status: "analyzing" })]))).toBe(10_000);
  });

  it("con todo terminado, o sin datos, no pregunta", () => {
    expect(
      onboardingPollInterval(
        state([source({ status: "ready" }), source({ status: "failed" })]),
      ),
    ).toBe(false);
    expect(onboardingPollInterval(undefined)).toBe(false);
  });
});

describe("processingPhase", () => {
  it("todas fallidas es el mensaje de soporte de FR-010; una sola buena ya no", () => {
    expect(processingPhase([source({ status: "failed" })])).toBe("failed");
    expect(
      processingPhase([source({ status: "failed" }), source({ status: "partial" })]),
    ).toBe("done");
    expect(processingPhase([source({ status: "pending" })])).toBe("analyzing");
    expect(processingPhase([])).toBe("empty");
  });
});

describe("ANALYSIS_SUBSTEPS", () => {
  it("sólo Instagram tiene lista: el PRD no da las de las otras plataformas", () => {
    expect(Object.keys(ANALYSIS_SUBSTEPS)).toEqual(["instagram"]);
    expect(ANALYSIS_SUBSTEPS.instagram).toHaveLength(4);
  });
});
