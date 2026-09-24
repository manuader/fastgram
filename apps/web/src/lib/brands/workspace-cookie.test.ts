import { describe, expect, it } from "vitest";
import {
  isWorkspaceId,
  parseWorkspaceCookie,
  serializeClearedWorkspaceCookie,
  serializeWorkspaceCookie,
  WORKSPACE_COOKIE,
} from "./workspace-cookie";

const BRAND = "3f2b8c1e-9a4d-4c6b-8e2f-1a2b3c4d5e6f";

describe("isWorkspaceId", () => {
  it("acepta un uuid y nada más", () => {
    expect(isWorkspaceId(BRAND)).toBe(true);
    expect(isWorkspaceId(BRAND.toUpperCase())).toBe(true);
    expect(isWorkspaceId(`${BRAND} `)).toBe(false);
    expect(isWorkspaceId("../admin")).toBe(false);
    expect(isWorkspaceId(null)).toBe(false);
    expect(isWorkspaceId(undefined)).toBe(false);
  });
});

describe("parseWorkspaceCookie", () => {
  it("encuentra la cookie entre otras", () => {
    expect(
      parseWorkspaceCookie(`fg_session=abc; ${WORKSPACE_COOKIE}=${BRAND}; x=1`),
    ).toBe(BRAND);
  });

  it("no la confunde con una cookie de nombre parecido", () => {
    expect(parseWorkspaceCookie(`x${WORKSPACE_COOKIE}=${BRAND}`)).toBeNull();
  });

  it("sin cookie, o con un valor sin forma, es null", () => {
    expect(parseWorkspaceCookie("")).toBeNull();
    expect(parseWorkspaceCookie(`${WORKSPACE_COOKIE}=nope`)).toBeNull();
    expect(parseWorkspaceCookie(`${WORKSPACE_COOKIE}=%E0%A4%A`)).toBeNull();
  });
});

describe("serialize", () => {
  it("fija la cookie para toda la app, Lax, y Secure sólo en https", () => {
    expect(serializeWorkspaceCookie(BRAND, false)).toBe(
      `${WORKSPACE_COOKIE}=${BRAND}; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
    expect(serializeWorkspaceCookie(BRAND, true)).toMatch(/; Secure$/);
  });

  it("borrar es Max-Age=0 en el mismo Path", () => {
    expect(serializeClearedWorkspaceCookie()).toBe(
      `${WORKSPACE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`,
    );
  });
});
