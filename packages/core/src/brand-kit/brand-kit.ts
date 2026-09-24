/**
 * Kit de fondos de marca — `PU-MEDIA-002`.
 *
 * Una marca recién creada no tiene nada en el Media Bank, y sin media Blitz no
 * planifica (`plan-suggestion.ts`: «No content type in the mix has media
 * available in the Media Bank»). El kit son fondos generados **localmente**
 * por `services/render` —degradés, manchas suaves, grano; imágenes y loops de
 * video— con la paleta de la marca. Sin keys ni proveedores.
 *
 * Este archivo es la parte que no es IO: qué paleta, cuántas piezas, con qué
 * semilla cada una, en qué categoría caen, con qué clave se guardan y qué
 * viaja en la cola. El worker (`apps/worker/src/brand-kit`) hace el resto.
 *
 * ## Qué categoría llena qué formato
 *
 * Según `discovery/blitz-media.ts` (la tabla de `FR-100`):
 *
 *  · imágenes → `slideshow-image` **y** `green-screen-background`: habilitan
 *    `slideshow` y dan el fondo de un `green-screen`;
 *  · videos → `background-video`: habilita `wall-of-text` y es el clip de
 *    arriba de un `video-hook`.
 *
 * `green-screen` sigue necesitando un `green-screen-video` (el meme recortado)
 * y `video-hook` un `hook-video` (el demo del producto): el kit **no** los
 * inventa. Con el kit, una marca nueva pasa de cero formatos a dos.
 *
 * ## La paleta
 *
 * `company_profiles` no tiene columnas de color (medido: ni `DATA-004` ni la
 * EXTENSION las definen). Lo que sí puede tener es texto: la síntesis por LLM o
 * lo que el usuario escribió pueden mencionar `#1A2B3C`. Se usan esos colores
 * si hay al menos dos; si no, una paleta curada elegida **por el id de la
 * marca**, determinista: la misma marca recibe siempre la misma, y dos marcas
 * distintas casi nunca la misma.
 */

import { BLITZ_MEDIA_CATEGORIES } from "../discovery/blitz-media.js";

/** Lo que pide el plan: ocho imágenes y tres loops. */
export const DEFAULT_BRAND_KIT_IMAGES = 8;
export const DEFAULT_BRAND_KIT_VIDEOS = 3;
/** Topes de un pedido: acotan CPU del render y objetos en el bucket. */
export const MAX_BRAND_KIT_IMAGES = 20;
export const MAX_BRAND_KIT_VIDEOS = 6;
/** Duración de cada loop. El render acepta 6–10. */
export const BRAND_KIT_VIDEO_SECONDS = 8;

export const BRAND_KIT_MIN_COLORS = 2;
export const BRAND_KIT_MAX_COLORS = 5;

/**
 * La semilla del disparo automático (el refill sin media). Fija a propósito:
 * con la clave determinista del adaptador de pg-boss, **dispara una vez en la
 * vida de la marca** (trampa 39). Es lo que se quiere: si después de un kit el
 * refill sigue sin poder planificar —el mix del usuario sólo tiene
 * `green-screen`, por ejemplo—, un segundo kit idéntico no arreglaría nada.
 * Para otro juego de fondos está `POST /media/brand-kit` con otra semilla.
 */
export const AUTO_BRAND_KIT_SEED = "auto-1";

export const BRAND_KIT_IMAGE_CATEGORIES: readonly string[] = [
  BLITZ_MEDIA_CATEGORIES.slideshowImage,
  BLITZ_MEDIA_CATEGORIES.greenScreenBackground,
];
export const BRAND_KIT_VIDEO_CATEGORIES: readonly string[] = [
  BLITZ_MEDIA_CATEGORIES.backgroundVideo,
];

/**
 * Paletas curadas para cuando el perfil no trae colores. Oscuro + acento +
 * claro en casi todas: el degradé necesita contraste para no verse plano, y
 * el texto blanco con borde de los presets tiene que leerse encima.
 */
export const DEFAULT_BRAND_PALETTES: readonly (readonly string[])[] = [
  ["#1B1F3B", "#FF6B6B", "#FFD93D", "#6BCB77"],
  ["#0F172A", "#6366F1", "#EC4899", "#F9A8D4"],
  ["#052E2B", "#0F766E", "#5EEAD4", "#FDE68A"],
  ["#1C1917", "#EA580C", "#FDBA74", "#FEF3C7"],
  ["#172554", "#2563EB", "#38BDF8", "#E0F2FE"],
  ["#2E1065", "#7C3AED", "#F472B6", "#FDE047"],
  ["#14532D", "#65A30D", "#D9F99D", "#FEFCE8"],
  ["#3F0D12", "#A71D31", "#F1D6B8", "#D8A47F"],
  ["#0B132B", "#3A506B", "#5BC0BE", "#F5F3F4"],
  ["#22223B", "#4A4E69", "#C9ADA7", "#F2E9E4"],
  ["#001219", "#005F73", "#EE9B00", "#E9D8A6"],
  ["#231942", "#5E548E", "#9F86C0", "#E0B1CB"],
];

