import { describe, expect, it } from "vitest";
import {
  isBrandIndependentKey,
  resolveActiveWorkspace,
  validateWorkspaceName,
  workspaceSchema,
  type Workspace,
} from "./workspaces";

const A: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  profileStatus: "ready",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const B: Workspace = { ...A, id: "22222222-2222-4222-8222-222222222222", name: "Beta" };

describe("validateWorkspaceName", () => {
  it("vacío o sólo espacios es required", () => {
    expect(validateWorkspaceName("")).toBe("required");
    expect(validateWorkspaceName("   ")).toBe("required");
  });

  it("el límite de 80 se mide recortado", () => {
    expect(validateWorkspaceName(`  ${"a".repeat(80)}  `)).toBeNull();
    expect(validateWorkspaceName("a".repeat(81))).toBe("too_long");
  });
});

describe("resolveActiveWorkspace", () => {
  it("con cookie válida, esa", () => {
    expect(resolveActiveWorkspace([A, B], B.id)).toBe(B);
  });

  it("sin cookie o con una que no está, la más antigua (la default)", () => {
    expect(resolveActiveWorkspace([A, B], null)).toBe(A);
    expect(resolveActiveWorkspace([A, B], "33333333-3333-4333-8333-333333333333")).toBe(
      A,
    );
  });

  it("sin marcas, null", () => {
    expect(resolveActiveWorkspace([], null)).toBeNull();
  });
});

describe("isBrandIndependentKey", () => {
  it("la lista de marcas, el modo y el estado sobreviven al cambio de marca", () => {
    expect(isBrandIndependentKey(["workspaces"])).toBe(true);
    expect(isBrandIndependentKey(["app-mode"])).toBe(true);
    expect(isBrandIndependentKey(["service-status"])).toBe(true);
  });

  it("todo lo demás se resetea", () => {
    expect(isBrandIndependentKey(["posts", {}])).toBe(false);
    expect(isBrandIndependentKey(["brand", "profile"])).toBe(false);
  });
});

describe("workspaceSchema", () => {
  it("rechaza un profileStatus fuera del contrato", () => {
    expect(workspaceSchema.safeParse({ ...A, profileStatus: "done" }).success).toBe(
      false,
    );
  });
});
