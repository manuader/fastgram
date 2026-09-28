/**
 * El decisor de assets — tipos. `PU-S9-008`, D-18, D-19 (sprint 9, agente O).
 *
 * Un solo modelo de candidato para todo lo que una pieza puede necesitar:
 * meme (clip green-screen), fondo (imagen o video), imagen de slide o de post,
 * música y personaje. Venga del Media Bank de la marca (`brand`) o de la
 * biblioteca global de la instalación (`library`, D-19).
 */
import type { RelevanceText } from "../../discovery/relevance.js";

export const ASSET_KINDS = [
  /** Clip green-screen: el meme que va arriba del fondo. */
  "meme_clip",
  "background_image",
  "background_video",
  /** Imagen de slide (carrusel, slideshow) o de post estático. */
  "image",
  /** Clip de video principal (b-roll, hook). */
  "video_clip",
  "audio",
  /** Un modelo/personaje (influencer). */
  "character",
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export type AssetSource = "brand" | "library";

/**
 * Relación de aspecto, como la nombra el producto. `null`/ausente = no se sabe
 * (una imagen vieja sin metadatos): **no** se descarta por eso.
 */
export type AssetAspect = "9:16" | "16:9" | "1:1" | "4:5";

/**
 * Las licencias que D-19 deja entrar a la biblioteca global: CC0, CC-BY (con
 * atribución), stock con uso comercial sin atribución (Pexels, Pixabay),
 * propio y generado. Son los literales de `LIBRARY_LICENSE_TYPES`
 * (`packages/contracts/src/resources/library.ts`, agente N, sprint 9),
 * repetidos acá porque `core` no depende de `contracts`; el test de este
 * módulo los fija. Si N agrega una, se agrega acá.
 */
export const VERIFIABLE_LICENSES = [
  "cc0",
  "cc-by",
  "pexels",
  "pixabay",
  "own",
  "generated",
] as const;

export type AssetLicense = (typeof VERIFIABLE_LICENSES)[number];

export function isVerifiableLicense(
  value: string | null | undefined,
): value is AssetLicense {
  return (
    value !== null &&
    value !== undefined &&
    (VERIFIABLE_LICENSES as readonly string[]).includes(value)
  );
}

export interface AssetCandidate {
  /** Nuestro id (media, pista, modelo). Nunca viaja al juicio. */
  readonly id: string;
  readonly kind: AssetKind;
  readonly source: AssetSource;
  /**
   * Qué es, en una línea. **Texto de terceros** (títulos de YouTube,
   * etiquetas de un modelo de visión): va al estado limpio y truncado, nunca
   * a las instrucciones.
   */
  readonly description: string;
  readonly tags?: readonly string[] | undefined;
  readonly durationSec?: number | null | undefined;
  readonly aspect?: AssetAspect | null | undefined;
  /** Obligatoria (y verificable) cuando `source` es `library` (D-19). */
  readonly license?: string | null | undefined;
  /** Para el ranking textual. Sin él, se arma de `description` y `tags`. */
  readonly relevance?: RelevanceText | undefined;
  /**
   * Sprint 9 (T): de dónde es la media, en el vocabulario de preferencias
   * (`PREF_MEDIA_SOURCES` / `PREF_MUSIC_SOURCES`: `upload`, `generated`,
   * `brand`, `library`…). Sólo para los rasgos de `preferences.ts`; ausente =
   * no se sabe (y ese rasgo no aparece). Un candidato `library` es `library`
   * aunque no lo diga.
   */
  readonly mediaSource?: string | null | undefined;
}

/** La marca, filtrada a lo que el juicio necesita (§9.15.3.5). */
export interface DecisionBrand {
  readonly name: string;
  readonly identity?: string | null | undefined;
  readonly tone?: string | null | undefined;
  readonly audience?: string | null | undefined;
  /** Reglas de estilo del design system de la marca, si hay (agente M). */
  readonly styleRules?: string | null | undefined;
}

/** Por qué un candidato no llegó al juicio. Códigos estables, se persisten. */
export type ExclusionReason =
  "kind" | "duration" | "aspect" | "license" | "recent" | "shortlist";
