/**
 * La marca en los reels — sprint 9 (U), `PU-S9-014`.
 *
 * Del design system activo (M) a lo que el plan idea→spec necesita para que un
 * reel **salga con la marca**: colores del tema, familias de texto (la de la
 * marca si la licencia está tildada, si no el reemplazo OFL que ya decidió
 * `resolveRoleFont`), el logo claro u oscuro según la luminancia del fondo y un
 * motivo decorativo opcional.
 *
 * Sin design system, {@link REEL_DEFAULT_LOOK} reproduce **exactamente** lo que
 * el plan hacía antes de este archivo (Anton/Montserrat/Poppins, blanco con
 * contorno negro, caja amarilla): un reel de una marca sin design system no
 * cambia.
 *
 * Todo es puro: la luminancia de las imágenes (logo, fondo) la mide quien
 * llama (el render tiene `sharp`) y llega acá como número.
 */
import {
  BODY_ROLES,
  TITLE_ROLES,
  resolveRoleFont,
  type ResolvedDsFont,
} from "../design-system/fonts.js";
import type { StoredDesignFontFile } from "../design-system/document.js";
import type { DesignSystemTokens } from "../design-system/types.js";
import type {
  ReelBrandFamily,
  ReelBrandFont,
  ReelFont,
  ReelFontFamily,
  ReelRect,
  ReelTheme,
} from "./types.js";

/** Las 12 familias del render (`FR-051`) con sus pesos: el contrato los exige. */
export const REEL_REGISTERED_FONT_WEIGHTS: Readonly<
  Record<ReelFontFamily, readonly number[]>
> = {
  tiktok: [300, 400, 500, 600, 700],
  snapchat: [300, 400, 500, 600, 700],
  montserrat: [300, 400, 500, 600, 700],
  poppins: [300, 400, 500, 600, 700],
  inter: [300, 400, 500, 600, 700],
  oswald: [300, 400, 500, 600, 700],
  playfair: [400, 500, 600, 700],
  caveat: [400, 500, 600, 700],
  anton: [400],
  bebas: [400],
  bangers: [400],
  pacifico: [400],
};

export function isReelFontFamily(value: string): value is ReelFontFamily {
  return Object.prototype.hasOwnProperty.call(REEL_REGISTERED_FONT_WEIGHTS, value);
}

/** Tope de caras de marca por spec (el mismo que el render: `MAX_BRAND_FONTS`). */
export const REEL_MAX_BRAND_FONTS = 16;

export interface ReelTextColors {
  /** Texto suelto sobre la imagen (gancho, remate sin caja). */
  readonly text: string;
  readonly stroke: { readonly width: number; readonly color: string };
  /** La caja de los beats (`list-beats`) y el texto encima. */
  readonly beatBox: string;
  readonly beatText: string;
  /** La caja del remate y su texto. */
  readonly punchBox: { readonly color: string; readonly opacity: number };
  readonly punchText: string;
  /** Subtítulos: texto, palabra activa, contorno. */
  readonly caption: string;
  readonly captionActive: string;
  readonly captionStroke: { readonly width: number; readonly color: string };
  /** Etiquetas de `before-after`. */
  readonly beforeLabel: string;
  readonly afterLabel: string;
  readonly beforeLabelText: string;
  readonly afterLabelText: string;
}

/** Esquina del logo. Cerrado: cada una se miró contra las zonas de las plantillas. */
export const REEL_LOGO_CORNERS = ["top-left", "top-right"] as const;
export type ReelLogoCorner = (typeof REEL_LOGO_CORNERS)[number];

export interface ReelLogoLayer {
  readonly url: string;
  readonly corner: ReelLogoCorner;
  /** Caja del logo (`contain`): el archivo decide su proporción adentro. */
  readonly rect: ReelRect;
}

