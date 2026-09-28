/**
 * FFmpeg local para la biblioteca global — sprint 9 (agente N).
 *
 * ## Por qué local y no `normalizeVideo` del render
 *
 * `media/normalize-video.ts` le pide la transcodificación a `services/render`
 * por HTTP, con un grant **del workspace** (`media/{companyId}/…`). Un asset
 * global no es de ningún workspace, y el archivo ya está en el disco del
 * worker (lo acaba de bajar): subirlo, pedir que el render lo lea con un
 * grant nuevo y bajar el resultado son tres viajes para lo mismo. Así que se
 * reusa lo que sí aplica —el destino de `NFR-014` (`video/mp4`, H.264,
 * `faststart`) de `normalize-video.ts`, y `FfmpegClipInspector` +
 * `borderCells` de `media-import`— y la transcodificación corre acá, como
 * la extracción de audio (`audio-extract/ffmpeg.ts`).
 *
 * ## Qué se toca y qué no
 *
 * - Video con **alfa** (VP9 con `alpha_mode=1`, trampa 55): se deja tal cual
 *   (`webm`). Transcodificarlo a H.264 perdería el alfa.
 * - Otro video: a MP4 H.264 `yuv420p`, lado mayor ≤ 1920, `+faststart`, AAC.
 *   Salvo que ya sea exactamente eso.
 * - Imagen: JPEG/PNG/WebP quedan; otra cosa (TIFF, GIF) pasa a PNG.
 * - Audio: MP3/M4A quedan; WAV/OGG/FLAC pasan a M4A (AAC).
 *
 * Nunca sale el stderr de FFmpeg: sólo un código.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import { borderCells, minimalChildEnv, runProcess } from "@fastgram/adapters";
import type { RgbSample } from "@fastgram/ports";

import { NORMALIZED_VIDEO_CONTENT_TYPE } from "../media/normalize-video.js";

export interface MediaToolsConfig {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  /** Tope de cada proceso. Default 10 min (transcodificar 3 min de 4K). */
  readonly timeoutMs?: number;
}

export type ProbedMediaType = "video" | "image" | "audio";

export interface ProbedMedia {
  readonly mediaType: ProbedMediaType;
  readonly formatName: string;
  readonly videoCodec: string | null;
  readonly pixFmt: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSec: number | null;
  readonly hasAudio: boolean;
  readonly hasAlpha: boolean;
}

export interface NormalizedFile {
  readonly path: string;
  readonly contentType: string;
  readonly extension: string;
  readonly sizeBytes: number;
  /** `false` = se usó el archivo tal cual. */
  readonly transcoded: boolean;
}

export class MediaToolError extends Error {
  constructor(readonly code: "unsupported_media" | "normalization_failed") {
    super(code);
  }
}

interface ProbeJson {
  format?: { format_name?: string; duration?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    pix_fmt?: string;
    width?: number;
    height?: number;
    duration?: string;
    nb_frames?: string;
    disposition?: { attached_pic?: number };
    tags?: Record<string, string>;
  }[];
}

/** Códecs de imagen fija (un `png` dentro de un contenedor `image2`). */
const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "gif", "tiff", "bmp"]);

