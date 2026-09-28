/**
 * Assets nuevos para un design system — `PU-S9-004`.
 *
 * «Generate backgrounds/patterns» desde la pantalla de marca. Dos fuentes:
 *
 *  - **Local**, sin proveedor: el generador de fondos del render
 *    (`services/render/src/render/brandBackground.ts`, el mismo del kit de
 *    fondos) con la paleta del design system;
 *  - **Modelo `image`** del registro, si hay uno configurado: con un prompt
 *    derivado de la paleta y las reglas de composición.
 *
 * Lo generado queda **pendiente de aprobación** (`pending_assets` de la fila)
 * y recién al aprobar entra al Media Bank con el tag `design-system`. Acá está
 * lo que no es IO: las semillas, el prompt y la forma del pendiente.
 */
import { designSystemPalette } from "./blitz.js";
import { isNeutral } from "./parse.js";
import type { DesignSystemStyle, DesignSystemTokens } from "./types.js";

/** Semilla de la pieza `index` de un pedido: determinista, distinta por pedido. */
export function generateSeed(requestId: string, index: number): string {
  return `ds:${requestId.slice(0, 8)}:${String(index)}`;
}

/** Relación de aspecto de la pieza `index`: alterna feed (4:5) y reel (9:16), como el kit. */
export function generateAspect(index: number): "4:5" | "9:16" {
  return index % 2 === 0 ? "4:5" : "9:16";
}

/** Un nombre legible de un `#hex`, para el prompt (los modelos entienden mejor palabras). */
export function colorWord(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2 / 255;
  if (max - min < 24) {
    if (light < 0.12) return "near-black";
    if (light > 0.9) return "off-white";
    return light < 0.5 ? "dark gray" : "light gray";
  }
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  const hue = (h * 60 + 360) % 360;
  const names: readonly [number, string][] = [
    [15, "red"],
    [45, "orange"],
    [70, "yellow"],
    [160, "green"],
    [200, "cyan"],
    [255, "blue"],
    [290, "purple"],
    [335, "magenta"],
    [360, "red"],
  ];
  const name = names.find(([limit]) => hue < limit)?.[1] ?? "red";
  return `${light > 0.75 ? "pale " : light < 0.25 ? "deep " : ""}${name}`;
}

/** Topes del prompt de imagen: los modelos cortan prompts largos sin avisar. */
export const IMAGE_PROMPT_MAX_CHARS = 900;

/**
 * El prompt para el modelo `image`: un fondo abstracto (sin texto, sin logos,
 * sin personas: el texto y el logo los pone el render encima) con la paleta y
 * las reglas de composición del design system.
 */
export function designSystemImagePrompt(
  tokens: DesignSystemTokens,
  style: DesignSystemStyle | null,
  index: number,
): string {
  const s = tokens.semantic;
  const base = s.surfaceDark ?? s.surfaceLight;
  const accents = s.accents.slice(0, 3).map(colorWord);
  const rules = (style?.compositionRules ?? []).slice(0, 4).join(" ");
  const variants = [
    "a soft abstract background texture",
    "an abstract pattern with generous negative space",
    "a subtle grainy gradient field",
    "an abstract photographic backdrop, out of focus",
  ];
  const parts = [
    `${variants[index % variants.length] ?? variants[0]} for a vertical social media post`,
    base === null ? "" : `mostly ${colorWord(base)}`,
    accents.length === 0 ? "" : `with small accents of ${accents.join(", ")}`,
    rules === "" ? "" : `Style notes: ${rules}`,
    "No text, no letters, no logos, no people, no watermark.",
  ];
  return parts
    .filter((p) => p !== "")
    .join(". ")
    .replace(/\s+/gu, " ")
    .slice(0, IMAGE_PROMPT_MAX_CHARS);
}

/**
 * La paleta de la pieza `index` de un pedido. Alterna dos lecturas, para que
 * el dueño tenga variedad que aprobar:
 *
 *  - par: la paleta del kit (`designSystemPalette`), vistosa;
 *  - impar: **contenida** — superficie oscura, un neutro y un solo acento
 *    (rota por pedido). Es la que respeta sistemas como FOCUS, que usan los
 *    acentos «con moderación, nunca como campos planos grandes» (mirado: con
 *    la paleta entera el degradé queda dominado por magenta y azul).
 *
 * `null` si el design system no trae colores suficientes.
 */
export function designSystemGeneratePalette(
  tokens: DesignSystemTokens,
  index: number,
): readonly string[] | null {
  const full = designSystemPalette(tokens);
  if (index % 2 === 0 || full === null) return full;
  const s = tokens.semantic;
  const base = s.surfaceDark ?? s.surfaceLight;
  const neutral = tokens.colors
    .map((c) => c.hex)
    .find(
      (h) => h !== base && isNeutral(h) && h !== s.surfaceLight && h !== s.textOnDark,
    );
  const accent =
    s.accents.length === 0 ? null : s.accents[Math.floor(index / 2) % s.accents.length];
  const out = [base, neutral ?? null, accent ?? null].filter(
    (x): x is string => x !== null && x !== undefined,
  );
  return out.length >= 2 ? out : full;
}
