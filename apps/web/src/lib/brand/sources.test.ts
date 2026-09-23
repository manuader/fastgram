/**
 * Las acciones de fila de `Brand sources` · `F-024`, §19.5.1, NFR-005.
 */
import { brandSourceSchema, type BrandSource } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../api/errors";
import { presentSourceActionError, sortSources } from "./sources";

function err(
  code: ConstructorParameters<typeof ApiRequestError>[0]["code"],
  status: number,
  details?: Record<string, unknown>,
): ApiRequestError {
  return new ApiRequestError({ code, status, serverMessage: "raw", details });
}

describe("presentSourceActionError", () => {
  it("quitar la única fuente (409 + ERR-B01) dice eso, no el copy de onboarding", () => {
    expect(
      presentSourceActionError("remove", err("conflict", 409, { code: "ERR-B01" })),
    ).toEqual({ titleKey: "brand.sources.onlySource", remedy: "none" });
  });

  it("quitar la primaria sin ser owner (403) nombra la regla", () => {
    expect(presentSourceActionError("remove", err("forbidden", 403)).titleKey).toBe(
      "brand.sources.ownerOnly",
    );
    // Un 403 en otra acción no es esa regla.
    expect(presentSourceActionError("setPrimary", err("forbidden", 403)).titleKey).toBe(
      "error.accessDenied.title",
    );
  });

  it("404 en cualquier acción: la fuente ya no está", () => {
    for (const action of ["reanalyse", "setPrimary", "remove"] as const) {
      expect(presentSourceActionError(action, err("not_found", 404)).titleKey).toBe(
        "brand.sources.gone",
      );
    }
  });

  it("ERR-B11 → cooldown con las horas, sin reintento", () => {
    const p = presentSourceActionError(
      "reanalyse",
      err("rate_limited", 429, { code: "ERR-B11", retryAfterMs: 5_400_000 }),
    );
    expect(p).toMatchObject({
      titleKey: "error.brand.refreshCooldown.title",
      titleVars: { hours: "2" },
      remedy: "none",
    });
  });

  it("NFR-005: un fallo transitorio al re-analizar NO ofrece reintento", () => {
    for (const e of [
      err("network_error", 0),
      err("timeout", 0),
      err("service_unavailable", 503),
    ]) {
      const p = presentSourceActionError("reanalyse", e);
      expect(p.remedy).toBe("none");
      expect(p.descriptionKey).toBe("brand.sources.checkStatus");
    }
    // Marcar primaria sí es repetible sin coste: conserva su `retry`.
    expect(presentSourceActionError("setPrimary", err("network_error", 0)).remedy).toBe(
      "retry",
    );
  });
});

describe("sortSources", () => {
  const base = {
    sourceType: "website",
    handle: "a.com",
    canonicalUrl: "https://a.com",
    displayName: null,
    avatarUrl: null,
    acquisitionTier: "B_public_api",
    status: "ready",
    lastAnalysedAt: null,
    analysisCount: 0,
    updatedAt: 1,
  };
  const make = (id: string, isPrimary: boolean, createdAt: number): BrandSource =>
    brandSourceSchema.parse({ ...base, _id: id, isPrimary, createdAt });

  it("primaria primero, después por antigüedad", () => {
    const sorted = sortSources([
      make("33333333-3333-4333-8333-333333333333", false, 3),
      make("22222222-2222-4222-8222-222222222222", true, 5),
      make("11111111-1111-4111-8111-111111111111", false, 1),
    ]);
    expect(sorted.map((s) => s.createdAt)).toEqual([5, 1, 3]);
  });
});