/**
 * FNV-1a de 32 bits. `core` no importa `node:crypto` (regla `core-no-npm`) y
 * acá no hace falta resistencia a colisiones: sólo repartir parejo y dar
 * siempre lo mismo para la misma entrada.
 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** La paleta curada de una marca: determinista por su id. */
export function defaultPaletteFor(companyId: string): readonly string[] {
  const palette =
    DEFAULT_BRAND_PALETTES[fnv1a(companyId) % DEFAULT_BRAND_PALETTES.length];
  // Inalcanzable: el módulo cae siempre dentro de la lista.
  if (palette === undefined) throw new Error("lista de paletas vacía");
  return palette;
}

const HEX_IN_TEXT = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/giu;

/**
 * Los colores `#RGB`/`#RRGGBB` que aparecen en los textos del perfil, en orden
 * de aparición, sin repetir, en mayúsculas y hasta
 * {@link BRAND_KIT_MAX_COLORS}. `null` si no hay al menos dos: con uno solo no
 * hay degradé, y mezclarlo con una paleta curada daría un kit que no es ni una
 * cosa ni la otra.
 */
export function paletteFromProfileText(
  texts: readonly (string | null | undefined)[],
): readonly string[] | null {
  const found: string[] = [];
  for (const text of texts) {
    if (text === null || text === undefined) continue;
    for (const match of text.matchAll(HEX_IN_TEXT)) {
      const raw = match[0].slice(1).toUpperCase();
      const full =
        raw.length === 3
          ? `#${raw
              .split("")
              .map((c) => c + c)
              .join("")}`
          : `#${raw}`;
      if (!found.includes(full)) found.push(full);
      if (found.length === BRAND_KIT_MAX_COLORS) return found;
    }
  }
  return found.length >= BRAND_KIT_MIN_COLORS ? found : null;
}

export interface ResolvedBrandPalette {
  readonly palette: readonly string[];
  /** De dónde salió, para el log y la explicación. */
  readonly source: "profile" | "default";
}

export function resolveBrandPalette(input: {
  readonly companyId: string;
  readonly profileTexts: readonly (string | null | undefined)[];
}): ResolvedBrandPalette {
  const fromProfile = paletteFromProfileText(input.profileTexts);
  if (fromProfile !== null) return { palette: fromProfile, source: "profile" };
  return { palette: defaultPaletteFor(input.companyId), source: "default" };
}

/* ------------------------------------------------------------------------ *
 * El job
 * ------------------------------------------------------------------------ */

/** Lo que viaja en la cola `brand-backgrounds`. */
export interface BrandBackgroundsJob {
  readonly companyId: string;
  /** 1–100 caracteres imprimibles. Decide los fondos: misma semilla, mismos bytes. */
  readonly seed: string;
  readonly images: number;
  readonly videos: number;
}

export const MAX_BRAND_KIT_SEED_LENGTH = 100;
const SEED_RE = /^[\x21-\x7E]{1,100}$/u;
/** La misma forma que exige `withCompany`. Ver `discovery/refill-job.ts`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isValidBrandKitSeed(seed: string): boolean {
  return SEED_RE.test(seed);
}

export type ParsedBrandBackgroundsJob =
  | { readonly ok: true; readonly payload: BrandBackgroundsJob }
  | { readonly ok: false; readonly reason: string };

const isCount = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

/**
 * Valida el payload que vuelve de la cola. Devuelve un resultado y no lanza,
 * por lo mismo que `parseDiscoveryRefillJob`: un payload roto no mejora
 * reintentando.
 */
