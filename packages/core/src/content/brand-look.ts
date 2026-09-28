/**
 * La marca en las piezas clásicas — sprint 9 (S), `PU-S9-003`.
 *
 * Una pieza nueva (Blitz, piloto automático, campañas, Studio, formatos) de
 * una marca con design system tiene que salir **con la marca**: la familia de
 * los títulos y del cuerpo, y —si la marca lo pidió— el logo en una esquina.
 * Los colores ya viajan: el estilo de caption del design system llega al
 * `build_plan` (`withDesignSystemStyle`) y de ahí al payload.
 *
 * ## Dónde se aplica, y por qué ahí
 *
 * En el **primer build** de la pieza (`apps/worker/src/content/build-handler`),
 * y el payload estampado se **persiste**. Los payloads se arman en cinco
 * lugares (`POST /blitz`, piloto, campañas, Studio, formatos) y todos terminan
 * en ese build: es el único punto común. Persistirlo es lo que hace que el
 * editor (que deriva las cajas del payload) y los rebuilds vean la misma
 * familia que salió en el video; si sólo se aplicara al renderizar, el editor
 * mostraría Inter sobre un video en Rotis.
 *
 * Sólo se estampa lo que falta: un texto que ya dice su `fontFamily` (un
 * `POST /content` que la eligió) no se toca, y un payload que ya tiene `logo`
 * tampoco.
 *
 * ## Qué pasa si después cambia la licencia o el design system
 *
 * Al renderizar ({@link planBrandFonts}), una familia `brand:<id>` que ya no
 * existe en el design system activo, o cuya licencia se destildó, se
 * **reemplaza** por su plan B registrado (o `inter`) en vez de fallar: un
 * rebuild no puede romperse porque el dueño destildó una casilla. La regla de
 * licencia se cumple igual: sin licencia, la fuente de marca no se manda.
 *
 * Funciones puras: `core` no conoce la base ni el storage.
 */
import { designSystemTextDefaults } from "../design-system/blitz.js";
import { familyUsable, nearestRegisteredWeight } from "../design-system/fonts.js";
import type { DesignSystemTokens, DsFontFamily } from "../design-system/types.js";
import { DomainError } from "../errors.js";
import {
  BRAND_FAMILY_PREFIX,
  FONT_WEIGHTS,
  brandFamilyIdOf,
  type ContentTextBox,
} from "./text-boxes.js";

/* ------------------------------------------------------------------------ *
 * Tipos estructurales (core no importa contracts)
 * ------------------------------------------------------------------------ */

export type LogoCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type LogoSize = "small" | "medium" | "large";

/** La capa de logo de una pieza (`buildLogoSchema` del contrato). */
export interface BuildLogoLayer {
  readonly corner: LogoCorner;
  readonly size: LogoSize;
  readonly opacity: number;
}

interface BrandableText {
  readonly content: string;
  readonly fontWeight?: number | undefined;
  readonly fontFamily?: string | undefined;
}

/** Lo mínimo de un payload de `FR-070` que este archivo toca. El resto viaja por spread. */
export type BrandablePayload =
  | {
      readonly num_images: number;
      readonly images: readonly { readonly texts: readonly BrandableText[] }[];
      readonly logo?: BuildLogoLayer | undefined;
    }
  | {
      readonly text: BrandableText;
      readonly logo?: BuildLogoLayer | undefined;
    };

/* ------------------------------------------------------------------------ *
 * Familias por defecto
 * ------------------------------------------------------------------------ */

/** Una familia para las cajas: una de las 12 (`inter`) o de la marca (`brand:<id>`). */
export interface TextFamilyChoice {
  readonly family: string;
  /** El peso del rol en el design system. */
  readonly weight: number;
  /** Los pesos que existen de verdad: las caras de la marca o la tabla de `FR-051`. */
  readonly weights: readonly number[];
}

export interface BrandTextFamilies {
  /** Títulos, hooks y el primer slide. */
  readonly title: TextFamilyChoice;
  /** El resto de los slides. */
  readonly body: TextFamilyChoice;
}

function faceWeights(family: DsFontFamily | undefined): number[] {
  if (family === undefined) return [];
  const normal = family.faces.filter((f) => f.style === "normal");
  const pool = normal.length > 0 ? normal : family.faces;
  return [...new Set(pool.map((f) => f.weight))].sort((a, b) => a - b);
}

/**
 * Las familias de las cajas nuevas, desde el design system
 * (`designSystemTextDefaults` de M: display para títulos, body para el resto,
 * con la regla de licencia ya aplicada — sin licencia sale el reemplazo OFL).
 */
export function brandTextFamilies(tokens: DesignSystemTokens): BrandTextFamilies {
  const defaults = designSystemTextDefaults(tokens);
  const choice = (resolved: typeof defaults.title): TextFamilyChoice => {
    if (resolved.kind === "brand") {
      const family = tokens.families.find((f) => f.id === resolved.familyId);
      const weights = faceWeights(family);
      return {
        family: `${BRAND_FAMILY_PREFIX}${resolved.familyId}`,
        weight: resolved.weight,
        weights: weights.length > 0 ? weights : [resolved.weight],
      };
    }
    return {
      family: resolved.family,
      weight: resolved.weight,
      weights: FONT_WEIGHTS[resolved.family] ?? [400],
    };
  };
  return { title: choice(defaults.title), body: choice(defaults.body) };
}

