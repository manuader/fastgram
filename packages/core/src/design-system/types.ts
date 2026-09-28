/**
 * El design system de una marca, ya leído — `PU-S9-001…004`.
 *
 * Es lo que se guarda en `brand_design_systems.tokens` (jsonb) y lo que usan
 * Blitz (paleta del kit de fondos, estilo de las cajas de texto), la copy (voz
 * y reglas) y la pantalla de marca. Sale de dos lados:
 *
 *  - `zip`: un export de Claude Design (`parse.ts`);
 *  - `derived`: armado con lo que la marca ya tiene (`derive.ts`).
 *
 * Todo es JSON plano a propósito: viaja por la cola, la base y la API sin
 * transformaciones.
 */

export type DesignSystemSource = "zip" | "derived";

export interface DsColor {
  /** El nombre del token, con los guiones: `--focus-magenta`. */
  readonly name: string;
  /** `#RRGGBB`. */
  readonly hex: string;
  /** Si el token es un alias, el primer token de la cadena (`--focus-ink`). */
  readonly aliasOf: string | null;
}

/**
 * Los roles que usa el contenido. `null` = el design system no lo dice y no
 * se pudo deducir. Los acentos van en orden de aparición.
 */
export interface DsSemanticColors {
  readonly surfaceDark: string | null;
  readonly surfaceLight: string | null;
  readonly textOnDark: string | null;
  readonly textOnLight: string | null;
  readonly accents: readonly string[];
}

export interface DsFontFace {
  readonly weight: number;
  readonly style: "normal" | "italic";
  /** Ruta dentro del zip. Después del import, la clave en el storage. */
  readonly file: string;
}

/** Categoría tipográfica gruesa: decide el mapeo a una familia libre. */
export type DsFontCategory = "serif" | "sans" | "display" | "mono" | "script";

/**
 * Qué se sabe de la licencia de una familia:
 *  - `open`: Google Fonts (el export la trae por `@import`) o una familia OFL
 *    registrada en el render;
 *  - `needs_confirmation`: vino con archivos y no es libre conocida (Rotis es
 *    de Monotype). Se usa **sólo** si el dueño tilda que tiene licencia;
 *  - `system`: nombrada en una pila sin archivos (`Georgia`, `Arial`). No se
 *    distribuye: se mapea siempre.
 */
export type DsFontLicense = "open" | "needs_confirmation" | "system";

export interface DsFontFamily {
  /** El nombre como lo escribe el CSS: `Rotis Semi Sans`. */
  readonly name: string;
  /** Id estable dentro de la marca (`rotis-semi-sans`): lo usan las cajas de texto. */
  readonly id: string;
  readonly origin: "file" | "google" | "stack";
  readonly category: DsFontCategory;
  readonly license: DsFontLicense;
  /** El dueño tildó «tengo licencia para usar esta fuente». */
  readonly licenseConfirmed: boolean;
  readonly faces: readonly DsFontFace[];
  /** Los pesos que ofrece (de los archivos o del `@import`). */
  readonly weights: readonly number[];
  /**
   * La familia OFL registrada en el render que la reemplaza cuando no se
   * puede usar (una de las 12 de `FR-051`). Siempre presente: es el plan B.
   */
  readonly fallback: string;
}

/** Un rol tipográfico: `display`, `body`, `logo`, … (de `--font-<rol>`). */
export interface DsTypeRole {
  readonly role: string;
  readonly stack: readonly string[];
  /** El id de la familia del design system que encabeza la pila, si hay. */
  readonly familyId: string | null;
}

export interface DsSpacing {
  readonly name: string;
  readonly px: number;
}

export type DsAssetKind = "logo" | "imagery" | "motif" | "font";

export interface DsAsset {
  /** Ruta en el zip (o `media:<id>` en un derivado). */
  readonly path: string;
  readonly kind: DsAssetKind;
  readonly bytes: number;
  readonly sha256: string;
}

/** Una regla corta, tal como vino: la subtítulo de una tarjeta del manifest. */
export interface DsRule {
  readonly source: "manifest" | "readme";
  readonly group: string | null;
  readonly name: string | null;
  readonly text: string;
}

export interface DesignSystemTokens {
  readonly colors: readonly DsColor[];
  readonly semantic: DsSemanticColors;
  readonly families: readonly DsFontFamily[];
  readonly roles: readonly DsTypeRole[];
  readonly spacing: readonly DsSpacing[];
}

/**
 * El resumen de estilo: estructurado, no prosa única, para que la copy y el
 * decisor lo usen por partes. Lo arma el modelo `text` (`style.ts`) o, sin
 * modelo, la heurística sobre el readme.
 */
export interface DesignSystemStyle {
  /** Cómo habla la marca, en una o dos oraciones. */
  readonly voice: string;
  readonly values: readonly string[];
  readonly tagline: string | null;
  readonly compositionRules: readonly string[];
  readonly dos: readonly string[];
  readonly donts: readonly string[];
  /** BCP 47 del idioma de la voz, si el readme lo dice (`es-AR`). */
  readonly language: string | null;
  /** Quién lo escribió: el modelo, la heurística o el dueño. */
  readonly origin: "model" | "heuristic" | "owner";
}

export interface ParsedDesignSystem {
  readonly name: string;
  readonly description: string | null;
  readonly tokens: DesignSystemTokens;
  readonly assets: readonly DsAsset[];
  readonly rules: readonly DsRule[];
  readonly tagline: string | null;
  /** El readme recortado, para el resumen de estilo. `null` si no hay. */
  readonly readme: string | null;
  /** Lo que no se pudo usar y por qué (SVG inseguro, alias roto, …). */
  readonly warnings: readonly string[];
}