export function parseBrandBackgroundsJob(raw: unknown): ParsedBrandBackgroundsJob {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "payload is not an object" };
  }
  const { companyId, seed, images, videos } = raw as Record<string, unknown>;
  if (typeof companyId !== "string" || !UUID_RE.test(companyId)) {
    return { ok: false, reason: "companyId is missing or not a UUID" };
  }
  if (typeof seed !== "string" || !isValidBrandKitSeed(seed)) {
    return { ok: false, reason: "seed is missing or not 1–100 printable ASCII chars" };
  }
  if (!isCount(images, MAX_BRAND_KIT_IMAGES)) {
    return {
      ok: false,
      reason: `images must be an integer 0–${String(MAX_BRAND_KIT_IMAGES)}`,
    };
  }
  if (!isCount(videos, MAX_BRAND_KIT_VIDEOS)) {
    return {
      ok: false,
      reason: `videos must be an integer 0–${String(MAX_BRAND_KIT_VIDEOS)}`,
    };
  }
  if (images + videos === 0) {
    return { ok: false, reason: "a brand kit with nothing to generate" };
  }
  return { ok: true, payload: { companyId, seed, images, videos } };
}

/**
 * La `singletonKey` del job: **marca + semilla + cantidades**.
 *
 * Con el id determinista del adaptador de pg-boss (trampa 10), una clave fija
 * dispara una sola vez en la vida (trampa 39) — y acá eso es lo correcto: la
 * misma semilla produce los mismos bytes, así que un segundo job idéntico sólo
 * repetiría trabajo. Las cantidades entran porque el puerto responde
 * `conflict` si la misma clave llega con otro payload.
 */
export function brandKitSingletonKey(job: BrandBackgroundsJob): string {
  return `brand-backgrounds:${job.companyId}:${job.seed}:${String(job.images)}x${String(job.videos)}`;
}

/* ------------------------------------------------------------------------ *
 * El plan de piezas
 * ------------------------------------------------------------------------ */

export type BrandKitItem =
  | {
      readonly kind: "image";
      readonly index: number;
      /** Semilla del fondo individual, derivada de la del kit. */
      readonly seed: string;
      readonly aspectRatio: "4:5" | "9:16";
      readonly storageKey: string;
      readonly filename: string;
      readonly categories: readonly string[];
    }
  | {
      readonly kind: "video";
      readonly index: number;
      readonly seed: string;
      readonly durationSeconds: number;
      readonly storageKey: string;
      readonly filename: string;
      readonly categories: readonly string[];
    };

/**
 * 16 hex derivados de la semilla: seguros para una clave de storage y un
 * nombre de archivo. Dos FNV con distinto prefijo y no uno: con 32 bits, dos
 * semillas de la misma marca que chocaran compartirían claves, y el handler
 * daría por hecho un kit que nunca generó.
 */
export function brandKitSeedTag(seed: string): string {
  const hex = (n: number): string => n.toString(16).padStart(8, "0");
  return `${hex(fnv1a(seed))}${hex(fnv1a(`kit|${seed}`))}`;
}

/**
 * Las piezas del kit, en orden. Puro.
 *
 * **La clave de storage es determinista** —`media/<marca>/brand-kit/<tag>/…`—
 * y eso es lo que hace idempotente al handler: una reentrega busca las filas
 * por esas claves y sólo genera las que faltan. El riesgo que la
 * normalización evita con claves únicas (que el perdedor de una carrera borre
 * el archivo del ganador) no aplica: acá nadie borra, y dos entregas que
 * escriben la misma clave escriben **los mismos bytes**.
 *
 * Las imágenes alternan 4:5 (feed) y 9:16 (story/reel): el build recorta al
 * canvas que toque, y un fondo abstracto se recorta sin perder nada.
 */
export function planBrandKit(job: BrandBackgroundsJob): readonly BrandKitItem[] {
  const tag = brandKitSeedTag(job.seed);
  const prefix = `media/${job.companyId}/brand-kit/${tag}`;
  const items: BrandKitItem[] = [];
  for (let i = 0; i < job.images; i += 1) {
    items.push({
      kind: "image",
      index: i,
      seed: `${job.seed}:image:${String(i)}`,
      aspectRatio: i % 2 === 0 ? "4:5" : "9:16",
      storageKey: `${prefix}/image-${String(i + 1)}.jpg`,
      filename: `brand-kit-${tag}-image-${String(i + 1)}.jpg`,
      categories: BRAND_KIT_IMAGE_CATEGORIES,
    });
  }
  for (let i = 0; i < job.videos; i += 1) {
    items.push({
      kind: "video",
      index: i,
      seed: `${job.seed}:video:${String(i)}`,
      durationSeconds: BRAND_KIT_VIDEO_SECONDS,
      storageKey: `${prefix}/video-${String(i + 1)}.mp4`,
      filename: `brand-kit-${tag}-video-${String(i + 1)}.mp4`,
      categories: BRAND_KIT_VIDEO_CATEGORIES,
    });
  }
  return items;
}
