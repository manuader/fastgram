/**
 * Fuentes de un design system: licencia, mapeo a una familia libre y qué
 * familia usa cada caja de texto — `PU-S9-001`, `PU-S9-003`.
 *
 * ## La regla de licencia (decisión del dueño, brief del sprint 9)
 *
 * Una familia **con archivos** que no es libre conocida (Rotis es de Monotype)
 * se usa **sólo** si el dueño tildó «tengo licencia para usar esta fuente». Si
 * no, la caja usa la familia OFL registrada más parecida y la pantalla lo
 * avisa. Los stand-ins de Google Fonts del `@import` son libres: si están
 * entre las 12 registradas en el render se usan tal cual; si no (Source Serif
 * 4, Archivo Black), se mapean — el render no baja fuentes de Google en cada
 * pieza, y bajarlas al importar es una decisión de distribución que este
 * sprint no toma.
 *
 * ## El mapeo (heurística simple, a propósito)
 *
 * Primero por nombre (una familia registrada con el mismo nombre), después por
 * categoría: serif → `playfair`, sans → `inter`, display → `montserrat` (peso
 * alto: un wordmark pesado geométrico se parece más a Montserrat Black que a
 * Anton, que es condensada), mono → `inter` (no hay mono registrada: se avisa),
 * script → `caveat`. La categoría sale de la pila CSS (`serif`, `monospace`,
 * `cursive`) y, si no, del nombre.
 */
import { FONT_WEIGHTS } from "../content/text-boxes.js";
import type {
  DesignSystemTokens,
  DsFontCategory,
  DsFontFamily,
  DsTypeRole,
} from "./types.js";

/** Las familias registradas en el render (`FR-051`) y el nombre con que se las conoce. */
export const REGISTERED_FONT_NAMES: Readonly<Record<string, string>> = {
  tiktok: "TikTok Sans",
  snapchat: "Inter",
  montserrat: "Montserrat",
  poppins: "Poppins",
  inter: "Inter",
  oswald: "Oswald",
  playfair: "Playfair Display",
  caveat: "Caveat",
  anton: "Anton",
  bebas: "Bebas Neue",
  bangers: "Bangers",
  pacifico: "Pacifico",
};

export const CATEGORY_FALLBACK: Readonly<Record<DsFontCategory, string>> = {
  serif: "playfair",
  sans: "inter",
  display: "montserrat",
  mono: "inter",
  script: "caveat",
};

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "-apple-system",
  "blinkmacsystemfont",
  "emoji",
  "math",
]);

export function isGenericFamily(name: string): boolean {
  return GENERIC_FAMILIES.has(name.trim().toLowerCase());
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/gu, "");

/** El id estable de una familia dentro de la marca: `Rotis Semi Sans` → `rotis-semi-sans`. */
export function fontFamilyId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return slug === "" ? "font" : slug;
}

/** La familia registrada con ese nombre (`Playfair Display` → `playfair`), o `null`. */
export function registeredFamilyNamed(name: string): string | null {
  const wanted = squash(name);
  if (wanted === "") return null;
  for (const [key, display] of Object.entries(REGISTERED_FONT_NAMES)) {
    // `snapchat` es un alias de Inter: el nombre «Inter» es de `inter`.
    if (key === "snapchat") continue;
    if (squash(display) === wanted || key === wanted) return key;
  }
  return null;
}

/** Categoría por la pila (genéricos) y, si no alcanza, por el nombre. */
export function fontCategory(
  name: string,
  stack: readonly string[] = [],
): DsFontCategory {
  const generics = stack.map((s) => s.trim().toLowerCase());
  const n = name.toLowerCase();
  if (generics.includes("monospace") || /mono|code|courier/u.test(n)) return "mono";
  if (generics.includes("cursive") || /script|hand|brush|caveat|pacifico/u.test(n)) {
    return "script";
  }
  if (/black|display|impact|poster|condensed|bebas|anton|bangers|heavy/u.test(n)) {
    return "display";
  }
  if (/sans/u.test(n)) return "sans";
  if (/serif|garamond|times|georgia|playfair|baskerville|didot|bodoni/u.test(n)) {
    return "serif";
  }
  // La pila decide cuando el nombre no dice nada ("Rotis", "Aktiv").
  const firstGeneric = generics.find((g) => GENERIC_FAMILIES.has(g));
  if (firstGeneric === "serif" || firstGeneric === "ui-serif") return "serif";
  return "sans";
}

/** El peso permitido más cercano de una familia registrada (empate → el más liviano). */
export function nearestRegisteredWeight(family: string, weight: number): number {
  const allowed = FONT_WEIGHTS[family] ?? [400];
  let best = allowed[0] ?? 400;
  for (const w of allowed) {
    if (Math.abs(w - weight) < Math.abs(best - weight)) best = w;
  }
  return best;
}

/** El plan B de una familia: la registrada por nombre o por categoría. */
export function fallbackFamilyFor(name: string, category: DsFontCategory): string {
  return registeredFamilyNamed(name) ?? CATEGORY_FALLBACK[category];
}

/** ¿La familia se puede usar tal cual (con sus propios archivos)? */
export function familyUsable(f: DsFontFamily): boolean {
  if (f.origin !== "file" || f.faces.length === 0) return false;
  return f.license === "open" || f.licenseConfirmed;
}

