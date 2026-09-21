import { describe, expect, it } from "vitest";
import { crossTenantAsNotFound, DomainError, isDomainError } from "./errors.js";

describe("DomainError", () => {
  it("lo público no incluye los detalles internos", () => {
    const e = new DomainError("out_of_range", "slides must be 1–20", {
      received: 25,
      companyId: "co_secreto",
    });
    expect(e.toPublic()).toEqual({ code: "out_of_range", message: "slides must be 1–20" });
    expect(JSON.stringify(e.toPublic())).not.toContain("co_secreto");
  });

  it("el acceso cruzado es indistinguible de un id inexistente", () => {
    const cruzado = crossTenantAsNotFound("Content", "ct_123", "co_otra");
    expect(cruzado.code).toBe("not_found");
    expect(cruzado.toPublic()).toEqual(
      new DomainError("not_found", "Content not found").toPublic(),
    );
    // El log sí lo distingue: es la señal de que alguien está sondeando ids.
    expect(cruzado.details?.["crossTenant"]).toBe(true);
  });

  it("isDomainError no confunde un Error común", () => {
    expect(isDomainError(new DomainError("conflict", "x"))).toBe(true);
    expect(isDomainError(new Error("x"))).toBe(false);
  });
});
