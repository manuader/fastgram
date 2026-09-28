/**
 * Piezas puras de `routes/v1/ads.ts`. El circuito entero (base, RLS, doble de
 * Meta) está en `test/ads.int.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { AdsPlatformError } from "@fastgram/ports";

import { adsRejection, mediaKindOfUrl, targetingOf } from "./ads.js";

describe("mediaKindOfUrl", () => {
  it("video o imagen por extensión, también con la clave percent-encoded", () => {
    expect(mediaKindOfUrl("http://minio:9000/fastgram/content/a/b.mp4")).toBe("video");
    expect(mediaKindOfUrl("memory://bucket/content%2Fa%2Fslide-0.JPG")).toBe("image");
    expect(mediaKindOfUrl("http://x/content/a/b.txt")).toBeNull();
  });
});

describe("adsRejection", () => {
  const err = (
    reason: ConstructorParameters<typeof AdsPlatformError>[0],
    retry?: number,
  ) =>
    new AdsPlatformError(reason, "x", {
      source: "t",
      ...(retry === undefined ? {} : { retryAfterSeconds: retry }),
    });

  it("cada motivo de Meta tiene su status y viaja en details.reason", () => {
    expect(adsRejection(err("unauthorized"))).toMatchObject({
      status: 409,
      publicDetails: { reason: "unauthorized" },
    });
    expect(adsRejection(err("budget_too_low"))).toMatchObject({ status: 400 });
    expect(adsRejection(err("provider_unavailable"))).toMatchObject({ status: 503 });
    expect(adsRejection(err("rate_limited", 60))).toMatchObject({
      status: 429,
      publicDetails: { reason: "rate_limited", retryAfterMs: 60_000 },
    });
  });

  it("un error que no es de Meta no se traduce acá", () => {
    expect(adsRejection(new Error("x"))).toBeNull();
  });
});

describe("targetingOf", () => {
  it("no deja claves undefined", () => {
    expect(targetingOf({ countries: ["AR"] })).toEqual({ countries: ["AR"] });
    expect(targetingOf({ countries: ["AR"], ageMin: 18 })).toEqual({
      countries: ["AR"],
      ageMin: 18,
    });
  });
});