export interface ReelBrandLook {
  readonly source: "design_system" | "default";
  readonly theme: ReelTheme;
  readonly fonts: {
    readonly hook: ReelFont;
    readonly body: ReelFont;
    readonly punch: ReelFont;
    readonly caption: ReelFont;
    readonly label: ReelFont;
  };
  /** Las caras de marca que usan las fuentes de arriba (vacío = ninguna). */
  readonly brandFonts: readonly ReelBrandFont[];
  readonly colors: ReelTextColors;
  readonly logo: ReelLogoLayer | null;
  /** Motivo decorativo del design system (PNG), si la plantilla lo usa. */
  readonly motif: { readonly url: string } | null;
  /** Qué familia se reemplazó y por qué, para el plan («Rotis → Inter»). */
  readonly notes: readonly string[];
}

const BLACK_STROKE = { width: 3, color: "#000000" } as const;
const NO_STROKE = { width: 0, color: "#000000" } as const;

/** Lo que el plan hacía antes del design system. No cambiar sin mirar un render. */
export const REEL_DEFAULT_LOOK: ReelBrandLook = {
  source: "default",
  theme: { background: "#111111", primary: "#FFFFFF", accent: "#FFE14D", text: "#FFFFFF" },
  fonts: {
    hook: { family: "anton", weight: 400, size: 44 },
    body: { family: "montserrat", weight: 700, size: 28 },
    punch: { family: "poppins", weight: 600, size: 30 },
    caption: { family: "montserrat", weight: 700, size: 28 },
    label: { family: "anton", weight: 400, size: 30 },
  },
  brandFonts: [],
  colors: {
    text: "#FFFFFF",
    stroke: BLACK_STROKE,
    beatBox: "#FFE14D",
    beatText: "#111111",
    punchBox: { color: "#000000", opacity: 0.6 },
    punchText: "#FFFFFF",
    caption: "#FFFFFF",
    captionActive: "#FFE14D",
    captionStroke: BLACK_STROKE,
    beforeLabel: "#E5484D",
    afterLabel: "#30A46C",
    beforeLabelText: "#FFFFFF",
    afterLabelText: "#FFFFFF",
  },
  logo: null,
  motif: null,
  notes: [],
};

// ── color ───────────────────────────────────────────────────────────────────