/** El peso de `weights` más cercano a `wanted` (empate → el más liviano). */
export function nearestWeight(weights: readonly number[], wanted: number): number {
  let best = weights[0] ?? wanted;
  for (const w of weights) {
    if (Math.abs(w - wanted) < Math.abs(best - wanted)) best = w;
  }
  return best;
}

/* ------------------------------------------------------------------------ *
 * El logo por marca
 * ------------------------------------------------------------------------ */

/**
 * El logo que lleva una pieza nueva: el de la preferencia de la marca, si
 * está prendida **y** el design system trae algún logo. Sin logo disponible
 * no se estampa nada: una capa que no se puede dibujar sólo confunde al
 * editor.
 */
export function brandDefaultLogo(
  tokens: DesignSystemTokens,
  logosAvailable: boolean,
): BuildLogoLayer | null {
  const layer = tokens.logoLayer;
  if (layer === undefined || !layer.enabled || !logosAvailable) return null;
  return { corner: layer.corner, size: layer.size, opacity: layer.opacity };
}

/* ------------------------------------------------------------------------ *
 * Estampar
 * ------------------------------------------------------------------------ */

export interface BrandLook {
  readonly families: BrandTextFamilies | null;
  readonly logo: BuildLogoLayer | null;
}

function stampText<T extends BrandableText>(text: T, choice: TextFamilyChoice): T {
  if (text.fontFamily !== undefined) return text;
  return {
    ...text,
    fontFamily: choice.family,
    // El peso del payload (el del estilo de caption) manda; si no hay, el del
    // rol. Siempre uno que exista en la familia.
    fontWeight: nearestWeight(choice.weights, text.fontWeight ?? choice.weight),
  };
}

/**
 * El payload con la marca: familia en los textos que no la tienen (título en
 * los formatos de un texto y en el primer slide; cuerpo en el resto) y el logo
 * si falta. `changed` dice si hay que persistirlo.
 */
export function stampBrandLook<P extends BrandablePayload>(
  payload: P,
  look: BrandLook,
): {
  readonly payload: P & { readonly logo?: BuildLogoLayer | undefined };
  readonly changed: boolean;
} {
  let changed = false;
  let next: P = payload;
  if (look.families !== null) {
    const { title, body } = look.families;
    if ("num_images" in payload) {
      const images = payload.images.map((slide, index) => ({
        ...slide,
        texts: slide.texts.map((t) => {
          const stamped = stampText(t, index === 0 ? title : body);
          if (stamped !== t) changed = true;
          return stamped;
        }),
      }));
      // Mismo `as` que `applyTextBoxesToBuildPayload`: reemplazar `images` por
      // uno de la misma forma devuelve `P`; el worker revalida con el contrato.
      next = { ...payload, images } as P;
    } else {
      const stamped = stampText(payload.text, title);
      if (stamped !== payload.text) {
        changed = true;
        next = { ...payload, text: stamped } as P;
      }
    }
  }
  if (look.logo !== null && next.logo === undefined) {
    changed = true;
    next = { ...next, logo: look.logo };
  }
  return { payload: changed ? next : payload, changed };
}

/* ------------------------------------------------------------------------ *
 * Al renderizar: qué fuentes de marca se mandan y cuáles se reemplazan
 * ------------------------------------------------------------------------ */

/** Un archivo de fuente subido (`brand_design_systems.fonts`), lo que hace falta de él. */
export interface BrandFontFileRef {
  readonly familyId: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  /** URL canónica del storage (`fonts/{companyId}/…`). */
  readonly url: string;
}

/** Una cara que viaja al render (`brandFonts` del request). */
export interface BrandFontFace {
  readonly id: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly url: string;
}

/** Tope del render (`MAX_BRAND_FONTS`). */
export const MAX_BRAND_FONT_FACES = 16;

export interface BrandFontPlan {
  readonly faces: readonly BrandFontFace[];
  /**
   * `brand:<id>` → la familia registrada que la reemplaza en este render
   * (licencia destildada, familia que ya no está, sin archivos). El peso se
   * acerca con {@link substituteWeight}.
   */
  readonly substitutes: Readonly<Record<string, string>>;
}

/**
 * Para las familias `brand:<id>` que usa un job: las caras a mandar (sólo de
 * familias usables: licencia tildada o libre, con archivos) y los reemplazos
 * del resto. Sin design system, todas se reemplazan por `inter`.
 *
 * Con más de {@link MAX_BRAND_FONT_FACES} caras se priorizan las normales:
 * una itálica que falta se dibuja con la normal más cercana; una normal que
 * falta no tiene reemplazo.
 */
