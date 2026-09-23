/**
 * Ida y vuelta del alta **por handle**: `(sourceType, handle)` → URL →
 * `detectBrandSource` → el mismo `(sourceType, handle)`.
 *
 * Lo que se fija es que escribir el handle y pegar la URL del perfil den la
 * **misma** fila. Si divergen, la unicidad global de `DATA-031` —que es sobre
 * `(sourceType, handle)`— deja entrar la misma cuenta dos veces, o el alta por
 * handle falla con `ERR-B02` sobre una cuenta perfectamente válida. Lo segundo
 * es lo que pasaba con LinkedIn: `{linkedin, "acme"}` armaba
 * `linkedin.com/acme` y el detector de `core` no lo reconoce.
 *
 * Sin base de datos: `detectionInputOf`, `detect` y `assertHandleRoundTrip` son
 * funciones puras sobre `core`.
 */
import { describe, expect, it } from "vitest";
import { detectBrandSource, type SocialSourceType } from "@fastgram/core";

import { ApiRejection } from "../../http/errors.js";
import {
  assertHandleRoundTrip,
  detect,
  detectionInputOf,
  requireResolved,
} from "./brand.js";

/** Lo que se da de alta por handle, como lo haría el alta con `hint`. */
function viaHandle(sourceType: SocialSourceType, handle: string) {
  const resolved = requireResolved(
    detect(detectionInputOf(sourceType, { handle }), { hint: sourceType }),
  );
  assertHandleRoundTrip({ sourceType, handle }, resolved);
  return resolved;
}

/** Lo que resulta de pegar la URL del perfil, sin pista. */
function viaUrl(url: string) {
  const d = detectBrandSource(url);
  if (d.kind !== "resolved") throw new Error(`${url} → ${d.kind}`);
  return d;
}

/**
 * Por plataforma: lo que el usuario escribe, la URL de perfil que pegaría
 * para la misma cuenta, y el handle que `core` guarda.
 */
const CASES: ReadonlyArray<{
  readonly sourceType: SocialSourceType;
  readonly written: string;
  readonly profileUrl: string;
  readonly handle: string;
}> = [
  {
    sourceType: "instagram",
    written: "acme",
    profileUrl: "instagram.com/acme",
    handle: "acme",
  },
  {
    sourceType: "instagram",
    written: "@Acme.Co",
    profileUrl: "https://www.instagram.com/acme.co/?igshid=x",
    handle: "acme.co",
  },
  {
    sourceType: "tiktok",
    written: "acme",
    profileUrl: "tiktok.com/@acme",
    handle: "acme",
  },
  {
    sourceType: "tiktok",
    written: "@acme",
    profileUrl: "tiktok.com/@acme",
    handle: "acme",
  },
  { sourceType: "x", written: "acme", profileUrl: "twitter.com/acme", handle: "acme" },
  {
    sourceType: "x",
    written: "@acme_hq",
    profileUrl: "x.com/acme_hq",
    handle: "acme_hq",
  },
  {
    sourceType: "youtube",
    written: "acme",
    profileUrl: "youtube.com/@acme",
    handle: "acme",
  },
  {
    sourceType: "youtube",
    written: "@acme",
    profileUrl: "youtube.com/@acme",
    handle: "acme",
  },
  {
    // El id de canal es sensible a mayúsculas: bajarlo produce otro canal.
    sourceType: "youtube",
    written: "channel/UCaBcD123",
    profileUrl: "youtube.com/channel/UCaBcD123",
    handle: "channel/UCaBcD123",
  },
  {
    sourceType: "youtube",
    written: "c/Acme",
    profileUrl: "youtube.com/c/acme",
    handle: "c/acme",
  },
  {
    // El bug: un slug suelto es una company page (FR-011.1, FR-011.3).
    sourceType: "linkedin",
    written: "acme",
    profileUrl: "linkedin.com/company/acme",
    handle: "company/acme",
  },
  {
    sourceType: "linkedin",
    written: "@Acme",
    profileUrl: "https://www.linkedin.com/company/acme/",
    handle: "company/acme",
  },
  {
    sourceType: "linkedin",
    written: "company/acme",
    profileUrl: "linkedin.com/company/acme",
    handle: "company/acme",
  },
  {
    sourceType: "linkedin",
    written: "in/jane-doe",
    profileUrl: "linkedin.com/in/jane-doe",
    handle: "in/jane-doe",
  },
  {
    sourceType: "linkedin",
    written: "school/uba",
    profileUrl: "linkedin.com/school/uba",
    handle: "school/uba",
  },
];

describe("alta por handle ≡ pegar la URL del perfil", () => {
  for (const c of CASES) {
    it(`${c.sourceType} · "${c.written}" → ${c.handle}`, () => {
      const byHandle = viaHandle(c.sourceType, c.written);
      const byUrl = viaUrl(c.profileUrl);

      expect(byHandle.sourceType).toBe(c.sourceType);
      expect(byHandle.handle).toBe(c.handle);
      expect(byHandle.resolvedFromPost).toBe(false);
      // Misma fila por los dos caminos: es lo que protege la unicidad.
      expect({ sourceType: byUrl.sourceType, handle: byUrl.handle }).toEqual({
        sourceType: byHandle.sourceType,
        handle: byHandle.handle,
      });
      // Y la URL canónica es estable: volver a detectarla da lo mismo.
      const again = viaUrl(byHandle.canonicalUrl);
      expect(again.handle).toBe(byHandle.handle);
      expect(again.sourceType).toBe(byHandle.sourceType);
    });
  }

  it("cubre las cinco plataformas de D-02", () => {
    expect(new Set(CASES.map((c) => c.sourceType))).toEqual(
      new Set(["instagram", "tiktok", "x", "youtube", "linkedin"]),
    );
  });
});

describe("un handle que el detector leería como OTRA cuenta se rechaza", () => {
  function rejectionOf(sourceType: SocialSourceType, handle: string): ApiRejection {
    try {
      viaHandle(sourceType, handle);
    } catch (error) {
      if (error instanceof ApiRejection) return error;
      throw error;
    }
    throw new Error(`${sourceType} · ${handle} se aceptó`);
  }

  it.each([
    // `youtube.com/@user/acme` → el detector resuelve `@user`, que es otro canal.
    ["youtube", "user/acme"],
    // `instagram.com/a/b` → resuelve `a`, marcado como post.
    ["instagram", "acme/reel"],
    // `x.com/acme/status` → resuelve `acme` como post.
    ["x", "acme/status"],
  ] as const)("%s · %s → 400 ERR-B02, no un alta de otra cuenta", (type, handle) => {
    const rejection = rejectionOf(type, handle);
    expect(rejection.status).toBe(400);
    expect(rejection.publicDetails).toMatchObject({ code: "ERR-B02" });
  });
});
