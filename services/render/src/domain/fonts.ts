/**
 * `P2-RENDER-008` — Registro tipográfico. Las 12 familias y sus pesos salen
 * literalmente de `FR-051` (PRD §"Validation"):
 *
 *   tiktok, snapchat, montserrat, poppins, inter, oswald → 300–700 en pasos de 100
 *   playfair, caveat                                      → 400–700
 *   anton, bebas, bangers, pacifico                       → sólo 400
 *
 * No se agrega ninguna familia que el PRD no nombre.
 *
 * ── Cómo se cargan ────────────────────────────────────────────────────────────
 * Por NOMBRE, después de que `render/fontActivation.ts` activó el directorio al
 * arrancar, y verificadas contra una sonda centinela (`render/fontLoader.ts`).
 * Este comentario decía que se cargaban «por ARCHIVO absoluto (`fontfile`),
 * verificado con Georgia»: era falso (trampa 40 del HANDOFF) — Georgia es del
 * sistema y `fontfile` se ignora.
 */
import { z } from "zod";

export const FONT_FAMILIES = [
  "tiktok",
  "snapchat",
  "montserrat",
  "poppins",
  "inter",
  "oswald",
  "playfair",
  "caveat",
  "anton",
  "bebas",
  "bangers",
  "pacifico",
] as const;

export type FontFamily = (typeof FONT_FAMILIES)[number];

const W_300_700 = [300, 400, 500, 600, 700] as const;
const W_400_700 = [400, 500, 600, 700] as const;
const W_400 = [400] as const;

export interface FontFamilySpec {
  readonly key: FontFamily;
  readonly weights: readonly number[];
  /**
   * Nombre de familia que entiende Pango. Para las diez familias de Google
   * Fonts es el nombre canónico de la familia. `null` = el PRD nombra la
   * familia pero no existe un archivo distribuible conocido: el nombre tiene
   * que venir del manifiesto del directorio de fuentes (ver `FontManifest`).
   */
  readonly pangoFamily: string | null;
  /** Estado de licencia, para no distribuir lo que no se puede distribuir. */
  readonly licence: "ofl" | "unresolved";
}

export const FONT_REGISTRY: Readonly<Record<FontFamily, FontFamilySpec>> = {
  // TikTok Sans: TikTok la liberó bajo OFL 1.1 y está en Google Fonts
  // (verificado 2026-09-24: css2 devuelve ttf y google/fonts tiene
  // `ofl/tiktoksans/OFL.txt`). Hasta ese día esta familia figuraba sin resolver.
  tiktok: {
    key: "tiktok",
    weights: W_300_700,
    pangoFamily: "TikTok Sans",
    licence: "ofl",
  },
  // Snapchat no tiene fuente libre: el dueño eligió **Inter** como sustituto
  // (2026-09-24, pensado para Inter Bold). Se baja con los nombres
  // `snapchat-<peso>.ttf` para que el registro siga siendo 1 familia = 1 clave.
  snapchat: {
    key: "snapchat",
    weights: W_300_700,
    pangoFamily: "Inter",
    licence: "ofl",
  },

  montserrat: {
    key: "montserrat",
    weights: W_300_700,
    pangoFamily: "Montserrat",
    licence: "ofl",
  },
  poppins: { key: "poppins", weights: W_300_700, pangoFamily: "Poppins", licence: "ofl" },
  inter: { key: "inter", weights: W_300_700, pangoFamily: "Inter", licence: "ofl" },
  oswald: { key: "oswald", weights: W_300_700, pangoFamily: "Oswald", licence: "ofl" },

  playfair: {
    key: "playfair",
    weights: W_400_700,
    pangoFamily: "Playfair Display",
    licence: "ofl",
  },
  caveat: { key: "caveat", weights: W_400_700, pangoFamily: "Caveat", licence: "ofl" },

  anton: { key: "anton", weights: W_400, pangoFamily: "Anton", licence: "ofl" },
  bebas: { key: "bebas", weights: W_400, pangoFamily: "Bebas Neue", licence: "ofl" },
  bangers: { key: "bangers", weights: W_400, pangoFamily: "Bangers", licence: "ofl" },
  pacifico: { key: "pacifico", weights: W_400, pangoFamily: "Pacifico", licence: "ofl" },
};

/**
 * Versión del registro. Entra en la clave de cache del overlay: si cambian las
 * fuentes, los overlays cacheados dejan de ser válidos aunque el texto no haya
 * cambiado (`P2-RENDER-010`).
 *
 * `"2"` (2026-09-23): la descripción Pango pasó de `"Inter 700 42px"` —que
 * Pango lee como la familia «Inter 700» y cae a la reserva— a
 * `"Inter, Bold 42px"`, y la familia sale del archivo. Todo overlay cacheado
 * con la versión 1 se dibujó con la fuente de reserva.
 *
 * `"3"` (2026-09-24): `tiktok` pasa a TikTok Sans; antes caía a la reserva.
 * `"4"` (2026-09-24): `snapchat` pasa a Inter (sustituto elegido por el dueño).
 */
export const FONT_REGISTRY_VERSION = "4";

export function isFontFamily(value: string): value is FontFamily {
  return (FONT_FAMILIES as readonly string[]).includes(value);
}

export function allowedWeights(family: FontFamily): readonly number[] {
  return FONT_REGISTRY[family].weights;
}

