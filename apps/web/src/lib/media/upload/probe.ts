/**
 * Medir un video **en el navegador**, antes de que exista en el servidor.
 *
 * El contrato no publica ancho ni alto de un asset (`mediaSchema` no los
 * tiene), y la normalización del worker tampoco los devuelve. Lo único que
 * sabe si un clip es vertical es el propio archivo, y el navegador lo puede
 * leer sin subir nada: un `<video>` sobre un object URL dispara
 * `loadedmetadata` con `videoWidth`/`videoHeight` en cuanto parsea la cabecera.
 *
 * Se usa sólo para **sugerir** categorías, así que nunca falla: sin medidas
 * devuelve `null` y la sugerencia cae al caso conservador. Casos reales de
 * `null`: un `.mov` HEVC en Chrome/Firefox (no lo decodifican), jsdom, o un
 * archivo corrupto.
 */
import type { VideoDimensions } from "../categories";

/** Tope de espera. La cabecera de un MP4 bien formado se lee en milisegundos. */
export const PROBE_TIMEOUT_MS = 4_000;

export function probeVideoDimensions(file: Blob): Promise<VideoDimensions | null> {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;

    const finish = (value: VideoDimensions | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };

    const timer = setTimeout(() => {
      finish(null);
    }, PROBE_TIMEOUT_MS);

    video.preload = "metadata";
    video.muted = true;
    video.addEventListener("loadedmetadata", () => {
      const { videoWidth: width, videoHeight: height } = video;
      finish(width > 0 && height > 0 ? { width, height } : null);
    });
    video.addEventListener("error", () => {
      finish(null);
    });
    video.src = url;
  });
}
