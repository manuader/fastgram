/**
 * Rutas del zip → `ParsedDesignSystem` — `PU-S9-001`.
 *
 * Puro: recibe los archivos ya extraídos (texto decodificado para CSS, MD,
 * JSON y SVG; tamaño y sha256 para todo) y no toca red ni disco. El worker
 * infla, hashea y llama; la API no llama nunca.
 *
 * El formato es el de un export de Claude Design, medido sobre FOCUS (ver el
 * brief): `SKILL.md`, `readme.md`, `_ds_manifest.json`, `tokens/*.css`,
 * `assets/{fonts,logo,imagery,motifs}/…`, `uploads/…` (duplicados). **Todo es
 * opcional** salvo tener tokens o readme: otro export puede no traer alguna
 * carpeta, y eso no es un error.
 */
import {
  mergeCssTokens,
  normalizeColor,
  parseCssTokens,
  parseFontStack,
  parseLength,
  resolveVar,
  type CssTokens,
} from "./css-tokens.js";
import {
  fallbackFamilyFor,
  fontCategory,
  fontFamilyId,
  isGenericFamily,
  registeredFamilyNamed,
} from "./fonts.js";
import type {
  DesignSystemTokens,
  DsAsset,
  DsAssetKind,
  DsColor,
  DsFontFace,
  DsFontFamily,
  DsRule,
  DsSemanticColors,
  DsSpacing,
  DsTypeRole,
  ParsedDesignSystem,
} from "./types.js";
import { svgIsSafe, type DesignSystemFileKind } from "./zip-guard.js";

/** Un archivo extraído, como lo entrega el worker. */
export interface DesignSystemEntry {
  readonly path: string;
  readonly kind: DesignSystemFileKind;
  readonly bytes: number;
  /** sha256 hex del contenido: la deduplicación compara esto. */
  readonly sha256: string;
  /** Sólo para `text` y `svg`: el contenido decodificado como UTF-8. */
  readonly text?: string;
}

export type ParseOutcome =
  | { readonly ok: true; readonly ds: ParsedDesignSystem }
  | {
      readonly ok: false;
      readonly code: "empty_design_system";
      readonly detail: string;
    };

/** Cuánto readme viaja al resumen de estilo. FOCUS tiene 8,8 KB. */
export const README_MAX_CHARS = 12_000;
/** Reglas del manifest que se guardan. FOCUS trae 14 tarjetas. */
export const MAX_RULES = 40;
const MAX_RULE_CHARS = 300;

const lower = (s: string): string => s.toLowerCase();

function findRootFile(
  entries: readonly DesignSystemEntry[],
  name: string,
): DesignSystemEntry | null {
  return (
    entries.find((e) => !e.path.includes("/") && lower(e.path) === lower(name)) ?? null
  );
}

/* ------------------------------------------------------------------------ *
 * Metadatos: SKILL.md, readme, manifest
 * ------------------------------------------------------------------------ */

