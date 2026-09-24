/**
 * Las 12 familias de FR-051 en el navegador · `PU-EDIT-004`.
 *
 * El nombre de cada familia es el mismo que resuelve el render
 * (`services/render/src/domain/fonts.ts`, `pangoFamily`): así la letra del
 * preview es literalmente la del video. Las diez con licencia OFL se cargan de
 * Google Fonts por nombre, que es de donde las baja también `fonts:fetch`.
 *
 * `tiktok` y `snapchat` son fuentes de marca **sin archivo distribuible**
 * (`licence: "unresolved"` en el registro del render): el render las dibuja
 * con su reserva, y el preview hace lo mismo con la del adaptador (`inter`,
 * `DEFAULT_MAPPING` de `render-wire.ts`). El inspector lo avisa.
 */
import { FONT_WEIGHTS, fontFamilySchema, type FontFamily } from "@fastgram/contracts";

export interface EditorFontSpec {
  readonly key: FontFamily;
  /** Lo que ve el usuario en el selector. */
  readonly label: string;
  /** Familia de Google Fonts; `null` = sin archivo libre, se usa la reserva. */
  readonly googleFamily: string | null;
  readonly weights: readonly number[];
}

/** La reserva del render cuando la familia no tiene archivo. */
export const FALLBACK_FAMILY = "Inter";

const GOOGLE: Readonly<Record<FontFamily, string | null>> = {
  tiktok: null,
  snapchat: null,
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

const LABEL: Readonly<Record<FontFamily, string>> = {
  tiktok: "TikTok",
  snapchat: "Snapchat",
  montserrat: "Montserrat",
  poppins: "Poppins",
  inter: "Inter",
  oswald: "Oswald",
  playfair: "Playfair",
  caveat: "Caveat",
  anton: "Anton",
  bebas: "Bebas",
  bangers: "Bangers",
  pacifico: "Pacifico",
};

export const EDITOR_FONTS: readonly EditorFontSpec[] = fontFamilySchema.options.map(
  (key) => ({
    key,
    label: LABEL[key],
    googleFamily: GOOGLE[key],
    weights: FONT_WEIGHTS[key],
  }),
);

export function fontSpec(family: FontFamily): EditorFontSpec {
  return {
    key: family,
    label: LABEL[family],
    googleFamily: GOOGLE[family],
    weights: FONT_WEIGHTS[family],
  };
}

/** `font-family` CSS de una familia, con la reserva detrás. */
export function cssFontFamily(family: FontFamily): string {
  const name = GOOGLE[family] ?? FALLBACK_FAMILY;
  return `"${name}", "${FALLBACK_FAMILY}", sans-serif`;
}

/**
 * URL de Google Fonts (CSS2) para un conjunto de familias con sus pesos.
 * `null` si no hay nada que pedir. Ordenada y sin repetidos: la misma pieza
 * pide siempre la misma URL, y el navegador la cachea.
 */
export function googleFontsUrl(families: readonly FontFamily[]): string | null {
  const unique = [...new Set(families)]
    .map((f) => ({ name: GOOGLE[f] ?? FALLBACK_FAMILY, weights: FONT_WEIGHTS[f] }))
    .reduce<Map<string, Set<number>>>((acc, { name, weights }) => {
      const set = acc.get(name) ?? new Set<number>();
      for (const w of weights) set.add(w);
      acc.set(name, set);
      return acc;
    }, new Map());
  if (unique.size === 0) return null;
  const params = [...unique.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, weights]) => {
      const ws = [...weights].sort((a, b) => a - b);
      const family = name.replace(/ /g, "+");
      // Una familia de un solo peso (400) no acepta el eje `wght` en todas
      // las fuentes de Google: se pide sin eje.
      return ws.length === 1 && ws[0] === 400
        ? `family=${family}`
        : `family=${family}:wght@${ws.join(";")}`;
    });
  return `https://fonts.googleapis.com/css2?${params.join("&")}&display=swap`;
}

/** El peso más cercano que la familia acepta (al cambiar de familia). */
export function closestWeight(family: FontFamily, weight: number): number {
  const weights = FONT_WEIGHTS[family];
  let best = weights[0] ?? 400;
  for (const w of weights) {
    if (Math.abs(w - weight) < Math.abs(best - weight)) best = w;
  }
  return best;
}
