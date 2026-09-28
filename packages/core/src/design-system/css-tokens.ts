/**
 * Lectura de los tokens CSS de un export de Claude Design — `PU-S9-001`.
 *
 * No es un parser de CSS: es lo justo para la forma que exporta Claude Design
 * (medida sobre FOCUS, `tokens/*.css`), y tolerante con lo demás:
 *
 *  - custom properties `--x: valor;` en cualquier bloque (en la práctica
 *    `:root`), con alias `var(--y)` que se resuelven con profundidad acotada;
 *  - `@font-face { font-family; src: url(…); font-weight; font-style }`, con la
 *    URL resuelta **relativa al archivo CSS** (`../assets/fonts/x.otf` desde
 *    `tokens/typography.css` → `assets/fonts/x.otf`);
 *  - `@import url(…fonts.googleapis.com/css2?family=…)`: las familias de
 *    Google Fonts que el export usa como stand-in, con sus pesos.
 *
 * Lo que no entiende se ignora: un token que no es color, fuente ni medida no
 * hace falta para generar contenido.
 */
import { safeZipPath } from "./zip-guard.js";

export interface CssCustomProperty {
  readonly name: string;
  readonly value: string;
  /** El archivo donde se declaró (para el orden y los avisos). */
  readonly file: string;
}

export interface CssFontFace {
  readonly family: string;
  /** Ruta dentro del zip, ya resuelta. `null` si el `src` sale del zip. */
  readonly file: string | null;
  readonly weight: number;
  readonly style: "normal" | "italic";
}

export interface CssGoogleFamily {
  readonly name: string;
  readonly weights: readonly number[];
}

export interface CssTokens {
  readonly properties: readonly CssCustomProperty[];
  readonly fontFaces: readonly CssFontFace[];
  readonly googleFamilies: readonly CssGoogleFamily[];
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, "");

/** Saca comillas simples o dobles de los extremos. */
export function unquote(value: string): string {
  const v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/** Resuelve `ref` relativo al directorio de `fromFile`. `null` si sale del árbol. */
export function resolveRelative(fromFile: string, ref: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(ref) || ref.startsWith("//")) return null;
  const clean = ref.split(/[?#]/u)[0] ?? "";
  const baseDir = fromFile.includes("/")
    ? fromFile.slice(0, fromFile.lastIndexOf("/"))
    : "";
  const parts = baseDir === "" ? [] : baseDir.split("/");
  for (const segment of clean.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const joined = parts.join("/");
  const safe = safeZipPath(joined);
  return safe.ok ? safe.path : null;
}

const WEIGHT_WORDS: Readonly<Record<string, number>> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

/** `font-weight` a número (100–900). Rangos (`100 900`) toman el primero. */
export function parseFontWeight(raw: string | undefined): number {
  if (raw === undefined) return 400;
  const first = raw.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  const n = Number.parseInt(first, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 1000) {
    return Math.min(900, Math.max(100, Math.round(n / 100) * 100));
  }
  return WEIGHT_WORDS[first.replace(/[-_\s]/gu, "")] ?? 400;
}

function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of block.split(";")) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (key !== "" && value !== "") out.set(key, value);
  }
  return out;
}

