/**
 * Paso 1 · las piezas puras: chips, la pista de `Website`, el desambiguador y
 * los errores de entrada que la API manda sin `ERR-B`.
 */
import type { ResolveBrandSourceResponse } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../api/errors";
import {
  ambiguityOf,
  applyChip,
  createBodyOf,
  effectiveSourceType,
  presentSourceInputError,
} from "./brand-source";

describe("applyChip", () => {
  it("con el input vacío, el chip escribe su prefijo", () => {
    expect(applyChip("", "instagram")).toBe("instagram.com/");
    expect(applyChip("", "tiktok")).toBe("tiktok.com/@");
    expect(applyChip("", "website")).toBe("");
  });

  it("cambiar de chip cambia el prefijo, no lo acumula", () => {
    expect(applyChip("instagram.com/", "x")).toBe("x.com/");
  });

  it("un handle suelto se completa con la plataforma", () => {
    expect(applyChip("@mimarca", "instagram")).toBe("instagram.com/mimarca");
    expect(applyChip("mimarca", "youtube")).toBe("youtube.com/@mimarca");
    expect(applyChip("@acme", "linkedin")).toBe("linkedin.com/company/acme");
  });

  it("una URL ya pegada no se reescribe", () => {
    expect(applyChip("https://tiktok.com/@acme", "instagram")).toBe(
      "https://tiktok.com/@acme",
    );
    expect(applyChip("miproducto.com", "instagram")).toBe("miproducto.com");
  });
});

describe("effectiveSourceType", () => {
  it("el chip Website convierte `other_url` en `website` (FR-011.1, aclaración)", () => {
    expect(effectiveSourceType("other_url", "website")).toBe("website");
    expect(effectiveSourceType("other_url", null)).toBe("other_url");
  });

  it("un chip social no pisa lo que dice el host", () => {
    expect(effectiveSourceType("tiktok", "instagram")).toBe("tiktok");
  });
});

describe("createBodyOf", () => {
  const base: ResolveBrandSourceResponse = {
    sourceType: "youtube",
    handle: "channel/UCabcDEF",
    canonicalUrl: "https://youtube.com/channel/UCabcDEF",
    displayName: null,
    avatarUrl: null,
    available: true,
  };

  it("manda la URL canónica —con sus mayúsculas— cuando la hay", () => {
    expect(createBodyOf(base, "youtube")).toEqual({
      sourceType: "youtube",
      canonicalUrl: "https://youtube.com/channel/UCabcDEF",
    });
  });

  it("sin URL, manda el handle", () => {
    expect(createBodyOf({ ...base, canonicalUrl: null }, "youtube")).toEqual({
      sourceType: "youtube",
      handle: "channel/UCabcDEF",
    });
  });
});

describe("ambiguityOf", () => {
  const b03 = (details: Record<string, unknown>) =>
    new ApiRequestError({ code: "bad_request", status: 400, details });

  it("lee handle, candidatas y preseleccionada de ERR-B03", () => {
    expect(
      ambiguityOf(
        b03({
          code: "ERR-B03",
          handle: "mimarca",
          candidates: ["instagram", "tiktok", "facebook"],
          preselected: "tiktok",
        }),
      ),
    ).toEqual({
      handle: "mimarca",
      candidates: ["instagram", "tiktok"],
      preselected: "tiktok",
    });
  });

  it("una preseleccionada fuera de las candidatas se descarta", () => {
    expect(
      ambiguityOf(
        b03({
          code: "ERR-B03",
          handle: "m",
          candidates: ["x"],
          preselected: "instagram",
        }),
      )?.preselected,
    ).toBeNull();
  });

  it("otro ERR-B no es un desambiguador", () => {
    expect(ambiguityOf(b03({ code: "ERR-B02" }))).toBeNull();
  });
});

describe("presentSourceInputError", () => {
  it("los literales SSRF de FR-010 se reconocen contra la lista, no se pintan crudos", () => {
    const err = new ApiRequestError({
      code: "bad_request",
      status: 400,
      serverMessage: "Private IP addresses are not allowed",
    });
    expect(presentSourceInputError(err).titleKey).toBe("onboarding.validation.privateIp");
  });

  it("un `message` fuera de la lista cae al genérico, no se muestra", () => {
    const err = new ApiRequestError({
      code: "bad_request",
      status: 400,
      serverMessage: "SELECT * FROM brand_sources",
    });
    expect(presentSourceInputError(err).titleKey).toBe("error.badRequest.title");
  });

  it("el 503 de un enlace a post no ofrece «Try again»: hay que pegar el perfil", () => {
    const err = new ApiRequestError({
      code: "service_unavailable",
      status: 503,
      details: { sourceType: "instagram" },
    });
    const shown = presentSourceInputError(err);
    expect(shown.titleKey).toBe("onboarding.source.postLinkUnsupported");
    expect(shown.remedy).toBe("none");
  });

  it("un 503 sin `sourceType` sigue siendo reintentable", () => {
    const err = new ApiRequestError({ code: "service_unavailable", status: 503 });
    expect(presentSourceInputError(err).remedy).toBe("retry");
  });

  it("ERR-B02 sale con su copy literal", () => {
    const err = new ApiRequestError({
      code: "bad_request",
      status: 400,
      details: { code: "ERR-B02" },
      serverMessage: "We couldn't tell what this is.",
    });
    expect(presentSourceInputError(err).titleKey).toBe("error.brand.unrecognized.title");
  });
});
