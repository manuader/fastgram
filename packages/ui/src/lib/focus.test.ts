import { describe, expect, it } from "vitest";
import { FOCUSABLE_SELECTOR, resolveTrapTarget } from "./focus.js";

// El foco se representa con strings: la lógica de la trampa no depende del DOM.
const items = ["close", "input", "cancel", "confirm"] as const;

describe("resolveTrapTarget", () => {
  it("sin elementos enfocables no mueve el foco", () => {
    expect(resolveTrapTarget([], null, false)).toBeNull();
  });

  it("Tab en el último vuelve al primero", () => {
    expect(resolveTrapTarget(items, "confirm", false)).toBe("close");
  });

  it("Shift+Tab en el primero salta al último", () => {
    expect(resolveTrapTarget(items, "close", true)).toBe("confirm");
  });

  it("en el medio deja actuar al navegador", () => {
    expect(resolveTrapTarget(items, "input", false)).toBeNull();
    expect(resolveTrapTarget(items, "cancel", true)).toBeNull();
  });

  it("si el foco está fuera del modal lo trae al borde que corresponde", () => {
    expect(resolveTrapTarget(items, null, false)).toBe("close");
    expect(resolveTrapTarget(items, null, true)).toBe("confirm");
    expect(resolveTrapTarget(items, "algo-de-afuera", false)).toBe("close");
  });

  it("con un solo elemento el foco se queda ahí en las dos direcciones", () => {
    expect(resolveTrapTarget(["only"], "only", false)).toBe("only");
    expect(resolveTrapTarget(["only"], "only", true)).toBe("only");
  });
});

describe("FOCUSABLE_SELECTOR", () => {
  it("excluye lo deshabilitado y lo sacado del orden de tabulación", () => {
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
    expect(FOCUSABLE_SELECTOR).toContain("[tabindex]:not([tabindex='-1'])");
    expect(FOCUSABLE_SELECTOR).not.toContain("[tabindex='-1'],");
  });
});