export function planBrandFonts(
  families: readonly string[],
  tokens: DesignSystemTokens | null,
  files: readonly BrandFontFileRef[],
): BrandFontPlan {
  const faces: BrandFontFace[] = [];
  const substitutes: Record<string, string> = {};
  const ids = [
    ...new Set(families.map(brandFamilyIdOf).filter((id): id is string => id !== null)),
  ];
  for (const id of ids) {
    const family = tokens?.families.find((f) => f.id === id);
    const own = files.filter((f) => f.familyId === id);
    if (family === undefined || !familyUsable(family) || own.length === 0) {
      substitutes[`${BRAND_FAMILY_PREFIX}${id}`] = family?.fallback ?? "inter";
      continue;
    }
    for (const f of own) faces.push({ id, weight: f.weight, style: f.style, url: f.url });
  }
  if (faces.length <= MAX_BRAND_FONT_FACES) return { faces, substitutes };
  const normal = faces.filter((f) => f.style === "normal");
  const italic = faces.filter((f) => f.style === "italic");
  return {
    faces: [...normal, ...italic].slice(0, MAX_BRAND_FONT_FACES),
    substitutes,
  };
}

/** El peso para la familia registrada que reemplaza a una de marca. */
export function substituteWeight(family: string, weight: number): number {
  return nearestRegisteredWeight(family, weight);
}

/* ------------------------------------------------------------------------ *
 * Validación al guardar
 * ------------------------------------------------------------------------ */

/**
 * Las familias de marca de estas cajas que **no** se pueden usar con el design
 * system activo: no existen, o su licencia no está tildada, o no tienen
 * archivos. Vacío = todas bien. Sin design system (`tokens === null`),
 * cualquier `brand:` es inválida.
 */
export function unavailableBrandFamilies(
  boxes: readonly { readonly font: { readonly family: string } }[],
  tokens: DesignSystemTokens | null,
): string[] {
  const bad = new Set<string>();
  for (const box of boxes) {
    const id = brandFamilyIdOf(box.font.family);
    if (id === null) continue;
    const family = tokens?.families.find((f) => f.id === id);
    if (family === undefined || !familyUsable(family)) bad.add(box.font.family);
  }
  return [...bad];
}

/** Código estable (va en `details.reason` del `400`). */
export const BRAND_FONT_UNAVAILABLE = "brand_font_unavailable";

/** Lanza `out_of_range` con el código estable si alguna familia de marca no sirve. */
export function assertBrandFamiliesAvailable(
  boxes: readonly ContentTextBox[],
  tokens: DesignSystemTokens | null,
): void {
  const bad = unavailableBrandFamilies(boxes, tokens);
  if (bad.length === 0) return;
  throw new DomainError(
    "out_of_range",
    "This brand font isn't available: it's not in the active design system or its license isn't confirmed.",
    { reason: BRAND_FONT_UNAVAILABLE, families: bad },
  );
}

/* ------------------------------------------------------------------------ *
 * El logo de una pieza editada (`studioState.logo`)
 * ------------------------------------------------------------------------ */

const CORNERS: readonly LogoCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];
const SIZES: readonly LogoSize[] = ["small", "medium", "large"];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Una capa de logo con forma, o `null`. */
export function readBuildLogo(raw: unknown): BuildLogoLayer | null {
  if (!isObj(raw)) return null;
  const { corner, size, opacity } = raw;
  if (
    typeof corner !== "string" ||
    !(CORNERS as readonly string[]).includes(corner) ||
    typeof size !== "string" ||
    !(SIZES as readonly string[]).includes(size) ||
    typeof opacity !== "number" ||
    !Number.isFinite(opacity) ||
    opacity < 0.1 ||
    opacity > 1
  ) {
    return null;
  }
  return { corner: corner as LogoCorner, size: size as LogoSize, opacity };
}

/**
 * Lo que el editor decidió sobre el logo, guardado en `studioState.logo`
 * (como los swaps de media: el payload original no se toca). `set: false` =
 * el editor no lo tocó y manda el payload.
 */
export type LogoOverride =
  { readonly set: false } | { readonly set: true; readonly logo: BuildLogoLayer | null };

export function readLogoOverride(studioState: unknown): LogoOverride {
  if (!isObj(studioState) || !("logo" in studioState)) return { set: false };
  const raw = studioState["logo"];
  if (raw === null) return { set: true, logo: null };
  const logo = readBuildLogo(raw);
  // Una forma rota se trata como «no tocado»: el payload sabe qué había.
  return logo === null ? { set: false } : { set: true, logo };
}

/** `studioState` con la decisión del editor (conserva el resto de las claves). */
export function withLogoOverride(
  studioState: unknown,
  logo: BuildLogoLayer | null,
): Record<string, unknown> {
  return { ...(isObj(studioState) ? studioState : {}), logo };
}

/** La capa de logo vigente de una pieza: la del editor si la tocó, si no la del payload. */
export function effectiveLogo(
  payloadLogo: unknown,
  studioState: unknown,
): BuildLogoLayer | null {
  const override = readLogoOverride(studioState);
  if (override.set) return override.logo;
  return readBuildLogo(payloadLogo);
}
