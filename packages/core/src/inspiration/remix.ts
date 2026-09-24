/**
 * «Remix this» — Inspiration de uso personal (`FR-040` adaptado, `F-042`,
 * `AI-003`, `F-056`).
 *
 * Reusa el pipeline de «crear desde prompt» (`POST /blitz/generate`,
 * `PU-BLITZ-003`) en vez de inventar otro: la API guarda un
 * `blitz_prompt_requests` con `source_trending_item_id`, el worker lo planifica
 * igual que un prompt y le pasa la referencia a la copy como
 * {@link CopyRemixReference} (dato, en el bloque `untrusted`), y al cerrar el
 * pedido las sugerencias heredan `remix_source_url` y `source_trending_item_id`
 * (`db/repositories/blitz-prompt.ts`): el deck las muestra con "Remixed From".
 *
 * ## Lo que decide esto
 *
 * - El **tema guardado** cuando el dueño no escribe una nota: el pedido exige
 *   3–500 caracteres (`0012`), y un remix sin nota es lo normal.
 * - El **formato por defecto**: una referencia de fotos se remixa como
 *   slideshow y un post de texto como wall of text; un video lo decide el mix
 *   de la marca (los cuatro formatos de Blitz son de video o fotos, y ninguno
 *   es "el mismo video"). El dueño puede forzarlo.
 */
import type { BlitzContentType } from "../content/content.js";
import type { CopyRemixReference } from "../discovery/suggestion-copy.js";
import type { ReferenceFormat } from "./reference-info.js";

/** El `prompt` del pedido cuando el dueño no escribió una nota. */
export const REMIX_DEFAULT_PROMPT = "Remix this saved reference for this brand.";

/** `null` = lo decide el content mix de la marca. */
export function remixContentType(
  format: ReferenceFormat | null | undefined,
): BlitzContentType | null {
  switch (format) {
    case "slideshow":
    case "image":
      return "slideshow";
    case "text":
      return "wall-of-text";
    default:
      return null;
  }
}

/** Lo que el worker lee de la fila (`trending_items`) para la copy. */
export interface RemixSourceRow {
  readonly format: string | null;
  readonly title: string | null;
  readonly author: string | null;
  readonly caption: string | null;
  readonly hashtags: readonly string[];
  readonly textOverlays: readonly string[];
}

export function toCopyRemixReference(row: RemixSourceRow): CopyRemixReference {
  return {
    format: row.format,
    title: row.title,
    author: row.author,
    caption: row.caption,
    hashtags: row.hashtags,
    onScreenText: row.textOverlays,
  };
}
