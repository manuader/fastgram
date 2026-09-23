import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "../openapi.js";
import {
  WORKSPACE_NAME_MAX_CHARS,
  createWorkspaceRequestSchema,
  workspaceSchema,
} from "./workspaces.js";

describe("POST /onboarding/workspace — request", () => {
  it("name solo alcanza; websiteUrl puede faltar, ser null o vacía", () => {
    expect(createWorkspaceRequestSchema.safeParse({ name: "Acme" }).success).toBe(true);
    expect(
      createWorkspaceRequestSchema.safeParse({ name: "Acme", websiteUrl: null }).success,
    ).toBe(true);
    expect(
      createWorkspaceRequestSchema.safeParse({ name: "Acme", websiteUrl: "" }).success,
    ).toBe(true);
  });

  it("NO valida el mínimo del nombre: la copy de FR-010 es del dominio", () => {
    // Si esto pasara a fallar, «Company name is required» no llegaría nunca a la UI.
    expect(createWorkspaceRequestSchema.safeParse({ name: "" }).success).toBe(true);
    expect(createWorkspaceRequestSchema.safeParse({ name: "A" }).success).toBe(true);
  });

  it("strict: una clave de más es 400 (ni planId ni ownerUserId se eligen desde el cable)", () => {
    for (const extra of [{ planId: "pro" }, { ownerUserId: "x" }, { status: "active" }]) {
      expect(
        createWorkspaceRequestSchema.safeParse({ name: "Acme", ...extra }).success,
      ).toBe(false);
    }
  });

  it("name es obligatorio y tiene cota de sanidad", () => {
    expect(createWorkspaceRequestSchema.safeParse({}).success).toBe(false);
    expect(
      createWorkspaceRequestSchema.safeParse({
        name: "x".repeat(WORKSPACE_NAME_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});

describe("POST /onboarding/workspace — response", () => {
  it("la forma del workspace es estricta", () => {
    const ok = {
      id: "c1",
      name: "Acme",
      websiteUrl: null,
      status: "draft",
      planId: "free",
      subscriptionStatus: "trialing",
      timezone: "UTC",
      createdAt: "2026-09-23T00:00:00.000Z",
    };
    expect(workspaceSchema.safeParse(ok).success).toBe(true);
    expect(workspaceSchema.safeParse({ ...ok, ownerUserId: "u" }).success).toBe(false);
  });
});

describe("OpenAPI", () => {
  it("está documentada como interna, sin API key, con el header de sesión y sus 409", () => {
    const op = buildOpenApiDocument().paths["/onboarding/workspace"]?.post;
    expect(op?.["x-internal"]).toBe(true);
    expect(op?.security).toEqual([]);
    expect(op?.parameters?.map((p) => p.name)).toEqual(["X-Fastgram-Session"]);
    expect(Object.keys(op?.responses ?? {}).sort()).toEqual([
      "201",
      "400",
      "401",
      "403",
      "409",
      "503",
    ]);
  });
});
