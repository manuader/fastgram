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

/**
 * Los tonos de **todas** las plataformas. El chip pinta el **texto** con el
 * color de marca, así que se les pide AA de texto normal.
 *
 * Cada token se declara tres veces, en orden: claro (`:root`), oscuro por
 * preferencia del sistema y oscuro explícito (`[data-theme="dark"]`). Los dos
 * oscuros tienen que coincidir.
 *
 * Hasta el 2026-09-24 sólo entraban X, Threads y Facebook (`D-09`): las cinco
 * de antes usaban el color de marca tal cual y varias no llegaban a 4,5:1
 * (YouTube #FF0000 daba 4,0:1 sobre blanco). Ahora se ajustan con el mismo
 * criterio que Facebook —el mismo tono, más oscuro en claro y más claro en
 * oscuro— y la lista sale del CSS: una red nueva sin sus tres declaraciones, o
 * por debajo de AA, rompe este test.
 */
function platformDeclarations(platform: string): string[] {
  const re = new RegExp(`--fg-platform-${platform}:\\s*([^;]+);`, "g");
  return [...css.matchAll(re)].map((m) => (m[1] as string).trim());
}

function contrastRaw(fg: string, bgToken: string): number {
  const la = relativeLuminance(toRgb(fg));
  const lb = relativeLuminance(toRgb(resolve(bgToken)));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Todas las `--fg-platform-*` que declara el CSS, sin repetir. */
const PLATFORMS = [
  ...new Set([...css.matchAll(/--fg-platform-([a-z]+):/g)].map((m) => m[1] as string)),
];

describe("tonos de plataforma · todas las redes", () => {
  const LIGHT_SURFACES = ["fg-neutral-0", "fg-neutral-50", "fg-neutral-100"];
  const DARK_SURFACES = [
    "fg-neutral-900",
    "fg-neutral-800",
    "fg-neutral-950",
    "fg-neutral-975",
  ];

  it("la lista cubre al menos las ocho redes conocidas", () => {
    for (const p of [
      "tiktok",
      "instagram",
      "youtube",
      "linkedin",
      "reddit",
      "x",
      "threads",
      "facebook",
    ]) {
      expect(PLATFORMS).toContain(p);
    }
  });

  it.each(PLATFORMS)("%s: claro + los dos oscuros, iguales entre sí", (p) => {
    const decl = platformDeclarations(p);
    expect(decl).toHaveLength(3);
    expect(decl[1]).toBe(decl[2]);
  });

  it.each(PLATFORMS)("%s cumple AA en claro y en oscuro", (p) => {
    const [light, dark] = platformDeclarations(p) as [string, string, string];
    for (const bg of LIGHT_SURFACES) {
      expect(contrastRaw(light, bg), `${p} claro sobre ${bg}`).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    }
    for (const bg of DARK_SURFACES) {
      expect(contrastRaw(dark, bg), `${p} oscuro sobre ${bg}`).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
    }
  });

  it.each([
    ["facebook", "#1877f2"],
    ["instagram", "#e1306c"],
    ["youtube", "#ff0000"],
    ["reddit", "#ff4500"],
  ])(
    "el color de marca de %s (%s) no llega a AA en claro: por eso el token es otro",
    (p, brand) => {
      expect(contrastRaw(brand, "fg-neutral-100")).toBeLessThan(AA_NORMAL);
      expect(platformDeclarations(p)[0]).not.toBe(brand);
    },
  );
});

describe("el cálculo", () => {
  it("negro sobre blanco da 21:1", () => {
    // Control: si esto fallara, todos los números de arriba serían basura.
    expect(contrast("fg-neutral-950", "fg-neutral-0")).toBeGreaterThan(18);
  });
});
