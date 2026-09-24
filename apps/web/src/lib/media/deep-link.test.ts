import { describe, expect, it } from "vitest";
import { readLibraryDeepLink, safeReturnPath } from "./deep-link";

describe("FR-100.1 · deep links del Media Bank", () => {
  it("sólo paths internos vuelven: nada de open redirects", () => {
    expect(safeReturnPath("/blitz/settings?focus=abc")).toBe("/blitz/settings?focus=abc");
    expect(safeReturnPath("https://evil.test")).toBeNull();
    expect(safeReturnPath("//evil.test/x")).toBeNull();
    expect(safeReturnPath("/\\evil.test")).toBeNull();
    expect(safeReturnPath("javascript:alert(1)")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
  });

  it("con contexto abre en el Media Bank; `tab` manda si viene", () => {
    const withFrom = readLibraryDeepLink(
      new URLSearchParams("from=%2Fblitz%2Fsettings&focus=media-1"),
    );
    expect(withFrom).toEqual({ from: "/blitz/settings", focus: "media-1", tab: "media" });
    expect(readLibraryDeepLink(new URLSearchParams("tab=posts")).tab).toBe("posts");
    expect(readLibraryDeepLink(new URLSearchParams("")).tab).toBeNull();
  });

  it("un `focus` con caracteres raros se ignora", () => {
    expect(
      readLibraryDeepLink(new URLSearchParams("focus=%3Cscript%3E")).focus,
    ).toBeNull();
  });
});
