/**
 * Lo puro del alta del workspace: el cuerpo y a dónde va cada fallo.
 * El recorrido completo (proxy, CSRF, 409, foco) está en
 * `components/onboarding/WorkspaceStep.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../api/errors";
import {
  isWorkspaceAlreadyExists,
  presentWorkspaceError,
  workspaceBodyOf,
} from "./workspace";

const err = (
  code: ConstructorParameters<typeof ApiRequestError>[0]["code"],
  serverMessage?: string,
  details?: Record<string, unknown>,
) => new ApiRequestError({ code, status: 400, serverMessage, details });

describe("workspaceBodyOf", () => {
  it("web vacía o sólo espacios → null; con web, recortada; el nombre, tal cual", () => {
    expect(workspaceBodyOf(" Acme ", "")).toEqual({ name: " Acme ", websiteUrl: null });
    expect(workspaceBodyOf("Acme", "  \t")).toEqual({ name: "Acme", websiteUrl: null });
    expect(workspaceBodyOf("Acme", " acme.com ")).toEqual({
      name: "Acme",
      websiteUrl: "acme.com",
    });
  });
});

describe("isWorkspaceAlreadyExists", () => {
  it("sólo el 409 con reason workspace_already_exists", () => {
    expect(
      isWorkspaceAlreadyExists(
        err("conflict", "x", { reason: "workspace_already_exists" }),
      ),
    ).toBe(true);
    expect(
      isWorkspaceAlreadyExists(
        err("conflict", "x", { reason: "website_already_registered" }),
      ),
    ).toBe(false);
    // El message no decide: sin reason no es "ya existe".
    expect(
      isWorkspaceAlreadyExists(
        err(
          "conflict",
          "You already have a workspace. Creating additional workspaces isn't available yet.",
        ),
      ),
    ).toBe(false);
    expect(isWorkspaceAlreadyExists(new Error("x"))).toBe(false);
  });
});

describe("presentWorkspaceError", () => {
  it("400 con field conocido → ese campo, con la clave del literal", () => {
    expect(
      presentWorkspaceError(
        err("bad_request", "Company name is required", { field: "name" }),
      ),
    ).toEqual({
      kind: "field",
      field: "name",
      titleKey: "onboarding.workspace.nameRequired",
    });
    expect(
      presentWorkspaceError(
        err("bad_request", "Private IP addresses are not allowed", {
          field: "websiteUrl",
        }),
      ),
    ).toEqual({
      kind: "field",
      field: "websiteUrl",
      titleKey: "onboarding.validation.privateIp",
    });
  });

  it("409 website_already_registered → websiteUrl, aunque el message cambie", () => {
    expect(
      presentWorkspaceError(
        err("conflict", "otra redacción", { reason: "website_already_registered" }),
      ),
    ).toEqual({
      kind: "field",
      field: "websiteUrl",
      titleKey: "onboarding.workspace.websiteTaken",
    });
  });

  it("400 sin field (el schema estricto) → formulario, sin reintento", () => {
    expect(presentWorkspaceError(err("bad_request", "body/name must be string"))).toEqual(
      {
        kind: "form",
        titleKey: "error.badRequest.title",
        remedy: "none",
      },
    );
  });

  it("un field que no es del formulario no se inventa un campo", () => {
    expect(
      presentWorkspaceError(err("bad_request", "x", { field: "timezone" })).kind,
    ).toBe("form");
  });

  it("red y 503 → formulario con retry", () => {
    expect(presentWorkspaceError(err("network_error"))).toMatchObject({
      kind: "form",
      remedy: "retry",
    });
    expect(presentWorkspaceError(err("service_unavailable"))).toMatchObject({
      kind: "form",
      remedy: "retry",
    });
  });
});
