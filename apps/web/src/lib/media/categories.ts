/**
 * Categorías del Media Bank por tipo · F-129 (PRD:601), FR-100 (PRD:1634).
 *
 * Las categorías son válidas **por tipo**: un `image` con `hook-video` es un
 * `400 bad_request` en `PATCH /media/:id`. Por eso los chips de cada asset
 * salen de acá y nunca de la lista completa de cinco.
 */
import {
  imageMediaCategorySchema,
  videoMediaCategorySchema,
  type MediaCategory,
  type MediaType,
} from "@fastgram/contracts";
import type { CopyKey } from "../i18n/t";

export const CATEGORIES_BY_TYPE: Readonly<Record<MediaType, readonly MediaCategory[]>> = {
  image: imageMediaCategorySchema.options,
  video: videoMediaCategorySchema.options,
};

/**
 * El nombre largo de cada categoría, para los chips del selector.
 *
 * No es el mismo copy que el badge de la tarjeta (`MEDIA_CATEGORY_COPY`): el
 * badge es literal del PRD y es corto a propósito (`bg`, `hook`) porque va
 * encima de una miniatura de 168 px. En un selector, `bg` no le dice a nadie
 * qué está eligiendo.
 */
export const MEDIA_CATEGORY_CHIP_COPY: Readonly<Record<MediaCategory, CopyKey>> = {
  "slideshow-image": "mediaUpload.category.slideshowImage",
  "green-screen-background": "mediaUpload.category.greenScreenBackground",
  "background-video": "mediaUpload.category.backgroundVideo",
  "hook-video": "mediaUpload.category.hookVideo",
  "green-screen-video": "mediaUpload.category.greenScreenVideo",
};

export interface VideoDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * La sugerencia por defecto al terminar una subida. **Decisión de
 * `PU-MEDIA-001`, no del PRD**: FR-100 dice que las categorías se ponen después
 * y que una lista vacía saca al asset de los pools de Blitz, pero no qué
 * proponer.
 *
 * · **imagen** → las dos de imagen. Una foto sirve igual de slide que de fondo
 *   para la pantalla verde, y dejarla fuera de un pool es la opción que el
 *   usuario no ve: el asset "no aparece" y no sabe por qué.
 * · **video vertical, o sin medidas** → `background-video`. Es el uso más
 *   común de un clip 9:16 propio, y cuando no se pudo medir (el navegador no
 *   decodifica un `.mov` HEVC, p. ej.) es la apuesta menos rara.
 * · **video horizontal** → `hook-video`. Un clip 16:9 de fondo en un reel
 *   vertical se recorta o queda con bandas; como clip corto de apertura, sobre
 *   la mitad de la pantalla, sí encaja.
 *
 * `green-screen-video` nunca se sugiere: decir que un clip tiene fondo verde
 * sin mirarlo es inventar, y si no lo tiene, el recorte del render lo arruina.
 */
export function suggestCategories(
  mediaType: MediaType,
  dimensions: VideoDimensions | null,
): readonly MediaCategory[] {
  if (mediaType === "image") return CATEGORIES_BY_TYPE.image;
  if (dimensions !== null && dimensions.width > dimensions.height) return ["hook-video"];
  return ["background-video"];
}

/** Alterna una categoría manteniendo el orden canónico del contrato. */
export function toggleCategory(
  mediaType: MediaType,
  current: readonly MediaCategory[],
  category: MediaCategory,
): readonly MediaCategory[] {
  const next = new Set(current);
  if (next.has(category)) next.delete(category);
  else next.add(category);
  return CATEGORIES_BY_TYPE[mediaType].filter((c) => next.has(c));
}