const toNumber = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function createMediaTools(config: MediaToolsConfig) {
  const env = minimalChildEnv();
  const timeoutMs = config.timeoutMs ?? 600_000;

  async function ffmpeg(args: readonly string[], maxStdoutBytes = 64 * 1024) {
    return runProcess(
      config.ffmpeg,
      ["-nostdin", "-hide_banner", "-loglevel", "error", ...args],
      {
        timeoutMs,
        maxStdoutBytes,
        env,
      },
    );
  }

  async function probe(file: string): Promise<ProbedMedia> {
    const r = await runProcess(
      config.ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { timeoutMs: 60_000, maxStdoutBytes: 1024 * 1024, env },
    );
    if (r.exitCode !== 0) throw new MediaToolError("unsupported_media");
    let parsed: ProbeJson;
    try {
      parsed = JSON.parse(r.stdout) as ProbeJson;
    } catch {
      throw new MediaToolError("unsupported_media");
    }
    const streams = parsed.streams ?? [];
    const video = streams.find(
      (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
    );
    const audio = streams.find((s) => s.codec_type === "audio");
    const formatName = parsed.format?.format_name ?? "";
    const duration = toNumber(parsed.format?.duration) ?? toNumber(video?.duration);
    const isStill =
      video !== undefined &&
      IMAGE_CODECS.has(video.codec_name ?? "") &&
      (formatName.includes("image2") ||
        formatName.endsWith("_pipe") ||
        duration === null ||
        video.nb_frames === "1");
    const mediaType: ProbedMediaType | null =
      video === undefined
        ? audio === undefined
          ? null
          : "audio"
        : isStill
          ? "image"
          : "video";
    if (mediaType === null) throw new MediaToolError("unsupported_media");
    const pixFmt = video?.pix_fmt ?? null;
    // Trampa 55: en un webm VP9 con alfa ffprobe dice `yuv420p`; lo delata la tag.
    const alphaTag = video?.tags?.["alpha_mode"] ?? video?.tags?.["ALPHA_MODE"];
    return {
      mediaType,
      formatName,
      videoCodec: video?.codec_name ?? null,
      pixFmt,
      width: video?.width ?? null,
      height: video?.height ?? null,
      durationSec: mediaType === "image" ? null : duration,
      hasAudio: audio !== undefined,
      hasAlpha:
        mediaType === "video" &&
        (alphaTag === "1" || (pixFmt?.startsWith("yuva") ?? false)),
    };
  }

  async function sizeOf(file: string): Promise<number> {
    return (await stat(file)).size;
  }

  async function run(args: readonly string[]): Promise<void> {
    const r = await ffmpeg(args);
    if (r.exitCode !== 0 || r.timedOut || r.spawnError !== null) {
      throw new MediaToolError("normalization_failed");
    }
  }

  const MAX_SIDE = 1920;

  async function normalize(
    file: string,
    probed: ProbedMedia,
    workDir: string,
  ): Promise<NormalizedFile> {
    const keep = async (
      contentType: string,
      extension: string,
    ): Promise<NormalizedFile> => ({
      path: file,
      contentType,
      extension,
      sizeBytes: await sizeOf(file),
      transcoded: false,
    });

    if (probed.mediaType === "video") {
      if (probed.hasAlpha) {
        if (
          !probed.formatName.includes("webm") &&
          !probed.formatName.includes("matroska")
        ) {
          // Alfa en otro contenedor (ProRes 4444 en MOV): se deja, el render lo lee.
          return keep("video/quicktime", "mov");
        }
        return keep("video/webm", "webm");
      }
      const side = Math.max(probed.width ?? 0, probed.height ?? 0);
      const alreadyMp4 =
        probed.formatName.includes("mp4") &&
        probed.videoCodec === "h264" &&
        probed.pixFmt === "yuv420p" &&
        side <= MAX_SIDE;
      if (alreadyMp4) {
        // `+faststart` igual: remux sin recodificar es barato y lo garantiza.
        const out = path.join(workDir, "normalized.mp4");
        await run([
          "-y",
          "-i",
          file,
          "-map",
          "0",
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          out,
        ]);
        return {
          path: out,
          contentType: NORMALIZED_VIDEO_CONTENT_TYPE,
          extension: "mp4",
          sizeBytes: await sizeOf(out),
          transcoded: false,
        };
      }
      const out = path.join(workDir, "normalized.mp4");
      await run([
        "-y",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        // Lado mayor ≤ 1920 y dimensiones pares (H.264 4:2:0 las exige).
        `scale='min(${String(MAX_SIDE)},iw)':'min(${String(MAX_SIDE)},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        // 18: el borde del croma sobrevive sin bloques (el keyer los ve).
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        out,
      ]);
      return {
        path: out,
        contentType: NORMALIZED_VIDEO_CONTENT_TYPE,
        extension: "mp4",
        sizeBytes: await sizeOf(out),
        transcoded: true,
      };
    }

    if (probed.mediaType === "image") {
      if (probed.videoCodec === "mjpeg") return keep("image/jpeg", "jpg");
      if (probed.videoCodec === "png") return keep("image/png", "png");
      if (probed.videoCodec === "webp") return keep("image/webp", "webp");
      const out = path.join(workDir, "normalized.png");
      await run(["-y", "-i", file, "-frames:v", "1", out]);
      return {
        path: out,
        contentType: "image/png",
        extension: "png",
        sizeBytes: await sizeOf(out),
        transcoded: true,
      };
    }

    // audio
    if (probed.formatName.includes("mp3")) return keep("audio/mpeg", "mp3");
    if (probed.formatName.includes("mp4") || probed.formatName.includes("m4a"))
      return keep("audio/mp4", "m4a");
    const out = path.join(workDir, "normalized.m4a");
    await run(["-y", "-i", file, "-vn", "-c:a", "aac", "-b:a", "192k", out]);
    return {
      path: out,
      contentType: "audio/mp4",
      extension: "m4a",
      sizeBytes: await sizeOf(out),
      transcoded: true,
    };
  }

  /** El póster (JPEG, 640 px de ancho). Video: al 30 % del clip; imagen: ella misma. */
  async function poster(
    file: string,
    probed: ProbedMedia,
    workDir: string,
  ): Promise<string | null> {
    if (probed.mediaType === "audio") return null;
    const out = path.join(workDir, "preview.jpg");
    const at =
      probed.mediaType === "video" && probed.durationSec !== null
        ? (probed.durationSec * 0.3).toFixed(3)
        : null;
    const args = [
      "-y",
      ...(at === null ? [] : ["-ss", at]),
      ...(probed.hasAlpha ? ["-c:v", "libvpx-vp9"] : []),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(640,iw)':-2",
      "-q:v",
      "4",
      out,
    ];
    const r = await ffmpeg(args);
    return r.exitCode === 0 ? out : null;
  }

  /** Muestras del borde de una imagen fija (el inspector sólo sabe de video). */
  async function imageBorderSamples(file: string): Promise<readonly RgbSample[]> {
    const grid = 16;
    const r = await ffmpeg(
      [
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        `scale=${String(grid)}:${String(grid)}:flags=area`,
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      grid * grid * 3 * 2,
    );
    if (r.exitCode !== 0 || r.stdoutBytes.length < grid * grid * 3) return [];
    return borderCells(new Uint8Array(r.stdoutBytes), grid);
  }

  /**
   * Proporción del borde que es **transparente de verdad** (alfa < 128).
   *
   * La tag `alpha_mode=1` no alcanza: en la corrida real del 2026-09-28 un
   * webm de Commons («EXPLOSION green screen») la traía con el plano alfa
   * entero en 255 —opaco— y el fondo verde. Se decodifica con `libvpx-vp9`
   * (trampa 55: el decoder por defecto descarta el alfa) y se mide el borde.
   */
  async function alphaBorderShare(file: string, probed: ProbedMedia): Promise<number> {
    const grid = 16;
    const at = probed.durationSec === null ? 0 : probed.durationSec * 0.5;
    const r = await ffmpeg(
      [
        ...(probed.videoCodec === "vp9" ? ["-c:v", "libvpx-vp9"] : []),
        "-ss",
        at.toFixed(3),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        `alphaextract,scale=${String(grid)}:${String(grid)}:flags=area`,
        "-pix_fmt",
        "gray",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      grid * grid * 2,
    );
    if (r.exitCode !== 0 || r.stdoutBytes.length < grid * grid) return 0;
    const px = r.stdoutBytes;
    let border = 0;
    let clear = 0;
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        if (x !== 0 && y !== 0 && x !== grid - 1 && y !== grid - 1) continue;
        border += 1;
        if ((px[y * grid + x] ?? 255) < 128) clear += 1;
      }
    }
    return Math.round((clear / border) * 100) / 100;
  }

  /**
   * ¿Hay audio que se oiga? `volumedetect`: media por encima de −50 dB. No es
   * detección de habla (eso sería whisper); ver `metadata.ts`.
   */
  async function audibleAudio(file: string, probed: ProbedMedia): Promise<boolean> {
    if (!probed.hasAudio) return false;
    const r = await runProcess(
      config.ffmpeg,
      [
        "-nostdin",
        "-hide_banner",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-af",
        "volumedetect",
        "-vn",
        "-f",
        "null",
        "-",
      ],
      { timeoutMs, maxStdoutBytes: 64 * 1024, env },
    );
    const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderrTail)?.[1];
    if (mean === undefined) return true; // No se pudo medir: se asume que sí (revisión).
    if (mean === "-inf") return false;
    return Number(mean) > -50;
  }

  return { probe, normalize, poster, imageBorderSamples, audibleAudio, alphaBorderShare };
}

export type MediaTools = ReturnType<typeof createMediaTools>;