/**
 * La fuente que usa una caja de texto:
 *  - `brand`: la familia de la marca, con sus archivos (licencia tildada o libre);
 *  - `registered`: una de las 12 del render, con el motivo si es un reemplazo.
 */
export type ResolvedDsFont =
  | {
      readonly kind: "brand";
      readonly familyId: string;
      readonly name: string;
      readonly weight: number;
      readonly style: "normal" | "italic";
    }
  | {
      readonly kind: "registered";
      readonly family: string;
      readonly weight: number;
      /** La familia de la marca que se reemplazó, o `null` si es la misma. */
      readonly mappedFrom: string | null;
      readonly reason:
        | "same_family"
        | "license_not_confirmed"
        | "not_registered"
        | "system_font"
        | "no_role";
    };

function nearestFace(
  f: DsFontFamily,
  weight: number,
): { weight: number; style: "normal" | "italic" } | null {
  const normal = f.faces.filter((x) => x.style === "normal");
  const pool = normal.length > 0 ? normal : f.faces;
  let best = pool[0];
  for (const face of pool) {
    if (
      best === undefined ||
      Math.abs(face.weight - weight) < Math.abs(best.weight - weight)
    ) {
      best = face;
    }
  }
  return best === undefined ? null : { weight: best.weight, style: best.style };
}

/** El rol pedido o, si no está, el primero que exista de la lista de respaldo. */
export function findRole(
  tokens: DesignSystemTokens,
  roles: readonly string[],
): DsTypeRole | null {
  for (const r of roles) {
    const found = tokens.roles.find((x) => x.role === r);
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * Qué fuente usa un rol (`display` para títulos y hooks, `body` para el resto).
 * `weight` es el peso deseado; se toma el más cercano que exista.
 */
export function resolveRoleFont(
  tokens: DesignSystemTokens,
  roles: readonly string[],
  weight: number,
): ResolvedDsFont {
  const role = findRole(tokens, roles);
  if (role === null) {
    return {
      kind: "registered",
      family: "inter",
      weight: nearestRegisteredWeight("inter", weight),
      mappedFrom: null,
      reason: "no_role",
    };
  }
  const byName = new Map(tokens.families.map((f) => [f.name.toLowerCase(), f]));
  // Se recorre la pila en orden: la primera familia **usable** gana, como
  // haría el navegador con las que tiene instaladas.
  for (const entry of role.stack) {
    if (isGenericFamily(entry)) continue;
    const family = byName.get(entry.toLowerCase());
    if (family !== undefined && familyUsable(family)) {
      const face = nearestFace(family, weight);
      if (face !== null) {
        return {
          kind: "brand",
          familyId: family.id,
          name: family.name,
          weight: face.weight,
          style: face.style,
        };
      }
    }
    const registered = registeredFamilyNamed(entry);
    if (registered !== null) {
      return {
        kind: "registered",
        family: registered,
        weight: nearestRegisteredWeight(registered, weight),
        mappedFrom: null,
        reason: "same_family",
      };
    }
  }
  // Nada de la pila se puede usar: el plan B de la **primera** familia, que es
  // la que el diseño eligió.
  const head = role.stack.find((s) => !isGenericFamily(s)) ?? "";
  const family = byName.get(head.toLowerCase());
  const category = family?.category ?? fontCategory(head, role.stack);
  const fallback = family?.fallback ?? fallbackFamilyFor(head, category);
  const reason =
    family === undefined || family.origin === "stack"
      ? "system_font"
      : family.origin === "file" && !family.licenseConfirmed && family.license !== "open"
        ? "license_not_confirmed"
        : "not_registered";
  return {
    kind: "registered",
    family: fallback,
    weight: nearestRegisteredWeight(
      fallback,
      category === "display" ? Math.max(weight, 700) : weight,
    ),
    mappedFrom: head === "" ? null : head,
    reason,
  };
}

/** Roles que se prueban para títulos y hooks, y para el cuerpo. */
export const TITLE_ROLES = [
  "display",
  "heading",
  "headline",
  "title",
  "body",
  "sans",
] as const;
export const BODY_ROLES = ["body", "text", "sans", "base", "display"] as const;

/** Avisos legibles para la pantalla: qué familia se reemplaza y por qué. */
export function fontWarnings(tokens: DesignSystemTokens): string[] {
  const out: string[] = [];
  for (const f of tokens.families) {
    if (
      f.origin === "file" &&
      f.license === "needs_confirmation" &&
      !f.licenseConfirmed
    ) {
      out.push(
        `${f.name}: confirm you have a license to use it; until then it renders as ${
          REGISTERED_FONT_NAMES[f.fallback] ?? f.fallback
        }.`,
      );
    }
    if (f.origin === "google" && registeredFamilyNamed(f.name) === null) {
      out.push(
        `${f.name} (Google Fonts) is not installed in the renderer; it renders as ${
          REGISTERED_FONT_NAMES[f.fallback] ?? f.fallback
        }.`,
      );
    }
    if (f.category === "mono") {
      out.push(`${f.name}: no monospace family is registered; it renders as Inter.`);
    }
  }
  return out;
}
