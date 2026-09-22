/**
 * IMPL §5 — «Nunca servir el master para un preview».
 *
 * Un cuadro del medio, escalado, en JPEG. Es el respaldo del método
 * `MediaRenderer.thumbnail` del puerto, que hasta ahora no tenía ruta HTTP.
 *
 * ── Un solo camino, ffmpeg, también para imágenes ────────────────────────────
 * Tentaba resolver las imágenes con sharp (que es lo que usa el resto del
 * pipeline de imagen) y los videos con ffmpeg. Se resuelven los dos con ffmpeg,
 * a propósito: son dos motores con dos conjuntos de fallas, dos formas de
 * quedarse sin salida y dos traducciones de error, para un artefacto que es el
 * mismo JPEG. La única bifurcación que queda es si se hace `-ss` o no.
 *
 * ── Lo que el PRD no dice, y acá se decide ───────────────────────────────────
 * Ni el PRD ni IMPL fijan el segundo por defecto ni la calidad. Las dos son
 * elecciones del servicio, del mismo tipo que `SLIDE_JPEG_QUALITY` o los
 * defaults del chromakey. ABIERTO. El porqué de cada una está en su constante.
 */
import { toEvenDimension } from "../domain/canvas.js";
import { RenderError } from "../errors.js";
import type { MediaInfo } from "./probe.js";

/**
 * Segundo por defecto: **0**.
 *
 * Un default de 1 s o del 10 % de la duración da previews más lindos y es una
 * apuesta: hay que decidir qué pasa con un video más corto que el default, y el
 * mismo pedido puede dar un frame distinto si cambia la duración del master. El
 * 0 existe en todo medio con al menos un frame y no necesita ninguna regla
 * extra. Quien quiera otro cuadro lo pide: el puerto tiene `atSeconds`.
 */
export const DEFAULT_THUMBNAIL_AT_SECONDS = 0;

/**
 * Calidad JPEG de ffmpeg (`-q:v`, 2 = mejor … 31 = peor). El PRD no la fija.
 * 3 es preview: pesa una fracción del master y no muestra artefactos al
 * tamaño en que se mira una miniatura.
 */
export const THUMBNAIL_JPEG_QUALITY = 3;

/**
 * Margen contra el final. Pedir exactamente el último timestamp deja a ffmpeg
 * sin frame que decodificar y la corrida sale con código 0 y sin archivo —la
 * trampa de `run.ts`—, así que se recorta antes.
 */
const END_MARGIN_SECONDS = 0.1;

export interface ThumbnailGeometry {
  readonly width: number;
  readonly height: number;
}

export interface ThumbnailPlan extends ThumbnailGeometry {
  /** `null` = imagen fija: no se hace `-ss`. */
  readonly atSeconds: number | null;
  /** Lo que el llamador debería saber aunque la corrida salga bien. */
  readonly warnings: readonly string[];
  readonly args: readonly string[];
}

export interface ThumbnailRequest {
  /** Techo, no objetivo: una fuente más chica NO se agranda. */
  readonly maxWidth: number;
  readonly atSeconds?: number | undefined;
}

/**
 * Geometría del preview. Nunca agranda: `maxWidth` es un techo, y escalar hacia
 * arriba produciría un archivo más pesado que el original sin un solo píxel más
 * de información.
 *
 * Las dos dimensiones salen pares con `toEvenDimension`, que es lo que ya hace
 * el resto del servicio. Para un JPEG no hace falta —mjpeg acepta impares— pero
 * tener un solo criterio de redondeo en todo el servicio vale más que el píxel
 * que se gana.
 */
export function thumbnailGeometry(
  source: ThumbnailGeometry,
  maxWidth: number,
): ThumbnailGeometry {
  const width = Math.max(2, toEvenDimension(Math.min(maxWidth, source.width)));
  const scaled = (source.height * width) / source.width;
  return { width, height: Math.max(2, toEvenDimension(scaled)) };
}

export function planThumbnail(
  info: MediaInfo,
  request: ThumbnailRequest,
  outputPath: string,
): ThumbnailPlan {
  if (info.width === null || info.height === null || !info.hasVideo) {
    throw new RenderError(
      "unsupported_media_format",
      "el medio no tiene una pista visual de la que sacar un preview",
    );
  }
  const geometry = thumbnailGeometry(
    { width: info.width, height: info.height },
    request.maxWidth,
  );
  const requested = request.atSeconds ?? DEFAULT_THUMBNAIL_AT_SECONDS;
  const warnings: string[] = [];

  let atSeconds: number | null;
  if (info.isStillImage) {
    // Una imagen no tiene línea de tiempo. El puerto ya lo dice: «Ignorado en
    // imágenes».
    atSeconds = null;
  } else if (info.durationSeconds === null) {
    // Sin duración no se puede acotar el seek, y un `-ss` más allá del final
    // sale con código 0 y sin archivo. Se saca el primer frame y se avisa, en
    // vez de devolver un 500 por un pedido que era razonable.
    atSeconds = null;
    if (requested > 0) {
      warnings.push("el medio no declara duración: el preview se tomó del primer cuadro");
    }
  } else {
    const ceiling = Math.max(0, info.durationSeconds - END_MARGIN_SECONDS);
    atSeconds = Math.min(Math.max(0, requested), ceiling);
    if (atSeconds < requested) {
      warnings.push(
        "el segundo pedido cae más allá del final: el preview se tomó del final del medio",
      );
    }
  }

  const args: string[] = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
  // `-ss` ANTES de `-i`: seek por índice en vez de decodificar desde el inicio.
  // En un video largo es la diferencia entre milisegundos y segundos.
  if (atSeconds !== null && atSeconds > 0) args.push("-ss", atSeconds.toFixed(3));
  args.push(
    "-i",
    info.path,
    "-frames:v",
    "1",
    "-vf",
    // `setsar=1` porque una fuente con píxeles no cuadrados daría un preview
    // con la proporción cambiada respecto del master.
    `scale=${String(geometry.width)}:${String(geometry.height)},setsar=1`,
    // Sin esto, un archivo con pista de audio hace que el muxer image2 se queje
    // de un stream que no puede escribir.
    "-an",
    "-f",
    "image2",
    "-c:v",
    "mjpeg",
    "-q:v",
    String(THUMBNAIL_JPEG_QUALITY),
    outputPath,
  );

  return { ...geometry, atSeconds, warnings, args };
}
