import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "@/lib/theme/theme";
import { readThemeChoice, THEME_INIT_SCRIPT_WITH_DEFAULT } from "./default-theme";

/** Corre el script inline tal como lo haría el `<head>`. */
function runInitScript(): void {
  // Es lo que hace el navegador con el `<script>` inline; el string es una
  // constante del repo, no entrada de nadie.
  new Function(THEME_INIT_SCRIPT_WITH_DEFAULT)();
}

/**
 * `localStorage` en memoria. El de jsdom no siempre está (según la versión de
 * Node, el global experimental de Node lo tapa con `undefined`), y lo que se
 * prueba acá es el script, no el storage del entorno.
 */
function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "clear"> {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    clear: () => {
      data.clear();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});

describe("oscuro por defecto (PU-UI-001)", () => {
  it("sin elección guardada, el script fija dark", () => {
    runInitScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readThemeChoice()).toBe("dark");
  });

  it("una elección guardada gana: light", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    runInitScript();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(readThemeChoice()).toBe("light");
  });

  it("quien eligió system no queda forzado a oscuro", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    runInitScript();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(readThemeChoice()).toBe("system");
  });

  it("si el storage lanza, oscuro igual y sin romper la página", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(runInitScript).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readThemeChoice()).toBe("dark");
  });
});
