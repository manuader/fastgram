/**
 * Cómo usa Blitz un design system — `PU-S9-003`.
 *
 *  - **Paleta del kit de fondos** (`brand-kit.ts`): con design system, manda
 *    el design system; sin él, lo de siempre (colores del perfil o paleta
 *    curada).
 *  - **Estilo de las cajas de texto** de las piezas nuevas: color del texto y
 *    del fondo de la caja desde los tokens semánticos (`text-on-dark`,
 *    `surface-dark`). La familia (display para títulos y hooks, body para el
 *    resto) se resuelve con `fonts.ts`.
 *
 * Por qué texto claro sobre caja oscura y no al revés: los fondos de Blitz son
 * fotos y videos (imagery del design system, memes, kit): una caja con la
 * superficie oscura de la marca se lee sobre cualquiera de ellos, y el texto
 * claro de la marca encima es el par que el propio design system define como
 * legible (`text-on-dark` sobre `surface-dark`).
 */
import { BRAND_KIT_MAX_COLORS, BRAND_KIT_MIN_COLORS } from "../brand-kit/brand-kit.js";
import type { CaptionStyle } from "../discovery/blitz-build.js";
import {
  BODY_ROLES,
  TITLE_ROLES,
  resolveRoleFont,
  type ResolvedDsFont,
} from "./fonts.js";
import type { DesignSystemTokens } from "./types.js";

/**
 * La paleta para el kit de fondos: superficie oscura, acentos, superficie
 * clara, en ese orden (el generador arma el degradé con el primero de base).
 * `null` si el design system no trae al menos dos colores.
 */
export function designSystemPalette(
  tokens: DesignSystemTokens,
): readonly string[] | null {
  const s = tokens.semantic;
  const out: string[] = [];
  const push = (hex: string | null): void => {
    if (hex !== null && !out.includes(hex) && out.length < BRAND_KIT_MAX_COLORS)
      out.push(hex);
  };
  push(s.surfaceDark);
  for (const a of s.accents) push(a);
  push(s.surfaceLight);
  // El resto de los tokens sólo si hace falta llegar al mínimo: un blanco puro
  // de texto no es un color de fondo de la marca.
  for (const c of tokens.colors) if (out.length < BRAND_KIT_MIN_COLORS) push(c.hex);
  return out.length >= BRAND_KIT_MIN_COLORS ? out : null;
}

/**
 * El estilo de caption de una pieza nueva, desde el design system. Sin
 * contorno cuando hay caja: el contorno es para texto suelto sobre la imagen,
 * y una caja opaca ya da el contraste.
 */
export function designSystemCaptionStyle(
  tokens: DesignSystemTokens,
): CaptionStyle | null {
  const s = tokens.semantic;
  const text = s.textOnDark ?? s.surfaceLight;
  if (text === null) return null;
  const box = s.surfaceDark;
  return box === null
    ? { color: text, fontWeight: 600, strokeWidth: 3, strokeColor: "#000000" }
    : { color: text, fontWeight: 600, strokeWidth: 0, backgroundColor: box };
}

export interface DesignSystemTextDefaults {
  /** Títulos, hooks y el primer slide. */
  readonly title: ResolvedDsFont;
  /** El resto de los textos. */
  readonly body: ResolvedDsFont;
  readonly style: CaptionStyle | null;
}

/** Los defaults de las cajas de texto de una pieza nueva. */
export function designSystemTextDefaults(
  tokens: DesignSystemTokens,
): DesignSystemTextDefaults {
  return {
    title: resolveRoleFont(tokens, TITLE_ROLES, 700),
    body: resolveRoleFont(tokens, BODY_ROLES, 400),
    style: designSystemCaptionStyle(tokens),
  };
}
