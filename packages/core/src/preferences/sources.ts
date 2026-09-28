/**
 * De dónde es una media, en el vocabulario de preferencias — sprint 9 (T).
 *
 * La misma tabla la usan quien **aprende** (la API, al aceptar o descartar:
 * `apps/api/src/services/preferences.ts`) y quien **puntúa** (el decisor del
 * refill): si las dos no dijeran lo mismo, un rasgo aprendido nunca matchearía
 * a un candidato. Por eso vive en `core` y no repetida en cada app.
 *
 * ## La biblioteca global dentro de una marca
 *
 * «Usar en marca» (N) y el refill (T) **copian** el asset global al Media Bank
 * de la marca, bajo `media/{companyId}/library/…`, con origen `manual_upload`
 * (N no agregó un origen propio para no migrar el CHECK de `media`). Para el
 * gusto del dueño eso es `library`, no `upload`: se reconoce por la ruta.
 */
import type { PrefMediaSource, PrefMusicSource } from "./features.js";

/** `media.origin` → fuente. Lo que no está acá no es un rasgo. */
const MEDIA_ORIGIN_SOURCE: Readonly<Record<string, PrefMediaSource>> = {
  manual_upload: "upload",
  generated: "generated",
  brand_kit: "brand",
  demo: "library",
  internal: "library",
  imported: "imported",
};

/** `brand_audio_tracks.origin` → fuente de la música. */
const AUDIO_ORIGIN_SOURCE: Readonly<Record<string, PrefMusicSource>> = {
  upload: "upload",
  import: "import",
  extracted: "extracted",
};

/** ¿Es una copia de la biblioteca global en el Media Bank de una marca? */
export function isLibraryCopyLocation(location: string | null | undefined): boolean {
  if (location === null || location === undefined) return false;
  // Un storage puede codificar la clave en la URL (`media%2F…`): se decodifica.
  let decoded = location;
  try {
    decoded = decodeURIComponent(location);
  } catch {
    // Un `%` suelto: se mira tal cual.
  }
  return /(^|\/)(media|audio)\/[0-9a-f-]{36}\/library\//i.test(decoded);
}

/** La fuente de una media de la marca, o `null` si el origen no se conoce. */
export function prefMediaSourceOf(media: {
  readonly origin: string;
  /** La URL o la clave: con `…/library/…` es una copia de la biblioteca. */
  readonly location?: string | null | undefined;
}): PrefMediaSource | null {
  if (isLibraryCopyLocation(media.location)) return "library";
  return MEDIA_ORIGIN_SOURCE[media.origin] ?? null;
}

/** La fuente de una pista de la marca, o `null`. */
export function prefMusicSourceOf(track: {
  readonly origin: string;
  readonly location?: string | null | undefined;
}): PrefMusicSource | null {
  if (isLibraryCopyLocation(track.location)) return "library";
  return AUDIO_ORIGIN_SOURCE[track.origin] ?? null;
}