function frontmatter(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const m = /^---\s*\n([\s\S]*?)\n---/u.exec(md);
  if (m === null) return out;
  for (const line of (m[1] ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    out.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return out;
}

function readmeTitle(md: string): string | null {
  const m = /^#\s+(.+)$/mu.exec(md);
  return m === null ? null : (m[1] ?? "").trim() || null;
}

/**
 * El tagline: la primera línea que diga `Tagline:` seguida de una frase entre
 * comillas (rectas o tipográficas), con o sin énfasis de markdown.
 */
export function extractTagline(md: string): string | null {
  const m = /tagline[^:\n]{0,40}:\s*[*_]*\s*["“]([^"”\n]{2,200})["”]/iu.exec(md);
  return m === null ? null : (m[1] ?? "").trim();
}

interface ManifestCard {
  readonly group: string | null;
  readonly name: string | null;
  readonly subtitle: string | null;
}

function readManifest(text: string | undefined): {
  namespace: string | null;
  cards: ManifestCard[];
} {
  if (text === undefined) return { namespace: null, cards: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { namespace: null, cards: [] };
  }
  if (typeof raw !== "object" || raw === null) return { namespace: null, cards: [] };
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  const cards: ManifestCard[] = [];
  if (Array.isArray(obj["cards"])) {
    for (const c of obj["cards"]) {
      if (typeof c !== "object" || c === null) continue;
      const card = c as Record<string, unknown>;
      cards.push({
        group: str(card["group"]),
        name: str(card["name"]),
        subtitle: str(card["subtitle"]),
      });
    }
  }
  return { namespace: str(obj["namespace"]), cards };
}

/* ------------------------------------------------------------------------ *
 * Colores
 * ------------------------------------------------------------------------ */

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}

function saturation(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(...c);
  const min = Math.min(...c);
  if (max === 0) return 0;
  return (max - min) / max;
}

export function isNeutral(hex: string): boolean {
  return saturation(hex) < 0.2;
}

/**
 * Los roles de color. Primero por nombre (la convención de Claude Design:
 * `--surface-dark`, `--text-on-dark`, `--accent-1`…); lo que falte, por
 * luminancia y saturación: la superficie oscura es el neutro más oscuro, la
 * clara el más claro, los acentos los saturados.
 */
export function semanticColors(colors: readonly DsColor[]): DsSemanticColors {
  const byName = (patterns: readonly RegExp[]): string | null => {
    for (const re of patterns) {
      const hit = colors.find((c) => re.test(c.name));
      if (hit !== undefined) return hit.hex;
    }
    return null;
  };
  const neutrals = colors.filter((c) => isNeutral(c.hex));
  const sortedNeutrals = [...neutrals].sort(
    (a, b) => luminance(a.hex) - luminance(b.hex),
  );
  const darkest = sortedNeutrals[0]?.hex ?? null;
  const lightest = sortedNeutrals[sortedNeutrals.length - 1]?.hex ?? null;

  const surfaceDark =
    byName([
      /^--(?:surface|bg|background)-dark$/u,
      /^--(?:ink|dark)$/u,
      /dark-(?:surface|bg)/u,
    ]) ?? darkest;
  const surfaceLight =
    byName([
      /^--(?:surface|bg|background)-light$/u,
      /^--(?:paper|light)$/u,
      /^--(?:surface|bg|background)$/u,
    ]) ?? lightest;
  const textOnDark =
    byName([/^--text-on-dark$/u, /^--(?:fg|foreground|text)-(?:inverse|on-dark)$/u]) ??
    lightest;
  const textOnLight =
    byName([/^--text-on-light$/u, /^--(?:fg|foreground|text)$/u]) ?? darkest;

  const accents: string[] = [];
  const push = (hex: string): void => {
    if (!accents.includes(hex)) accents.push(hex);
  };
  for (const c of colors) {
    if (/^--(?:accent|primary|brand)(?:-\d+)?$/u.test(c.name)) push(c.hex);
  }
  for (const c of colors) {
    if (!isNeutral(c.hex)) push(c.hex);
  }
  return {
    surfaceDark,
    surfaceLight,
    textOnDark,
    textOnLight,
    accents: accents.slice(0, 6),
  };
}

function readColors(tokens: CssTokens, warnings: string[]): DsColor[] {
  const props = new Map(tokens.properties.map((p) => [p.name, p.value]));
  const out: DsColor[] = [];
  for (const p of tokens.properties) {
    const resolved = resolveVar(p.value, props);
    if (resolved === null) {
      if (p.value.startsWith("var(")) warnings.push(`${p.name}: broken alias ${p.value}`);
      continue;
    }
    const hex = normalizeColor(resolved.value);
    if (hex === null) continue;
    out.push({ name: p.name, hex, aliasOf: resolved.chain[0] ?? null });
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Tipografía
 * ------------------------------------------------------------------------ */

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${String(n)}`;
  taken.add(id);
  return id;
}

function readTypography(
  tokens: CssTokens,
  fontFiles: ReadonlySet<string>,
  warnings: string[],
): { families: DsFontFamily[]; roles: DsTypeRole[] } {
  const props = new Map(tokens.properties.map((p) => [p.name, p.value]));
  const draft = new Map<
    string,
    {
      name: string;
      origin: DsFontFamily["origin"];
      faces: DsFontFace[];
      weights: Set<number>;
      stack: string[];
    }
  >();

  for (const face of tokens.fontFaces) {
    const key = face.family.toLowerCase();
    const entry = draft.get(key) ?? {
      name: face.family,
      origin: "file" as const,
      faces: [],
      weights: new Set<number>(),
      stack: [],
    };
    if (face.file === null || !fontFiles.has(face.file)) {
      warnings.push(
        `${face.family} ${String(face.weight)}${face.style === "italic" ? " italic" : ""}: font file ${
          face.file ?? "(outside the zip)"
        } is missing`,
      );
    } else if (
      !entry.faces.some((f) => f.weight === face.weight && f.style === face.style)
    ) {
      entry.faces.push({ weight: face.weight, style: face.style, file: face.file });
      entry.weights.add(face.weight);
    }
    draft.set(key, entry);
  }
  for (const g of tokens.googleFamilies) {
    const key = g.name.toLowerCase();
    if (draft.has(key)) continue;
    draft.set(key, {
      name: g.name,
      origin: "google",
      faces: [],
      weights: new Set(g.weights),
      stack: [],
    });
  }

  const roles: DsTypeRole[] = [];
  for (const p of tokens.properties) {
    const m = /^--font-([a-z0-9-]+)$/u.exec(p.name);
    if (m === null) continue;
    const resolved = resolveVar(p.value, props);
    if (resolved === null) continue;
    const stack = parseFontStack(resolved.value);
    if (stack.length === 0 || normalizeColor(resolved.value) !== null) continue;
    for (const name of stack) {
      if (isGenericFamily(name)) continue;
      const key = name.toLowerCase();
      const existing = draft.get(key);
      if (existing === undefined) {
        draft.set(key, {
          name,
          origin: "stack",
          faces: [],
          weights: new Set(),
          stack: [...stack],
        });
      } else if (existing.stack.length === 0) {
        existing.stack.push(...stack);
      }
    }
    roles.push({ role: m[1] ?? "", stack, familyId: null });
  }

  const taken = new Set<string>();
  const families: DsFontFamily[] = [];
  for (const d of draft.values()) {
    const category = fontCategory(d.name, d.stack);
    const registered = registeredFamilyNamed(d.name) !== null;
    const license: DsFontFamily["license"] =
      d.origin === "google" || registered
        ? "open"
        : d.origin === "file"
          ? "needs_confirmation"
          : "system";
    families.push({
      name: d.name,
      id: uniqueId(fontFamilyId(d.name), taken),
      origin: d.origin === "file" && d.faces.length === 0 ? "stack" : d.origin,
      category,
      license,
      licenseConfirmed: false,
      faces: d.faces.sort(
        (a, b) => a.weight - b.weight || a.style.localeCompare(b.style),
      ),
      weights: [...d.weights].sort((a, b) => a - b),
      fallback: fallbackFamilyFor(d.name, category),
    });
  }

  const idByName = new Map(families.map((f) => [f.name.toLowerCase(), f.id]));
  return {
    families,
    roles: roles.map((r) => ({
      ...r,
      familyId:
        r.stack
          .filter((s) => !isGenericFamily(s))
          .map((s) => idByName.get(s.toLowerCase()))
          .find((id) => id !== undefined) ?? null,
    })),
  };
}

function readSpacing(tokens: CssTokens): DsSpacing[] {
  const props = new Map(tokens.properties.map((p) => [p.name, p.value]));
  const out: DsSpacing[] = [];
  for (const p of tokens.properties) {
    if (!/^--(?:space|spacing|gap|margin|canvas|logo|radius|size)-?/u.test(p.name))
      continue;
    const resolved = resolveVar(p.value, props);
    if (resolved === null) continue;
    const px = parseLength(resolved.value);
    if (px === null) continue;
    out.push({ name: p.name, px });
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------------ */

/** La clase de un asset por su ruta. `null` = no es un asset de marca. */
export function classifyAsset(
  path: string,
  kind: DesignSystemFileKind,
): DsAssetKind | null {
  if (kind === "font") return "font";
  if (kind === "text") return null;
  const segments = lower(path).split("/");
  const file = segments[segments.length - 1] ?? "";
  if (segments.some((s) => s === "logo" || s === "logos") || /logo/u.test(file)) {
    return "logo";
  }
  if (
    kind === "svg" ||
    segments.some((s) => /^(?:motifs?|patterns?|icons?|shapes?|textures?)$/u.test(s))
  ) {
    return "motif";
  }
  return "imagery";
}

/** Prioridad para quedarse con una copia de un duplicado: `assets/` gana a `uploads/`. */
function pathRank(path: string): number {
  const top = lower(path).split("/")[0] ?? "";
  if (top === "assets") return 0;
  if (top === "uploads") return 2;
  return 1;
}

function readAssets(
  entries: readonly DesignSystemEntry[],
  warnings: string[],
): DsAsset[] {
  const candidates = entries
    .filter((e) => e.kind !== "text")
    .sort((a, b) => pathRank(a.path) - pathRank(b.path) || a.path.localeCompare(b.path));
  const seen = new Set<string>();
  const out: DsAsset[] = [];
  for (const e of candidates) {
    if (seen.has(e.sha256)) continue;
    const kind = classifyAsset(e.path, e.kind);
    if (kind === null) continue;
    if (e.kind === "svg") {
      const check = svgIsSafe(e.text ?? "");
      if (!check.ok) {
        warnings.push(`${e.path}: skipped SVG (${check.reason ?? "unsafe"})`);
        continue;
      }
    }
    seen.add(e.sha256);
    out.push({ path: e.path, kind, bytes: e.bytes, sha256: e.sha256 });
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Entrada
 * ------------------------------------------------------------------------ */

export function parseDesignSystem(entries: readonly DesignSystemEntry[]): ParseOutcome {
  const warnings: string[] = [];
  const skill = findRootFile(entries, "SKILL.md");
  const readme = findRootFile(entries, "readme.md");
  const manifest = findRootFile(entries, "_ds_manifest.json");

  const cssFiles = entries
    .filter((e) => e.kind === "text" && e.path.toLowerCase().endsWith(".css"))
    .sort((a, b) => a.path.localeCompare(b.path));
  const css = mergeCssTokens(cssFiles.map((f) => parseCssTokens(f.text ?? "", f.path)));

  const fontFiles = new Set(entries.filter((e) => e.kind === "font").map((e) => e.path));
  const colors = readColors(css, warnings);
  const { families, roles } = readTypography(css, fontFiles, warnings);
  const tokens: DesignSystemTokens = {
    colors,
    semantic: semanticColors(colors),
    families,
    roles,
    spacing: readSpacing(css),
  };

  const readmeText = readme?.text ?? null;
  if (colors.length === 0 && families.length === 0 && readmeText === null) {
    return {
      ok: false,
      code: "empty_design_system",
      detail: "no color or font tokens and no readme",
    };
  }

  const fm = frontmatter(skill?.text ?? "");
  const { namespace, cards } = readManifest(manifest?.text);
  const rules: DsRule[] = cards
    .filter((c) => c.subtitle !== null)
    .slice(0, MAX_RULES)
    .map((c) => ({
      source: "manifest" as const,
      group: c.group,
      name: c.name,
      text: (c.subtitle ?? "").slice(0, MAX_RULE_CHARS),
    }));

  const name =
    (readmeText === null ? null : readmeTitle(readmeText)) ??
    fm.get("name") ??
    namespace ??
    "Design system";

  return {
    ok: true,
    ds: {
      name: name.slice(0, 120),
      description: fm.get("description")?.slice(0, 1_000) ?? null,
      tokens,
      assets: readAssets(entries, warnings),
      rules,
      tagline: readmeText === null ? null : extractTagline(readmeText),
      readme: readmeText === null ? null : readmeText.slice(0, README_MAX_CHARS),
      warnings: warnings.slice(0, 50),
    },
  };
}

/** Los archivos de fuente que un design system usa (para subirlos al storage). */
export function referencedFontFiles(tokens: DesignSystemTokens): string[] {
  return [...new Set(tokens.families.flatMap((f) => f.faces.map((x) => x.file)))];
}
