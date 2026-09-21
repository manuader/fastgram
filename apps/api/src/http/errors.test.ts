import { describe, expect, it } from "vitest";
import { DomainError, crossTenantAsNotFound } from "@fastgram/core";
import { PortError } from "@fastgram/ports";
import { translateError, unauthorized } from "./errors.js";

describe("translateError", () => {
  it("el acceso cruzado sale como 404, nunca como 403 (PRD §9.2)", () => {
    // Un 403 le confirma a quien sondea que el id existe. El PRD lo prohíbe
    // explícitamente para no filtrar existencia.
    const t = translateError(crossTenantAsNotFound("Content", "ct_1", "co_intruso"));
    expect(t.status).toBe(404);
    expect(t.body.error.code).toBe("not_found");
    // Indistinguible de un id que no existe.
    expect(t.body).toEqual(
      translateError(new DomainError("not_found", "Content not found")).body,
    );
    // Pero el log sí lo distingue.
    expect(t.logContext["details"]).toMatchObject({ crossTenant: true });
  });

  it("el proveedor nunca aparece en el cuerpo, sólo en el log", () => {
    const e = new PortError("provider_unavailable", "Storage is unavailable", {
      source: "Storage/r2",
      cause: new Error("AWS SDK: NoSuchBucket arn:aws:s3:::fastgram-prod"),
    });
    const t = translateError(e);

    const serializado = JSON.stringify(t.body);
    expect(serializado).not.toContain("r2");
    expect(serializado).not.toContain("NoSuchBucket");
    expect(serializado).not.toContain("aws");
    expect(t.logContext["source"]).toBe("Storage/r2");
  });

  it("todo 401 lleva WWW-Authenticate (PRD §9.1)", () => {
    const t = translateError(
      new PortError("unauthorized", "Invalid or revoked API key", {
        source: "Identity/apikey",
      }),
    );
    expect(t.status).toBe(401);
    expect(t.headers["WWW-Authenticate"]).toBe('Bearer realm="api"');
    expect(unauthorized("x").headers["WWW-Authenticate"]).toBe('Bearer realm="api"');
  });

  it("rate_limited propaga Retry-After cuando el proveedor lo dio", () => {
    const t = translateError(
      new PortError("rate_limited", "Too many requests", {
        source: "SocialPublisher/tiktok",
        retryAfterSeconds: 42,
      }),
    );
    expect(t.status).toBe(429);
    expect(t.headers["Retry-After"]).toBe("42");
  });

  it("un proveedor que rompe el contrato es 502, no 400", () => {
    // No es culpa del cliente: es nuestra integración la que falló.
    const t = translateError(
      new PortError("provider_contract_violation", "Unexpected payload", {
        source: "Llm/gateway",
      }),
    );
    expect(t.status).toBe(502);
  });

  it("cuota agotada es 402", () => {
    expect(translateError(new DomainError("content_quota_exceeded", "x")).status).toBe(
      402,
    );
    expect(translateError(new DomainError("blitz_quota_blocked", "x")).status).toBe(402);
  });

  it("un error inesperado no filtra nada hacia afuera", () => {
    const t = translateError(new Error("connection to postgres://user:pass@db failed"));
    expect(t.status).toBe(500);
    expect(t.body.error.code).toBe("internal_error");
    expect(JSON.stringify(t.body)).not.toContain("postgres");
    // Pero el log lo conserva entero, que es donde sirve.
    expect(t.logContext["error"]).toBeInstanceOf(Error);
  });

  it("el envelope tiene la forma del PRD §9.3", () => {
    const t = translateError(new DomainError("out_of_range", "slides must be 1–20"));
    expect(Object.keys(t.body)).toEqual(["error"]);
    expect(Object.keys(t.body.error).sort()).toEqual(["code", "message"]);
  });
});
