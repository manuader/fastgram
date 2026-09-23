/** Las tres decisiones puras del handler de `media-normalization` (`NFR-014`). */
import { PORT_ERROR_CODES, PortError, type MediaProbe } from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import {
  classifyNormalizationError,
  normalizationReasons,
  parseMediaNormalizationJob,
} from "./normalization-handler.js";

const ID = "3f1c2a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60";

const MP4_LISTO: MediaProbe = {
  contentType: "video/mp4",
  width: 1080,
  height: 1920,
  hasAudio: true,
  isHdr: false,
  isFastStart: true,
};

describe("parseMediaNormalizationJob", () => {
  it("acepta los dos uuids", () => {
    expect(parseMediaNormalizationJob({ companyId: ID, mediaId: ID })).toEqual({
      ok: true,
      job: { companyId: ID, mediaId: ID },
    });
  });

  it.each([
    ["null", null],
    ["un string", "x"],
    ["sin mediaId", { companyId: ID }],
    ["mediaId que no es uuid", { companyId: ID, mediaId: "abc" }],
    ["companyId numérico", { companyId: 1, mediaId: ID }],
  ])("rechaza %s", (_nombre, payload) => {
    expect(parseMediaNormalizationJob(payload).ok).toBe(false);
  });
});

describe("normalizationReasons — las tres condiciones de NFR-014", () => {
  it("un MP4 SDR con faststart no necesita nada", () => {
    expect(normalizationReasons(MP4_LISTO)).toEqual([]);
  });
  it("MOV→MP4", () => {
    expect(
      normalizationReasons({ ...MP4_LISTO, contentType: "video/quicktime" }),
    ).toEqual(["container"]);
  });
  it("HDR→SDR", () => {
    expect(normalizationReasons({ ...MP4_LISTO, isHdr: true })).toEqual(["hdr"]);
  });
  it("faststart", () => {
    expect(normalizationReasons({ ...MP4_LISTO, isFastStart: false })).toEqual([
      "faststart",
    ]);
  });
});

describe("classifyNormalizationError", () => {
  const port = (code: (typeof PORT_ERROR_CODES)[number]) =>
    new PortError(code, "crudo del proveedor", { source: "test" });

  it("ERR-P11 es permanente", () => {
    expect(classifyNormalizationError(port("not_found"))).toMatchObject({
      code: "media_unreadable",
      retryable: false,
    });
    expect(classifyNormalizationError(port("bad_request"))).toMatchObject({
      code: "media_unreadable",
      retryable: false,
    });
  });

  it("los transitorios se reintentan", () => {
    for (const code of ["provider_unavailable", "timeout", "rate_limited"] as const) {
      expect(classifyNormalizationError(port(code))).toMatchObject({
        code: "renderer_unavailable",
        retryable: true,
      });
    }
  });

  it("todo código del puerto cae en un código estable, nunca en el mensaje crudo", () => {
    for (const code of PORT_ERROR_CODES) {
      const f = classifyNormalizationError(port(code));
      expect(f.code).not.toContain("crudo");
      expect(f.code).toMatch(/^[a-z_]+$/);
    }
  });

  it("lo que no es del puerto es internal_error, reintentable", () => {
    expect(classifyNormalizationError(new Error("ECONNRESET"))).toMatchObject({
      code: "internal_error",
      retryable: true,
    });
  });
});
