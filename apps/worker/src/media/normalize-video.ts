/**
 * Probe → (normalize) de un video, compartido por `media-normalization` (Media
 * Bank) y la rama `custom` de `content-build` (video propio del Studio).
 * `NFR-014`, `P2-RENDER-013`.
 *
 * ## HDR sin `zscale`: se conserva el original, marcado
 *
 * `services/render` sólo hace tone mapping HDR→SDR con un FFmpeg que tenga
 * `zscale` (libzimg). Sin él responde `render_capability_missing`
 * (`services/render/src/ffmpeg/normalize.ts`), y el adaptador lo traduce a
 * `provider_unavailable` — **reintentable**, como si el servicio estuviera
 * caído. Reintentarlo no cambia nada: el FFmpeg sigue sin el filtro. Antes
 * de esto un video HDR (cualquiera grabado con un iPhone reciente) quedaba
 * `failed` después de tres intentos sin decir por qué.
 *
 * Ahora: si el probe dijo HDR y el servicio contesta que le falta la
 * capacidad, el resultado es `hdr_kept_original`. Quien llama deja el archivo
 * como estaba y lo marca; los colores pueden verse lavados en un reproductor
 * SDR, y eso es lo que dice la marca.
 *
 * Cómo se reconoce: el `cause` del `PortError` es el cuerpo de la respuesta
 * del servicio (el nuestro), con el código `render_capability_missing`. Es
 * nuestro código estable, no un mensaje de un tercero.
 */
import {
  PortError,
  type MediaAuthorization,
  type MediaProbe,
  type MediaRenderer,
  type RenderedMedia,
} from "@fastgram/ports";

/** `NFR-014`: «MOV→MP4». El único destino que el PRD nombra. */
export const NORMALIZED_VIDEO_CONTENT_TYPE = "video/mp4";

/**
 * ¿Hace falta transcodificar? Las tres condiciones de `NFR-014`, una por una.
 *
 * `MediaProbe.contentType` es lo que el motor **midió**, no lo que declaró el
 * cliente: un MOV subido como `video/mp4` se detecta acá.
 */
export function videoNormalizationReasons(probe: MediaProbe): readonly string[] {
  const reasons: string[] = [];
  if (probe.contentType !== NORMALIZED_VIDEO_CONTENT_TYPE) reasons.push("container");
  if (probe.isHdr) reasons.push("hdr");
  if (!probe.isFastStart) reasons.push("faststart");
  return reasons;
}

/** ¿El servicio de render dijo que no puede hacer tone mapping? */
export function isToneMappingUnavailable(error: unknown): boolean {
  if (!(error instanceof PortError)) return false;
  const cause: unknown = error.cause;
  return typeof cause === "string" && cause.includes("render_capability_missing");
}

export type VideoNormalization =
  | { readonly kind: "already_normalized"; readonly probe: MediaProbe }
  | {
      readonly kind: "normalized";
      readonly probe: MediaProbe;
      readonly media: RenderedMedia;
      readonly reasons: readonly string[];
    }
  | { readonly kind: "hdr_kept_original"; readonly probe: MediaProbe };

/** Los errores del puerto se propagan: los clasifica quien llama. */
export async function normalizeVideo(
  renderer: MediaRenderer,
  url: string,
  auth: MediaAuthorization,
): Promise<VideoNormalization> {
  const probe = await renderer.probe(url, auth);
  const reasons = videoNormalizationReasons(probe);
  if (reasons.length === 0) return { kind: "already_normalized", probe };
  try {
    const media = await renderer.normalize(
      { url, targetContentType: NORMALIZED_VIDEO_CONTENT_TYPE },
      auth,
    );
    return { kind: "normalized", probe, media, reasons };
  } catch (error: unknown) {
    if (probe.isHdr && isToneMappingUnavailable(error)) {
      return { kind: "hdr_kept_original", probe };
    }
    throw error;
  }
}
