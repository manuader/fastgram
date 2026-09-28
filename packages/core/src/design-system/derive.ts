/**
 * Un design system sin zip — `PU-S9-002`.
 *
 * «Derive from brand analysis»: con lo que la marca ya tiene arma un design
 * system mínimo (`source = derived`) que el dueño después edita en la
 * pantalla (paleta y fuentes). Lo que entra:
 *
 *  - **Paleta**: la misma de siempre del kit de fondos (`resolveBrandPalette`:
 *    colores `#hex` del perfil o paleta curada por id de marca), así un
 *    derivado no cambia los fondos que la marca ya venía viendo.
 *  - **Tipografía**: dos roles con familias registradas (libres): `display` →
 *    Montserrat, `body` → Inter. Son las del render por defecto; el dueño las
 *    cambia.
 *  - **Assets**: el logo y las imágenes que la marca ya importó al Media Bank
 *    (ids de `media`, no se copian archivos).
 *  - **Voz**: el `toneOfVoice` del perfil, si hay, como voz del resumen.
 *
 * Puro. El worker/API lee las filas y llama.
 */
import { resolveBrandPalette } from "../brand-kit/brand-kit.js";
import { fontFamilyId, REGISTERED_FONT_NAMES } from "./fonts.js";
import { semanticColors } from "./parse.js";
import type {
  DesignSystemStyle,
  DesignSystemTokens,
  DsAsset,
  DsColor,
  DsFontFamily,
} from "./types.js";

export interface DeriveInput {
  readonly companyId: string;
  readonly brandName: string;
  readonly profileTexts: readonly (string | null | undefined)[];
  readonly toneOfVoice: string | null;
  /** Media de la marca que sirve de asset: logo e imágenes ya importadas. */
  readonly media: readonly {
    readonly mediaId: string;
    readonly kind: "logo" | "imagery";
    readonly bytes: number;
  }[];
}

export interface DerivedDesignSystem {
  readonly name: string;
  readonly tokens: DesignSystemTokens;
  readonly style: DesignSystemStyle;
  readonly assets: readonly DsAsset[];
  readonly paletteSource: "design_system" | "profile" | "default";
}

function registeredFamily(key: string, weights: readonly number[]): DsFontFamily {
  const name = REGISTERED_FONT_NAMES[key] ?? key;
  return {
    name,
    id: fontFamilyId(name),
    origin: "google",
    category: key === "montserrat" ? "display" : "sans",
    license: "open",
    licenseConfirmed: false,
    faces: [],
    weights,
    fallback: key,
  };
}

/** Nombres de los colores derivados: `--brand-1`, `--brand-2`, … */
export function derivedColors(palette: readonly string[]): DsColor[] {
  return palette.map((hex, i) => ({
    name: `--brand-${String(i + 1)}`,
    hex,
    aliasOf: null,
  }));
}

export function deriveDesignSystem(input: DeriveInput): DerivedDesignSystem {
  const { palette, source } = resolveBrandPalette({
    companyId: input.companyId,
    profileTexts: input.profileTexts,
  });
  const colors = derivedColors(palette);
  const display = registeredFamily("montserrat", [400, 500, 600, 700]);
  const body = registeredFamily("inter", [300, 400, 500, 600, 700]);
  const tokens: DesignSystemTokens = {
    colors,
    semantic: semanticColors(colors),
    families: [display, body],
    roles: [
      { role: "display", stack: [display.name, "sans-serif"], familyId: display.id },
      { role: "body", stack: [body.name, "sans-serif"], familyId: body.id },
    ],
    spacing: [],
  };
  const tone = input.toneOfVoice?.trim() ?? "";
  return {
    name: `${input.brandName.trim() === "" ? "Brand" : input.brandName.trim()} (derived)`.slice(
      0,
      120,
    ),
    tokens,
    style: {
      voice: tone.slice(0, 400),
      values: [],
      tagline: null,
      compositionRules: [],
      dos: [],
      donts: [],
      language: null,
      origin: "heuristic",
    },
    assets: input.media.map((m) => ({
      path: `media:${m.mediaId}`,
      kind: m.kind,
      bytes: m.bytes,
      sha256: "",
    })),
    paletteSource: source,
  };
}

/**
 * Una paleta editada por el dueño sobre un design system: reemplaza los
 * colores y recalcula los roles. Los `#hex` inválidos o repetidos se
 * descartan; hacen falta al menos dos.
 */
export function withEditedPalette(
  tokens: DesignSystemTokens,
  palette: readonly { readonly name?: string | undefined; readonly hex: string }[],
): DesignSystemTokens | null {
  // Un color sin nombre repetido es un duplicado; con nombre propio no (un
  // rol como `--surface-dark` comparte el hex de `--focus-ink` a propósito).
  const seenHex = new Set<string>();
  const seenName = new Set<string>();
  const colors: DsColor[] = [];
  palette.forEach((c, i) => {
    const hex = c.hex.trim().toUpperCase();
    if (!/^#[0-9A-F]{6}$/u.test(hex)) return;
    const named = c.name !== undefined && /^--[A-Za-z0-9_-]{1,60}$/u.test(c.name);
    if (!named && seenHex.has(hex)) return;
    const name = named ? (c.name as string) : `--brand-${String(i + 1)}`;
    if (seenName.has(name)) return;
    seenHex.add(hex);
    seenName.add(name);
    colors.push({ name, hex, aliasOf: null });
  });
  if (new Set(colors.map((c) => c.hex)).size < 2) return null;
  return { ...tokens, colors, semantic: semanticColors(colors) };
}
