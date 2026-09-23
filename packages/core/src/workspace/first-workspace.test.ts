import { describe, expect, it } from "vitest";

import { DomainError } from "../errors.js";
import { ONBOARDING_MESSAGES } from "../onboarding/onboarding.js";
import { PLAN_IDS } from "../quota/plans.js";
import {
  FIRST_WORKSPACE_PLAN_ID,
  FIRST_WORKSPACE_STATUS,
  FIRST_WORKSPACE_SUBSCRIPTION_STATUS,
  WEBSITE_MESSAGES,
  WORKSPACE_ALREADY_EXISTS_MESSAGE,
  normalizeWorkspaceWebsite,
  planFirstWorkspace,
  websiteAlreadyRegistered,
  workspaceAlreadyExists,
} from "./first-workspace.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-23T15:30:00.000Z");

function thrown(fn: () => unknown): DomainError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  // Fuera del `try` (trampa 47): si `fn` no lanza, esto falla de verdad.
  expect(caught).toBeInstanceOf(DomainError);
  return caught as DomainError;
}

describe("la decisión del dueño (PRD §2.4, 2026-09-23)", () => {
  it("nace en Free + trialing, en draft, con el dueño como owner activo y como default", () => {
    const plan = planFirstWorkspace({ ownerUserId: OWNER, name: "Acme" }, NOW);
    expect(plan).toEqual({
      ownerUserId: OWNER,
      name: "Acme",
      websiteUrl: null,
      planId: "free",
      subscriptionStatus: "trialing",
      status: "draft",
      billingAnchorDay: 23,
      ownerMembership: { role: "owner", status: "active" },
      setAsDefaultWorkspace: true,
    });
  });

  it("las constantes son las de la decisión, y `free` es un plan del catálogo", () => {
    expect(FIRST_WORKSPACE_PLAN_ID).toBe("free");
    expect(FIRST_WORKSPACE_SUBSCRIPTION_STATUS).toBe("trialing");
    expect(FIRST_WORKSPACE_STATUS).toBe("draft");
    expect(PLAN_IDS).toContain(FIRST_WORKSPACE_PLAN_ID);
  });
});

describe("billingAnchorDay: el día UTC de la creación", () => {
  it("usa UTC, no la hora local: 23:30 del 30 en UTC-3 es el 1 en UTC", () => {
    const plan = planFirstWorkspace(
      { ownerUserId: OWNER, name: "Acme" },
      new Date("2026-10-01T02:30:00.000Z"),
    );
    expect(plan.billingAnchorDay).toBe(1);
  });

  it("un alta el 31 ancla en 31 (el recorte a meses cortos es de quota/reset)", () => {
    const plan = planFirstWorkspace(
      { ownerUserId: OWNER, name: "Acme" },
      new Date("2026-08-31T12:00:00.000Z"),
    );
    expect(plan.billingAnchorDay).toBe(31);
  });

  it("una fecha inválida no produce un ancla NaN", () => {
    expect(() =>
      planFirstWorkspace({ ownerUserId: OWNER, name: "Acme" }, new Date("x")),
    ).toThrow(/fecha válida/);
  });
});

describe("el nombre (FR-010, copy literal)", () => {
  it("vacío o sólo espacios → «Company name is required», con field", () => {
    for (const name of ["", "   "]) {
      const error = thrown(() => planFirstWorkspace({ ownerUserId: OWNER, name }, NOW));
      expect(error.code).toBe("out_of_range");
      expect(error.message).toBe(ONBOARDING_MESSAGES.companyNameRequired);
      expect(error.details?.["field"]).toBe("name");
    }
  });

  it("1 carácter (recortado) → «Company name must be at least 2 characters»", () => {
    const error = thrown(() =>
      planFirstWorkspace({ ownerUserId: OWNER, name: "  A  " }, NOW),
    );
    expect(error.message).toBe(ONBOARDING_MESSAGES.companyNameTooShort);
  });

  it("2 caracteres pasa, y se guarda recortado", () => {
    expect(planFirstWorkspace({ ownerUserId: OWNER, name: "  Ab " }, NOW).name).toBe(
      "Ab",
    );
  });
});

describe("la web: opcional (EXT-001), canónica y sólo web", () => {
  it("null, undefined y vacía son «sin web»", () => {
    expect(normalizeWorkspaceWebsite(null)).toBeNull();
    expect(normalizeWorkspaceWebsite(undefined)).toBeNull();
    expect(normalizeWorkspaceWebsite("  ")).toBeNull();
  });

  it("se canonicaliza: sin www, sin tracking, sin barra final", () => {
    expect(normalizeWorkspaceWebsite("https://www.acme.com/?utm_source=x")).toBe(
      "https://acme.com",
    );
    expect(normalizeWorkspaceWebsite("acme.com/")).toBe("https://acme.com");
  });

  it("las dos formas de la misma web dan el mismo valor (lo que mide la unicidad)", () => {
    expect(normalizeWorkspaceWebsite("www.acme.com")).toBe(
      normalizeWorkspaceWebsite("https://acme.com/?fbclid=1"),
    );
  });

  it("un perfil social o un @handle no son una web", () => {
    for (const raw of ["instagram.com/acme", "@acme", "not a url at all"]) {
      const error = thrown(() => normalizeWorkspaceWebsite(raw));
      expect(error.message).toBe(WEBSITE_MESSAGES.invalid);
      expect(error.details?.["field"]).toBe("websiteUrl");
    }
  });

  it("SSRF: el copy literal de FR-010, con field websiteUrl", () => {
    const local = thrown(() => normalizeWorkspaceWebsite("http://localhost:3000"));
    expect(local.message).toBe("Localhost URLs are not allowed");
    expect(local.details?.["field"]).toBe("websiteUrl");

    const priv = thrown(() => normalizeWorkspaceWebsite("http://169.254.169.254/"));
    expect(priv.message).toBe("Private IP addresses are not allowed");
    expect(priv.details?.["field"]).toBe("websiteUrl");
  });

  it("llega normalizada al plan", () => {
    const plan = planFirstWorkspace(
      { ownerUserId: OWNER, name: "Acme", websiteUrl: "www.Acme.com" },
      NOW,
    );
    expect(plan.websiteUrl).toBe("https://acme.com");
  });
});

describe("los rechazos", () => {
  it("ya tiene workspace → conflict; el id existente queda en details (log), no en el mensaje", () => {
    const error = workspaceAlreadyExists("22222222-2222-4222-8222-222222222222");
    expect(error.code).toBe("conflict");
    expect(error.message).toBe(WORKSPACE_ALREADY_EXISTS_MESSAGE);
    expect(error.message).not.toContain("2222");
    expect(error.details?.["reason"]).toBe("workspace_already_exists");
  });

  it("web ya registrada → conflict con el copy literal de FR-010", () => {
    const error = websiteAlreadyRegistered();
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("This website is already registered.");
    expect(error.details?.["reason"]).toBe("website_already_registered");
  });
});
