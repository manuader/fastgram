import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contraste de los tokens contra WCAG 2.1 — `NFR-019`.
 *
 * Se calcula sobre el CSS, no sobre un navegador: la luminancia relativa es
 * aritmética y no necesita render. Eso lo vuelve un test normal en vez de una
 * revisión manual que se hace una vez y nunca más.
 *
 * Umbrales de AA: **4,5:1** para texto normal, **3:1** para texto grande
 * (≥18 pt, o ≥14 pt en negrita) y para componentes de interfaz.
 *
 * Este archivo existe porque una paleta se ajusta por estética —"ese gris
 * está muy fuerte"— y el contraste se degrada sin que nadie lo note hasta que
 * alguien no puede leer la aplicación.
 */

const css = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

/** Primitivas `--fg-neutral-N` y `--fg-accent-N`. */
const PRIMITIVES = (() => {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/--(fg-(?:neutral|accent)-\d+):\s*([^;]+);/g)) {
    out.set(m[1] as string, (m[2] as string).trim());
  }
  return out;
})();

function toRgb(value: string): [number, number, number] {
  const v = value.trim();
  if (v.startsWith("#")) {
    const hex = v.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const m = v.match(/rgb\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  throw new Error(`no sé leer el color ${JSON.stringify(value)}`);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(toRgb(resolve(a)));
  const lb = relativeLuminance(toRgb(resolve(b)));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function resolve(token: string): string {
  const v = PRIMITIVES.get(token);
  if (v === undefined) throw new Error(`token desconocido: ${token}`);
  return v;
}

const AA_NORMAL = 4.5;

describe("modo claro", () => {
  it.each([
    ["texto normal sobre surface", "fg-neutral-900", "fg-neutral-0"],
    ["texto muted sobre surface", "fg-neutral-600", "fg-neutral-0"],
    ["texto subtle sobre surface", "fg-neutral-500", "fg-neutral-0"],
    ["texto normal sobre bg", "fg-neutral-900", "fg-neutral-50"],
  ])("%s cumple AA para texto normal", (_n, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe("modo oscuro", () => {
  it.each([
    ["texto normal sobre surface", "fg-neutral-50", "fg-neutral-900"],
    ["texto muted sobre surface", "fg-neutral-400", "fg-neutral-900"],
    ["texto normal sobre raised", "fg-neutral-50", "fg-neutral-800"],
  ])("%s cumple AA para texto normal", (_n, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  /**
   * `P1-UI-011`, resuelto en `PU-UI-001`.
   *
   * `--fg-color-text-subtle` en oscuro era `--fg-neutral-500`: 3,65:1 sobre
   * surface y 3,16:1 sobre raised, por debajo del 4,5:1 de AA. Ahora es
   * `--fg-neutral-450`, una primitiva nueva entre `muted` (400) y el 500:
   * pasa AA en los dos fondos y sigue siendo un escalón más tenue que `muted`
   * (el último test lo fija, para que la distinción entre niveles no se pierda
   * por arreglar el contraste).
   */
  it.each([
    ["subtle sobre surface", "fg-neutral-450", "fg-neutral-900"],
    ["subtle sobre raised", "fg-neutral-450", "fg-neutral-800"],
    ["subtle sobre bg", "fg-neutral-450", "fg-neutral-950"],
    ["subtle sobre chrome", "fg-neutral-450", "fg-neutral-975"],
    ["muted sobre chrome", "fg-neutral-400", "fg-neutral-975"],
  ])("%s cumple AA para texto normal", (_n, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("subtle sigue siendo más tenue que muted", () => {
    expect(contrast("fg-neutral-450", "fg-neutral-900")).toBeLessThan(
      contrast("fg-neutral-400", "fg-neutral-900"),
    );
  });

  it("el 500 sigue sin alcanzar AA en oscuro: no volver a usarlo para subtle", () => {
    expect(contrast("fg-neutral-500", "fg-neutral-800")).toBeLessThan(AA_NORMAL);
  });
});

describe("modo claro · shell 2026", () => {
  it.each([
    ["muted sobre chrome", "fg-neutral-600", "fg-neutral-50"],
    ["subtle sobre chrome", "fg-neutral-500", "fg-neutral-50"],
  ])("%s cumple AA para texto normal", (_n, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe("el cálculo", () => {
  it("negro sobre blanco da 21:1", () => {
    // Control: si esto fallara, todos los números de arriba serían basura.
    expect(contrast("fg-neutral-950", "fg-neutral-0")).toBeGreaterThan(18);
  });
});
