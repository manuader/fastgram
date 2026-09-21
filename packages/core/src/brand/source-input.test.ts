import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import {
  SOCIAL_SOURCE_TYPES,
  assertHostAllowed,
  detectBrandSource,
  type BrandSourceDetection,
} from "./source-input.js";

function resolved(d: BrandSourceDetection) {
  if (d.kind !== "resolved") throw new Error(`esperaba resolved, fue ${d.kind}`);
  return d;
}

describe("detección de plataforma — FR-011.1", () => {
  it("acepta URLs con y sin esquema, con y sin www", () => {
    for (const input of [
      "instagram.com/mimarca",
      "www.instagram.com/mimarca",
      "https://instagram.com/mimarca",
      "https://www.instagram.com/mimarca/",
      "http://instagram.com/mimarca",
    ]) {
      const d = resolved(detectBrandSource(input));
      expect(d.sourceType, input).toBe("instagram");
      expect(d.handle, input).toBe("mimarca");
    }
  });

  it("x.com y twitter.com se normalizan AMBOS a x", () => {
    for (const input of [
      "x.com/mimarca",
      "twitter.com/mimarca",
      "mobile.twitter.com/mimarca",
    ]) {
      const d = resolved(detectBrandSource(input));
      expect(d.sourceType, input).toBe("x");
      expect(d.handle, input).toBe("mimarca");
    }
  });

  it("tiktok exige el @ del perfil", () => {
    const d = resolved(detectBrandSource("tiktok.com/@mimarca"));
    expect(d.sourceType).toBe("tiktok");
    expect(d.handle).toBe("mimarca");
    expect(d.canonicalUrl).toBe("https://tiktok.com/@mimarca");
  });

  it("youtube acepta @handle, /channel/ y /c/", () => {
    expect(resolved(detectBrandSource("youtube.com/@mimarca")).handle).toBe("mimarca");
    expect(resolved(detectBrandSource("youtube.com/c/MiMarca")).handle).toBe("c/mimarca");
  });

  it("un id de canal de YouTube conserva las mayúsculas — son significativas", () => {
    // `UCabc` en minúsculas es un canal que no existe. Normalizar de más
    // produce un 404 que parece un problema de la plataforma.
    const d = resolved(detectBrandSource("youtube.com/channel/UCa1B2c3D4"));
    expect(d.handle).toBe("channel/UCa1B2c3D4");
  });

  it("linkedin conserva el prefijo company/ o in/ en el handle", () => {
    expect(resolved(detectBrandSource("linkedin.com/company/mimarca")).handle).toBe(
      "company/mimarca",
    );
    expect(resolved(detectBrandSource("linkedin.com/in/mimarca")).handle).toBe(
      "in/mimarca",
    );
  });

  it("un host desconocido es other_url; con la pista del chip Website es website", () => {
    // La ambigüedad del PRD, resuelta: ver la nota en `detectBrandSource`.
    expect(resolved(detectBrandSource("miproducto.com/es")).sourceType).toBe("other_url");
    expect(
      resolved(detectBrandSource("miproducto.com/es", { hint: "website" })).sourceType,
    ).toBe("website");
  });

  it("la rama manual produce una fuente de tipo manual", () => {
    const d = resolved(detectBrandSource("lo que sea", { hint: "manual" }));
    expect(d.sourceType).toBe("manual");
  });
});

describe("parámetros de tracking — FR-011.1", () => {
  it("descarta utm_*, igshid, si y fbclid del canonical", () => {
    const d = resolved(
      detectBrandSource(
        "https://miproducto.com/es?utm_source=ig&utm_campaign=x&igshid=abc&si=z&fbclid=q&ref=amigo",
      ),
    );
    expect(d.canonicalUrl).not.toContain("utm_");
    expect(d.canonicalUrl).not.toContain("igshid");
    expect(d.canonicalUrl).not.toContain("fbclid");
    // Lo que no es tracking se conserva: no es tarea nuestra limpiar la URL.
    expect(d.canonicalUrl).toContain("ref=amigo");
  });

  it("la misma cuenta pegada desde dos sitios da el MISMO handle", () => {
    // Sin esto, la unicidad de (sourceType, handle) no protege nada.
    const a = resolved(detectBrandSource("https://www.instagram.com/mimarca?igshid=1"));
    const b = resolved(detectBrandSource("instagram.com/mimarca/"));
    expect(a.handle).toBe(b.handle);
    expect(a.canonicalUrl).toBe(b.canonicalUrl);
  });
});

describe("@handle a secas es AMBIGUO, no inválido (ERR-B03)", () => {
  it("devuelve el desambiguador con las cinco plataformas", () => {
    const d = detectBrandSource("@mimarca");
    expect(d.kind).toBe("ambiguous");
    if (d.kind !== "ambiguous") return;
    expect(d.handle).toBe("mimarca");
    expect(d.candidates).toEqual(SOCIAL_SOURCE_TYPES);
    expect(d.preselected).toBeNull();
  });

  it("preselecciona la plataforma que el usuario ya tiene conectada (criterio 3)", () => {
    const d = detectBrandSource("@mimarca", { connectedPlatforms: ["tiktok"] });
    if (d.kind !== "ambiguous") throw new Error("esperaba ambiguous");
    expect(d.preselected).toBe("tiktok");
  });

  it("con el chip de plataforma pulsado deja de ser ambiguo", () => {
    const d = resolved(detectBrandSource("@mimarca", { hint: "instagram" }));
    expect(d.sourceType).toBe("instagram");
    expect(d.canonicalUrl).toBe("https://instagram.com/mimarca");
  });
});