function channel(hex: string, i: number): number {
  const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa WCAG de un `#RRGGBB` (0 negro, 1 blanco). */
export function hexLuminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return 0;
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

/** Contraste WCAG entre dos luminancias. */
export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** De dos colores, el que más contrasta sobre `background`. */
export function mostContrasting(background: string, a: string, b: string): string {
  const bg = hexLuminance(background);
  return contrastRatio(bg, hexLuminance(a)) >= contrastRatio(bg, hexLuminance(b))
    ? a
    : b;
}

/**
 * Por debajo de esto un fondo es «oscuro» (luminancia relativa). 0,18 es el
 * punto donde el blanco y el negro contrastan igual contra el fondo
 * (√(1,05 × 0,05) − 0,05 ≈ 0,179): de ahí para abajo gana el blanco.
 */
export const REEL_DARK_BACKGROUND_MAX = 0.179;

export interface ReelLogoCandidate {
  readonly url: string;
  /**
   * Luminancia media de los píxeles visibles del archivo (0–1), medida por el
   * render. `null` = no se pudo medir.
   */
  readonly luminance: number | null;
}

/**
 * El logo que se lee sobre un fondo de luminancia `backgroundLuminance`: el
 * más claro sobre fondo oscuro, el más oscuro sobre fondo claro. Los que no se
 * pudieron medir van últimos (si ninguno se midió, el primero).
 */
export function pickLogoForBackground(
  logos: readonly ReelLogoCandidate[],
  backgroundLuminance: number,
): ReelLogoCandidate | null {
  if (logos.length === 0) return null;
  const measured = logos.filter(
    (l): l is ReelLogoCandidate & { luminance: number } => l.luminance !== null,
  );
  if (measured.length === 0) return logos[0] ?? null;
  const dark = backgroundLuminance <= REEL_DARK_BACKGROUND_MAX;
  return measured.reduce((best, l) =>
    dark ? (l.luminance > best.luminance ? l : best) : l.luminance < best.luminance ? l : best,
  );
}

/**
 * Dónde va el logo. Arriba a la derecha, debajo de la barra de Instagram
 * (~7 % del alto) y fuera de la columna de botones (que empieza a media
 * altura): la zona que ninguna plantilla ocupa. 18 % del ancho ≈ 195 px.
 */
export const REEL_LOGO_RECT: Readonly<Record<ReelLogoCorner, ReelRect>> = {
  "top-right": { x: 86, y: 8.5, width: 18, height: 5 },
  "top-left": { x: 14, y: 8.5, width: 18, height: 5 },
};

// ── fuentes ─────────────────────────────────────────────────────────────────

function nearestWeight(allowed: readonly number[], weight: number): number {
  let best = allowed[0] ?? 400;
  for (const w of allowed) if (Math.abs(w - weight) < Math.abs(best - weight)) best = w;
  return best;
}

interface FontPick {
  readonly font: ReelFont;
  readonly face: ReelBrandFont | null;
  readonly note: string | null;
}

/**
 * Una fuente resuelta por el design system → la fuente de una capa. La de
 * marca necesita su archivo: si no está subido, cae al reemplazo de la familia
 * (y se anota), igual que si la licencia no estuviera tildada.
 */
function fontFrom(
  resolved: ResolvedDsFont,
  size: number,
  tokens: DesignSystemTokens,
  files: readonly StoredDesignFontFile[],
  fallback: ReelFont,
): FontPick {
  if (resolved.kind === "brand") {
    const faces = files.filter(
      (f) => f.familyId === resolved.familyId && f.style === resolved.style,
    );
    const file =
      faces.find((f) => f.weight === resolved.weight) ??
      faces.reduce<StoredDesignFontFile | undefined>(
        (best, f) =>
          best === undefined ||
          Math.abs(f.weight - resolved.weight) < Math.abs(best.weight - resolved.weight)
            ? f
            : best,
        undefined,
      );
    if (file !== undefined) {
      const family: ReelBrandFamily = `brand:${resolved.familyId}`;
      return {
        font: { family, weight: file.weight, size },
        face: {
          id: resolved.familyId,
          weight: file.weight,
          style: file.style,
          url: file.url,
        },
        note: null,
      };
    }
    const fam = tokens.families.find((f) => f.id === resolved.familyId);
    const alt = fam?.fallback ?? fallback.family;
    const family = isReelFontFamily(alt) ? alt : "inter";
    return {
      font: {
        family,
        weight: nearestWeight(REEL_REGISTERED_FONT_WEIGHTS[family], resolved.weight),
        size,
      },
      face: null,
      note: `${resolved.name}: no font file uploaded, using ${family}`,
    };
  }
  const family = isReelFontFamily(resolved.family) ? resolved.family : fallback.family;
  const weight = nearestWeight(
    REEL_REGISTERED_FONT_WEIGHTS[family as ReelFontFamily] ?? [400],
    resolved.weight,
  );
  const note =
    resolved.mappedFrom === null
      ? null
      : resolved.reason === "license_not_confirmed"
        ? `${resolved.mappedFrom}: license not confirmed, using ${family}`
        : `${resolved.mappedFrom}: not available to the renderer, using ${family}`;
  return { font: { family, weight, size }, face: null, note };
}

export interface ReelLookInput {
  readonly tokens: DesignSystemTokens;
  /** `brand_design_systems.fonts`: los archivos subidos, con su URL canónica. */
  readonly fontFiles: readonly StoredDesignFontFile[];
  /** Los logos del design system, con su luminancia medida. */
  readonly logos: readonly ReelLogoCandidate[];
  /** Motivos ya pasados a PNG (el primero se usa). */
  readonly motifs: readonly { readonly url: string }[];
  /**
   * Luminancia del fondo que va detrás del logo (la imagen elegida, medida por
   * el render). `null` = el color de superficie del tema.
   */
  readonly backgroundLuminance?: number | null;
  /** `false` apaga la capa del logo (preferencia de la marca). Default: `true`. */
  readonly logoEnabled?: boolean;
}

/**
 * El look de un reel desde el design system activo. Los tamaños son los de
 * siempre (el plan mide los tiempos de lectura con ellos); cambian familia,
 * peso y colores.
 */
export function reelLookFromDesignSystem(input: ReelLookInput): ReelBrandLook {
  const d = REEL_DEFAULT_LOOK;
  const { tokens, fontFiles } = input;
  const s = tokens.semantic;
  const surfaceDark = s.surfaceDark ?? d.theme.background;
  const textOnDark = s.textOnDark ?? s.surfaceLight ?? d.colors.text;
  const surfaceLight = s.surfaceLight ?? s.textOnDark ?? d.theme.primary;
  const textOnLight = s.textOnLight ?? s.surfaceDark ?? d.colors.beatText;
  const accent = s.accents[0] ?? d.theme.accent;
  const accent2 = s.accents[1] ?? accent;

  const picks = {
    hook: fontFrom(resolveRoleFont(tokens, TITLE_ROLES, 700), d.fonts.hook.size, tokens, fontFiles, d.fonts.hook),
    body: fontFrom(resolveRoleFont(tokens, BODY_ROLES, 700), d.fonts.body.size, tokens, fontFiles, d.fonts.body),
    punch: fontFrom(resolveRoleFont(tokens, TITLE_ROLES, 600), d.fonts.punch.size, tokens, fontFiles, d.fonts.punch),
    caption: fontFrom(resolveRoleFont(tokens, BODY_ROLES, 700), d.fonts.caption.size, tokens, fontFiles, d.fonts.caption),
    label: fontFrom(resolveRoleFont(tokens, BODY_ROLES, 800), d.fonts.label.size, tokens, fontFiles, d.fonts.label),
  };
  const brandFonts: ReelBrandFont[] = [];
  const notes: string[] = [];
  for (const p of Object.values(picks)) {
    if (p.note !== null && !notes.includes(p.note)) notes.push(p.note);
    const face = p.face;
    if (
      face !== null &&
      brandFonts.length < REEL_MAX_BRAND_FONTS &&
      !brandFonts.some(
        (f) => f.id === face.id && f.weight === face.weight && f.style === face.style,
      )
    ) {
      brandFonts.push(face);
    }
  }

  const bgLum = input.backgroundLuminance ?? hexLuminance(surfaceDark);
  const logo =
    input.logoEnabled === false ? null : pickLogoForBackground(input.logos, bgLum);
  // Texto suelto: el claro de la marca con un contorno fino de su superficie
  // oscura (se lee sobre fotos sin sombras, que varios design systems prohíben).
  const strokeColor = surfaceDark;
  return {
    source: "design_system",
    theme: { background: surfaceDark, primary: surfaceLight, accent, text: textOnDark },
    fonts: {
      hook: picks.hook.font,
      body: picks.body.font,
      punch: picks.punch.font,
      caption: picks.caption.font,
      label: picks.label.font,
    },
    brandFonts,
    colors: {
      text: textOnDark,
      stroke: { width: 2, color: strokeColor },
      beatBox: accent,
      beatText: mostContrasting(accent, textOnLight, textOnDark),
      punchBox: { color: surfaceDark, opacity: 0.72 },
      punchText: textOnDark,
      caption: textOnDark,
      captionActive: accent,
      captionStroke: { width: 3, color: strokeColor },
      beforeLabel: surfaceLight,
      afterLabel: accent2,
      beforeLabelText: mostContrasting(surfaceLight, textOnLight, textOnDark),
      afterLabelText: mostContrasting(accent2, textOnLight, textOnDark),
    },
    logo:
      logo === null
        ? null
        : { url: logo.url, corner: "top-right", rect: REEL_LOGO_RECT["top-right"] },
    motif: input.motifs[0] ?? null,
    notes,
  };
}

export { NO_STROKE as REEL_NO_STROKE };
