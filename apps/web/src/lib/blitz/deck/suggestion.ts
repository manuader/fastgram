/**
 * El modelo de una tarjeta del deck · FR-050, F-053…F-057.
 *
 * ## El contrato que falta, y por qué este schema es local
 *
 * La API de hoy tiene **una sola** operación sobre la cola: `POST /blitz`, que
 * saca la sugerencia de turno y la construye. No hay forma de **ver** la cola
 * (ni tipo, ni texto, ni `aiExplanation`) ni de **descartar** una sugerencia
 * sin construirla. El deck necesita las dos cosas, así que este archivo fija la
 * forma que el deck espera de un `GET /blitz/queue` que todavía no existe
 * (reportado como hueco de backend en el handoff de `PU-BLITZ-001`).
 *
 * Es deliberadamente **tolerante**: `z.object` sin `.strict()` (los campos que
 * el deck no conoce se ignoran) y casi todo opcional o nullable, porque la
 * sugerencia se genera en background y puede llegar incompleta — sin media, sin
 * explicación. Una tarjeta sin preview se dibuja igual, con el texto sobre un
 * fondo neutro; una sugerencia que no valida tira `invalid_response` y la
 * pantalla lo trata como error, no como cola vacía.
 *
 * Cuando el endpoint exista, este schema se muda a `packages/contracts` y acá
 * queda el re-export.
 */
import {
  aspectRatioSchema,
  blitzContentTypeSchema,
  type BlitzContentType,
} from "@fastgram/contracts";
import { z } from "zod";

const remixSourceSchema = z.object({
  url: z.string().url(),
  thumbnailUrl: z.string().url().nullable().optional(),
  likes: z.number().int().nonnegative().nullable().optional(),
  views: z.number().int().nonnegative().nullable().optional(),
});

const slideSchema = z.object({
  imageUrl: z.string().url().nullable().optional(),
  text: z.string().nullable().optional(),
});

const previewSchema = z.object({
  /** Slideshow: una por slide. Los demás tipos: una sola, o ninguna. */
  slides: z.array(slideSchema).optional(),
  /** Fondo de los tipos de video (wall of text, green screen, video hook). */
  backgroundUrl: z.string().url().nullable().optional(),
  audioUrl: z.string().url().nullable().optional(),
  aspectRatio: aspectRatioSchema.nullable().optional(),
});

export const deckSuggestionSchema = z.object({
  id: z.string().min(1),
  contentType: blitzContentTypeSchema,
  generatedText: z.string().nullable().optional(),
  /** FR-050 criterio 3: el racional **almacenado**, nunca uno generado al vuelo. */
  aiExplanation: z.string().nullable().optional(),
  influencer: z
    .object({ id: z.string(), name: z.string().min(1) })
    .nullable()
    .optional(),
  angle: z
    .object({ id: z.string(), title: z.string().min(1) })
    .nullable()
    .optional(),
  remixSource: remixSourceSchema.nullable().optional(),
  preview: previewSchema.nullable().optional(),
  /** `PU-BLITZ-003`: salió de un «Create from prompt». Dibuja el chip. */
  promptRequestId: z.string().nullable().optional(),
  /** Sprint 7: el meme lo encontró solo «crear desde prompt». Dibuja el chip. */
  autoFoundMeme: z.object({ sourceUrl: z.string() }).nullable().optional(),
});
export type DeckSuggestion = z.infer<typeof deckSuggestionSchema>;

export const deckQueueSchema = z.array(deckSuggestionSchema);

/**
 * Lo que dibuja una tarjeta: **esa** sugerencia de `GET /blitz/queue`.
 *
 * Hasta el 2026-09-24 había un modo `blind` —"la siguiente de la cola", sin
 * verla— para cuando la API no listaba la cola. La ruta existe desde
 * `PU-BLITZ-002` y el modo se sacó: un 404 de la cola es un error.
 */
export interface DeckCard {
  readonly kind: "preview";
  readonly key: string;
  readonly suggestion: DeckSuggestion;
}