describe("enlaces a un post — se resuelven al perfil del autor (ERR-B12)", () => {
  it("TikTok y X traen el handle en la URL: se resuelve en local", () => {
    const tt = resolved(detectBrandSource("tiktok.com/@mimarca/video/7123456"));
    expect(tt.handle).toBe("mimarca");
    expect(tt.resolvedFromPost).toBe(true);

    const x = resolved(detectBrandSource("x.com/mimarca/status/1234"));
    expect(x.handle).toBe("mimarca");
    expect(x.resolvedFromPost).toBe(true);
  });

  it("instagram.com/p/<code> NO trae el handle: hace falta consultar", () => {
    // Inventar un handle acá sería devolver un perfil que no es el del autor.
    const d = detectBrandSource("instagram.com/p/CxYz123");
    expect(d.kind).toBe("needs_lookup");
    if (d.kind !== "needs_lookup") return;
    expect(d.sourceType).toBe("instagram");
    expect(d.postRef).toBe("CxYz123");
  });

  it("un reel bajo el perfil sí trae el handle", () => {
    const d = resolved(detectBrandSource("instagram.com/mimarca/reel/CxYz123"));
    expect(d.handle).toBe("mimarca");
    expect(d.resolvedFromPost).toBe(true);
  });

  it("un watch de YouTube necesita consulta", () => {
    const d = detectBrandSource("youtube.com/watch?v=abc123");
    expect(d.kind).toBe("needs_lookup");
    if (d.kind !== "needs_lookup") return;
    expect(d.postRef).toBe("abc123");
  });
});

describe("entradas que no resuelven (ERR-B02)", () => {
  it("texto suelto no es una fuente", () => {
    expect(detectBrandSource("hola que tal").kind).toBe("unrecognized");
    expect(detectBrandSource("").kind).toBe("unrecognized");
  });

  it("una ruta reservada de la plataforma no es un perfil", () => {
    expect(detectBrandSource("instagram.com/explore/tags/x").kind).toBe("unrecognized");
    expect(detectBrandSource("x.com/home").kind).toBe("unrecognized");
  });

  it("un esquema que no es http(s) no se acepta", () => {
    expect(detectBrandSource("javascript:alert(1)").kind).toBe("unrecognized");
    expect(detectBrandSource("ftp://archivos.example.com").kind).toBe("unrecognized");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SSRF — FR-010 (copy literal), aplicado a TODOS los orígenes por FR-011.9
// ───────────────────────────────────────────────────────────────────────────

describe("protección SSRF con el copy literal de FR-010", () => {
  it("localhost y sus variantes", () => {
    for (const host of ["localhost", "app.localhost", "foo.local", "svc.internal"]) {
      try {
        assertHostAllowed(host);
        expect.unreachable(`${host} tenía que bloquearse`);
      } catch (e) {
        expect((e as DomainError).message).toBe("Localhost URLs are not allowed");
      }
    }
  });

  it("IPs privadas, incluida la de metadata de la nube", () => {
    for (const host of [
      "10.0.0.1",
      "172.16.3.4",
      "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1",
      // 169.254.169.254 es el metadata de AWS, GCP y Azure. Es EL objetivo.
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
    ]) {
      try {
        assertHostAllowed(host);
        expect.unreachable(`${host} tenía que bloquearse`);
      } catch (e) {
        expect((e as DomainError).message, host).toBe(
          "Private IP addresses are not allowed",
        );
      }
    }
  });

  it("la IP en forma decimal, que es la vuelta clásica al filtro", () => {
    // http://2130706433/ es 127.0.0.1 escrito de otra manera.
    try {
      assertHostAllowed("2130706433");
      expect.unreachable("tenía que bloquearse");
    } catch (e) {
      expect((e as DomainError).message).toBe("Blocked URL for security reasons");
    }
  });

  it("172.32 NO es privada: el rango es 172.16–172.31", () => {
    expect(() => assertHostAllowed("172.32.0.1")).not.toThrow();
    expect(() => assertHostAllowed("11.0.0.1")).not.toThrow();
  });

  it("la protección se aplica desde la detección, sea cual sea el origen", () => {
    expect(() => detectBrandSource("http://169.254.169.254/latest/meta-data/")).toThrow(
      DomainError,
    );
    expect(() => detectBrandSource("localhost:3000/perfil")).toThrow(DomainError);
  });

  it("un host normal pasa", () => {
    expect(() => assertHostAllowed("miproducto.com")).not.toThrow();
    expect(() => assertHostAllowed("www.instagram.com")).not.toThrow();
  });
});