function parseFontFaces(css: string, file: string): CssFontFace[] {
  const out: CssFontFace[] = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/giu)) {
    const decl = declarations(match[1] ?? "");
    const family = unquote(decl.get("font-family") ?? "");
    if (family === "") continue;
    const src = decl.get("src") ?? "";
    const url = /url\(\s*(['"]?)([^'")]+)\1\s*\)/iu.exec(src)?.[2] ?? null;
    out.push({
      family,
      file: url === null ? null : resolveRelative(file, url),
      weight: parseFontWeight(decl.get("font-weight")),
      style: /italic|oblique/iu.test(decl.get("font-style") ?? "") ? "italic" : "normal",
    });
  }
  return out;
}

/**
 * Las familias de un `@import` de Google Fonts (`css2?family=A:wght@400;700&family=B`).
 * Los pesos salen del eje `wght` de cada tupla; sin ejes, 400.
 */
export function parseGoogleFontsUrl(url: string): CssGoogleFamily[] {
  if (!/^https:\/\/fonts\.googleapis\.com\//iu.test(url)) return [];
  const query = url.split("?")[1] ?? "";
  const out: CssGoogleFamily[] = [];
  for (const param of query.split("&")) {
    if (!param.startsWith("family=")) continue;
    let spec: string;
    try {
      spec = decodeURIComponent(param.slice("family=".length).replace(/\+/gu, " "));
    } catch {
      continue;
    }
    const [namePart, axesPart] = spec.split(":", 2);
    const name = (namePart ?? "").trim();
    if (name === "") continue;
    const weights = new Set<number>();
    if (axesPart !== undefined && axesPart.includes("@")) {
      const [axesNames, tuples] = axesPart.split("@", 2);
      const axes = (axesNames ?? "").split(",");
      const wIndex = axes.indexOf("wght");
      for (const tuple of (tuples ?? "").split(";")) {
        const values = tuple.split(",");
        // Una tupla puede traer sólo el último eje (`8..60,400;500;600`):
        // si tiene menos valores que ejes, el que queda es el último.
        const raw =
          wIndex < 0
            ? undefined
            : values.length === axes.length
              ? values[wIndex]
              : values[values.length - 1];
        const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 100 && n <= 900) weights.add(n);
      }
    }
    out.push({ name, weights: weights.size === 0 ? [400] : [...weights].sort() });
  }
  return out;
}

/** Lee un archivo CSS. Puro, sin red. */
export function parseCssTokens(css: string, file: string): CssTokens {
  const clean = stripComments(css);
  const googleFamilies: CssGoogleFamily[] = [];
  // Entre comillas la URL puede traer `;` (`wght@400;500`): se toma hasta la
  // comilla que cierra. Sin comillas, hasta el paréntesis o el espacio.
  for (const m of clean.matchAll(
    /@import\s+(?:url\(\s*)?(?:(['"])(.*?)\1|([^'")\s;]+))/giu,
  )) {
    googleFamilies.push(...parseGoogleFontsUrl(m[2] ?? m[3] ?? ""));
  }
  const fontFaces = parseFontFaces(clean, file);
  const withoutFaces = clean.replace(/@font-face\s*\{[^}]*\}/giu, "");
  const properties: CssCustomProperty[] = [];
  for (const m of withoutFaces.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/gu)) {
    const name = m[1] ?? "";
    const value = (m[2] ?? "").trim();
    if (name !== "" && value !== "") properties.push({ name, value, file });
  }
  return { properties, fontFaces, googleFamilies };
}

/** Une varios CSS; la última declaración de un nombre gana, como en el navegador. */
export function mergeCssTokens(all: readonly CssTokens[]): CssTokens {
  const byName = new Map<string, CssCustomProperty>();
  const faces: CssFontFace[] = [];
  const google = new Map<string, CssGoogleFamily>();
  for (const t of all) {
    for (const p of t.properties) byName.set(p.name, p);
    faces.push(...t.fontFaces);
    for (const g of t.googleFamilies) google.set(g.name.toLowerCase(), g);
  }
  return {
    properties: [...byName.values()],
    fontFaces: faces,
    googleFamilies: [...google.values()],
  };
}

/* ------------------------------------------------------------------------ *
 * Valores
 * ------------------------------------------------------------------------ */

const VAR_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)$/u;
const MAX_ALIAS_DEPTH = 8;

export interface ResolvedValue {
  readonly value: string;
  /** La cadena de alias, sin el propio nombre (`--surface-dark` → [`--focus-ink`]). */
  readonly chain: readonly string[];
}

/** Resuelve `var(--x)` contra las propiedades, con tope de profundidad y ciclos. */
export function resolveVar(
  value: string,
  props: ReadonlyMap<string, string>,
): ResolvedValue | null {
  let current = value.trim();
  const chain: string[] = [];
  for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth += 1) {
    const m = VAR_RE.exec(current);
    if (m === null) return { value: current, chain };
    const ref = m[1] ?? "";
    if (chain.includes(ref)) return null;
    const next = props.get(ref);
    chain.push(ref);
    if (next === undefined) {
      const fallback = m[2];
      if (fallback === undefined) return null;
      current = fallback.trim();
    } else {
      current = next.trim();
    }
  }
  return null;
}

/** `#RGB`, `#RRGGBB`, `#RRGGBBAA` (el alfa se descarta), `rgb()`/`rgba()`. A `#RRGGBB`. */
export function normalizeColor(raw: string): string | null {
  const v = raw.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(v);
  if (hex !== null) {
    let h = hex[1] ?? "";
    if (h.length === 3 || h.length === 4) {
      h = h
        .slice(0, 3)
        .split("")
        .map((c) => c + c)
        .join("");
    }
    return `#${h.slice(0, 6).toUpperCase()}`;
  }
  const rgb =
    /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/iu.exec(
      v,
    );
  if (rgb !== null) {
    const parts = [rgb[1], rgb[2], rgb[3]].map((n) => Number.parseInt(n ?? "", 10));
    if (parts.some((n) => !Number.isFinite(n) || n > 255)) return null;
    return `#${parts
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
  }
  return null;
}

/** `16px`, `1.5rem` (×16), `0`. A píxeles. `null` si no es una medida simple. */
export function parseLength(raw: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)(px|rem)?$/iu.exec(raw.trim());
  if (m === null) return null;
  const n = Number.parseFloat(m[1] ?? "");
  if (!Number.isFinite(n)) return null;
  if ((m[2] ?? "").toLowerCase() === "rem") return n * 16;
  if (m[2] === undefined && n !== 0) return null;
  return n;
}

/** Una pila `font-family` a sus nombres, sin comillas. */
export function parseFontStack(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => unquote(s))
    .filter((s) => s !== "");
}
