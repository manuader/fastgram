/** Lectura de metadatos con ffprobe. La salida cruda nunca sale hacia afuera. */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { RenderError } from "../errors.js";
import { FFPROBE_BIN } from "./capabilities.js";

const execFileAsync = promisify(execFile);

/** Transferencias HDR que exigen tone mapping (`NFR-014`). */
export const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);
/** Transferencias BT.2020 SDR de gama amplia: convertibles con `colorspace`. */
export const WIDE_GAMUT_TRANSFERS = new Set(["bt2020-10", "bt2020-12"]);

/**
 * Códecs de imagen fija. Cerrada a propósito: lo que no está acá no se trata
 * como imagen.
 *
 * Hace falta porque **ni el `format_name` ni la duración distinguen una imagen
 * de un video**. Verificado con ffmpeg 9.0.1 el 2026-09-22:
 *
 *     shot.png  → format_name=png_pipe   duration=None
 *     shot.jpg  → format_name=image2     duration=0.040000   ← parece un video
 *     shot.webp → format_name=webp_pipe  duration=None
 *
 * Un JPEG se ve como un video de 40 ms. Lo único estable es el códec.
 */
export const STILL_IMAGE_CODECS: Readonly<Record<string, string>> = {
  mjpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tiff: "image/tiff",
};

/**
 * `major_brand` de QuickTime. **Es el único discriminador entre MOV y MP4.**
 *
 * Verificado con ffmpeg 9.0.1 el 2026-09-22: un `.mov` de verdad y un `.mp4`
 * declaran el MISMO `format_name` —`mov,mp4,m4a,3gp,3g2,mj2`, el demuxer es
 * compartido— y sólo se diferencian en las tags:
 *
 *     real.mov  → major_brand="qt  "  compatible_brands="qt  "
 *     plain.mp4 → major_brand="isom"  compatible_brands="isomiso2avc1mp41"
 */
export const QUICKTIME_BRAND = "qt  ";

export interface MediaInfo {
  readonly path: string;
  readonly formatNames: readonly string[];
  /** `format.tags.major_brand`, o `null` si el contenedor no lo declara. */
  readonly majorBrand: string | null;
  readonly durationSeconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly videoCodec: string | null;
  readonly pixelFormat: string | null;
  readonly colorTransfer: string | null;
  readonly colorPrimaries: string | null;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly isHdr: boolean;
  readonly isWideGamutSdr: boolean;
  /** Imagen fija: la pista de "video" es un solo frame. Ver `STILL_IMAGE_CODECS`. */
  readonly isStillImage: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_transfer?: string;
  color_primaries?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    tags?: Record<string, string>;
  };
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function probeMedia(path: string): Promise<MediaInfo> {
  let parsed: FfprobeOutput;
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
      { maxBuffer: 8_000_000 },
    );
    // El JSON de ffprobe es datos externos: se valida por forma, no se confía.
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch (cause) {
    throw new RenderError("media_probe_failed", "no se pudo leer el medio", {
      // `basename` y no la ruta: `details` VIAJA al cliente (sólo `cause` se
      // descarta), y la ruta completa publica la disposición del sistema de
      // archivos del contenedor y el directorio temporal del proceso. El mismo
      // criterio que ya usaba `engine.ts:geometryOf`; acá faltaba, y se vio
      // recién cuando `POST /probe` puso este error en la superficie pública.
      details: { file: basename(path) },
      cause,
    });
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const transfer = video?.color_transfer ?? null;
  const primaries = video?.color_primaries ?? null;
  const codec = video?.codec_name ?? null;

  return {
    path,
    formatNames: (parsed.format?.format_name ?? "")
      .split(",")
      .filter((s) => s.length > 0),
    majorBrand: parsed.format?.tags?.["major_brand"] ?? null,
    durationSeconds: toNumber(parsed.format?.duration) ?? toNumber(video?.duration),
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    pixelFormat: video?.pix_fmt ?? null,
    colorTransfer: transfer,
    colorPrimaries: primaries,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    isHdr: transfer !== null && HDR_TRANSFERS.has(transfer),
    isWideGamutSdr:
      (transfer !== null && WIDE_GAMUT_TRANSFERS.has(transfer)) ||
      (primaries === "bt2020" && (transfer === null || !HDR_TRANSFERS.has(transfer))),
    isStillImage:
      codec !== null && Object.prototype.hasOwnProperty.call(STILL_IMAGE_CODECS, codec),
  };
}

/**
 * `content-type` del medio. Lo que no está en las listas cerradas sale como
 * `application/octet-stream`: adivinar un MIME es peor que decir que no se sabe.
 */
export function mediaTypeOf(info: MediaInfo): string {
  if (info.videoCodec !== null) {
    const still = STILL_IMAGE_CODECS[info.videoCodec];
    if (still !== undefined && info.isStillImage) return still;
  }
  if (info.formatNames.includes("mp4") || info.formatNames.includes("mov")) {
    // El demuxer es compartido: sólo el brand separa QuickTime de MP4.
    return info.majorBrand === QUICKTIME_BRAND ? "video/quicktime" : "video/mp4";
  }
  if (info.formatNames.includes("webm") || info.formatNames.includes("matroska")) {
    return "video/webm";
  }
  if (info.formatNames.includes("avi")) return "video/x-msvideo";
  return "application/octet-stream";
}