export function isWeightAllowed(family: FontFamily, weight: number): boolean {
  return allowedWeights(family).includes(weight);
}

/** Nombre de archivo esperado dentro del directorio de fuentes. Convención del servicio. */
export function fontFileName(family: FontFamily, weight: number): string {
  return `${family}-${weight}.ttf`;
}

/** Todos los archivos que el directorio de fuentes debe contener para cubrir `FR-051`. */
export function requiredFontFiles(): readonly string[] {
  return FONT_FAMILIES.flatMap((family) =>
    FONT_REGISTRY[family].weights.map((weight) => fontFileName(family, weight)),
  );
}

/**
 * Manifiesto opcional `fonts.json` del directorio de fuentes. Sirve para dos
 * cosas: dar el nombre Pango de las familias de marca y permitir sobreescribir
 * el nombre de una familia sin tocar código.
 */
export interface FontManifest {
  readonly families?: Partial<Record<FontFamily, { readonly pangoFamily: string }>>;
}

export function resolvePangoFamily(
  family: FontFamily,
  manifest: FontManifest | null,
): string | null {
  return manifest?.families?.[family]?.pangoFamily ?? FONT_REGISTRY[family].pangoFamily;
}

/* ------------------------------------------------------------------------ *
 * Fuentes de marca — sprint 9 (M), `PU-S9-001/003`
 * ------------------------------------------------------------------------ */

/**
 * Una caja de texto pide una familia de marca con `family: "brand:<id>"`
 * (el id estable de la familia en el design system, `rotis-semi-sans`). Los
 * archivos llegan en el request de render (`brandFonts`), como URLs que la
 * política de media autoriza igual que una imagen (el grant del build tiene
 * que sumar el prefijo `fonts/{companyId}/`). El render los baja, lee el
 * nombre de familia **del archivo** (`fontNames.ts`) y dibuja esas cajas en
 * un **proceso hijo** que registra las fuentes antes de su primer texto
 * (`render/brandText.ts`): en el proceso principal ya no se puede, porque el
 * fontmap de CoreText se congela en el primer uso (medido de nuevo el
 * 2026-09-28: Rotis registrada después de un texto da la firma del
 * centinela, 551x39; antes, 495x38).
 *
 * La licencia la decide quien arma el request: el render dibuja lo que le
 * mandan. Una familia sin licencia confirmada nunca llega como `brand:` (la
 * resuelve `core/design-system/fonts.ts` a una de las 12 registradas).
 */
export const BRAND_FAMILY_PREFIX = "brand:";

export type BrandFamilyRef = `brand:${string}`;
export type FontFamilyField = FontFamily | BrandFamilyRef;

const BRAND_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isBrandFamilyRef(value: string): value is BrandFamilyRef {
  return (
    value.startsWith(BRAND_FAMILY_PREFIX) &&
    BRAND_ID_RE.test(value.slice(BRAND_FAMILY_PREFIX.length))
  );
}

export function brandFontIdOf(ref: BrandFamilyRef): string {
  return ref.slice(BRAND_FAMILY_PREFIX.length);
}

/** El campo `font.family` de una caja: una de las 12, o `brand:<id>`. */
export const fontFamilyFieldSchema = z.union([
  z.enum(FONT_FAMILIES),
  z
    .string()
    .refine(isBrandFamilyRef, "debe ser una familia registrada o brand:<id>")
    .transform((v) => v as BrandFamilyRef),
]);

/**
 * Peso permitido para el campo: el de la tabla para las 12; para una de marca,
 * cualquier centena 100–900 (qué cara existe lo decide `brandFonts`, y la
 * más cercana gana).
 */
export function isWeightAllowedForField(
  family: FontFamilyField,
  weight: number,
): boolean {
  if (isBrandFamilyRef(family)) {
    return (
      Number.isInteger(weight) && weight >= 100 && weight <= 900 && weight % 100 === 0
    );
  }
  return isWeightAllowed(family, weight);
}

/** Tope de caras de marca por request, y de bytes por archivo. */
export const MAX_BRAND_FONTS = 16;
export const BRAND_FONT_MAX_BYTES = 10 * 1024 * 1024;

export const brandFontRefSchema = z
  .object({
    id: z.string().regex(BRAND_ID_RE),
    weight: z.number().int().min(100).max(900),
    style: z.enum(["normal", "italic"]).default("normal"),
    url: z.string().url(),
  })
  .strict();

export type BrandFontRef = z.infer<typeof brandFontRefSchema>;

export const brandFontListSchema = z.array(brandFontRefSchema).max(MAX_BRAND_FONTS);

/**
 * La cara de marca que usa una caja: la del id con el peso más cercano
 * (normal antes que itálica; empate → la más liviana). `null` si el id no vino.
 */
export function pickBrandFace<T extends { id: string; weight: number; style: string }>(
  faces: readonly T[],
  id: string,
  weight: number,
): T | null {
  const own = faces.filter((f) => f.id === id);
  const normal = own.filter((f) => f.style === "normal");
  const pool = normal.length > 0 ? normal : own;
  let best: T | null = null;
  for (const f of pool) {
    if (
      best === null ||
      Math.abs(f.weight - weight) < Math.abs(best.weight - weight) ||
      (Math.abs(f.weight - weight) === Math.abs(best.weight - weight) &&
        f.weight < best.weight)
    ) {
      best = f;
    }
  }
  return best;
}