/** Una slide lista para dibujar: fondo opcional y texto opcional. */
export interface PreviewSlide {
  readonly imageUrl: string | null;
  readonly text: string | null;
}

/**
 * Las slides que dibuja la tarjeta.
 *
 * Si la sugerencia trae `preview.slides`, son ésas. Si no, se arma **una** con
 * el fondo (si hay) y el `generatedText`: es la preview fiel más barata —el
 * texto sobre el fondo— y la que corresponde a los tipos de video, que son una
 * sola pantalla. Nunca devuelve una lista vacía: una tarjeta sin slides no
 * tendría qué mostrar.
 */
export function slidesOf(suggestion: DeckSuggestion): readonly PreviewSlide[] {
  const preview = suggestion.preview ?? null;
  const fallbackText = nonEmpty(suggestion.generatedText);
  const slides = preview?.slides ?? [];
  if (slides.length > 0) {
    return slides.map((slide, index) => ({
      imageUrl: slide.imageUrl ?? preview?.backgroundUrl ?? null,
      // Sin texto propio, la primera slide lleva el texto generado: es el hook.
      text: nonEmpty(slide.text) ?? (index === 0 ? fallbackText : null),
    }));
  }
  return [{ imageUrl: preview?.backgroundUrl ?? null, text: fallbackText }];
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** ¿Tiene sonido la preview? Decide si se dibuja el control de mute (F-057). */
export function hasAudio(suggestion: DeckSuggestion): boolean {
  return nonEmpty(suggestion.preview?.audioUrl) !== null;
}

/**
 * `aiExplanation` → bullets (F-055: *"explicación IA en bullets"*).
 *
 * El campo es texto libre. Se parte por líneas y se limpian los marcadores de
 * lista que un LLM suele poner (`-`, `*`, `•`, `1.`). Un párrafo único queda
 * como un solo bullet: partir por oraciones inventaría una estructura que el
 * modelo no escribió.
 */
export function explanationBullets(text: string | null | undefined): readonly string[] {
  if (text === null || text === undefined) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line !== "");
}

/** Número compacto para likes y views (`106.8K`, `1.3M`), como el PRD los muestra. */
export function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Cuántas tarjetas quedan antes de pedirle más a la cola.
 *
 * La cola apunta a 5 (FR-055, `DISCOVERY_QUEUE_TARGET_ITEMS`). Con 2 o menos a
 * la vista se vuelve a pedir: el usuario todavía tiene dos decisiones por
 * delante —unos segundos— mientras llega la respuesta, así que el deck no se
 * queda vacío por esperar al último swipe para preguntar.
 */
export const LOW_WATERMARK = 2;

export function needsRefill(remaining: number): boolean {
  return remaining <= LOW_WATERMARK;
}

/**
 * Cadencia de relleno mientras la cola está corta o vacía.
 *
 * FR-050 criterio 4: *"con cola vacía se muestra el estado de espera y la UI
 * reintenta sin recargar"*. 15 s: el refill genera con un LLM y tarda del orden
 * de decenas de segundos, así que preguntar más seguido sólo gasta el rate
 * limit de §9.6 (60/min) contra una respuesta que no cambió.
 */
export const QUEUE_POLL_MS = 15_000;

/** Las sugerencias de la cola que todavía no se decidieron en esta sesión. */
export function pendingSuggestions(
  queue: readonly DeckSuggestion[],
  decided: ReadonlySet<string>,
): readonly DeckSuggestion[] {
  return queue.filter((item) => !decided.has(item.id));
}

/** Tipo de Blitz → la clave de copy del chip (F-053), la misma que usa la Library. */
export const BLITZ_TYPE_COPY: Readonly<
  Record<
    BlitzContentType,
    | "library.type.slideshow"
    | "library.type.wallOfText"
    | "library.type.greenScreen"
    | "library.type.videoHook"
  >
> = {
  slideshow: "library.type.slideshow",
  "wall-of-text": "library.type.wallOfText",
  "green-screen": "library.type.greenScreen",
  "video-hook": "library.type.videoHook",
};
