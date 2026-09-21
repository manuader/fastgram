/**
 * `P2-RENDER-013` / `NFR-014` — Normalización de media: MOV→MP4, HDR→SDR,
 * faststart.
 *
 * ── Qué se puede y qué no en este build ──────────────────────────────────────
 * Verificado el 2026-09-21 contra ffmpeg 9.0.1 (Homebrew):
 *   · `zscale` NO está (el build no trae libzimg).
 *   · `libplacebo` NO está.
 *   · `tonemap` SÍ está, pero exige entrada en luz lineal, y lo único que
 *     linealiza PQ/HLG es `zscale`.
 *   · `colorspace` SÍ está, pero su lista de `trc` no incluye `smpte2084` ni
 *     `arib-std-b67`: convierte BT.2020 SDR (10/12 bit), no HDR real.
 *
 * Consecuencia honesta: en un build sin `zscale` **no se hace tone mapping de
 * HDR**. En vez de aplicar una conversión que arruina los colores y decir que
 * se normalizó, el resultado sale con `toneMapping: "unavailable"` y el llamador
 * decide. Silenciar esto sería exactamente el tipo de "todo verde" que hace
 * desconfiar del resto.
 */
import { RenderError } from "../errors.js";
import type { FfmpegCapabilities } from "./capabilities.js";
import { requireFfmpeg } from "./capabilities.js";
import { probeMedia, type MediaInfo } from "./probe.js";
import { runFfmpeg } from "./run.js";

export type ToneMappingResult = "not-needed" | "full" | "approximate" | "unavailable";

export interface NormalizationPlan {
  readonly needsRemux: boolean;
  readonly needsTranscode: boolean;
  readonly toneMapping: ToneMappingResult;
  readonly videoFilters: readonly string[];
  readonly args: readonly string[];
}

export interface NormalizationResult extends NormalizationPlan {
  readonly outputPath: string;
  readonly outputBytes: number;
  readonly source: MediaInfo;
}

/** Contenedores que `NFR-014` obliga a convertir a MP4. */
export const CONTAINERS_TO_CONVERT = new Set(["mov", "quicktime", "m4v"]);

function isMp4Compatible(info: MediaInfo): boolean {
  return info.formatNames.includes("mp4") && !info.formatNames.includes("quicktime");
}

/**
 * Decide qué hacer, sin ejecutar nada. Separado para poder fijarlo con tests
 * sin depender de que haya media real.
 */
export function planNormalization(
  info: MediaInfo,
  caps: FfmpegCapabilities,
): NormalizationPlan {
  const needsRemux =
    !isMp4Compatible(info) || info.formatNames.some((name) => CONTAINERS_TO_CONVERT.has(name));

  const filters: string[] = [];
  let toneMapping: ToneMappingResult = "not-needed";

  if (info.isHdr) {
    if (caps.hasZscale && caps.hasTonemap) {
      // La única cadena que linealiza PQ/HLG de verdad.
      filters.push(
        "zscale=t=linear:npl=100",
        "format=gbrpf32le",
        "zscale=p=bt709",
        "tonemap=tonemap=hable:desat=0",
        "zscale=t=bt709:m=bt709:r=tv",
      );
      toneMapping = "full";
    } else {
      toneMapping = "unavailable";
    }
  } else if (info.isWideGamutSdr && caps.hasColorspace) {
    // BT.2020 SDR → BT.709. `colorspace` sí cubre este caso.
    filters.push("colorspace=all=bt709:format=yuv420p");
    toneMapping = "approximate";
  }

  // yuv420p siempre: es el denominador común de los reproductores sociales.
  filters.push("format=yuv420p");

  const needsTranscode =
    filters.length > 1 ||
    info.videoCodec !== "h264" ||
    (info.pixelFormat !== null && info.pixelFormat !== "yuv420p");

  const args: string[] = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", info.path];
  if (needsTranscode) {
    args.push(
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
    );
  } else {
    args.push("-c:v", "copy");
  }
  args.push(info.hasAudio ? "-c:a" : "-an", ...(info.hasAudio ? ["aac", "-b:a", "128k"] : []));
  // `faststart` es literal en `NFR-014`: mueve el moov al principio.
  args.push("-movflags", "+faststart");

  return { needsRemux, needsTranscode, toneMapping, videoFilters: filters, args };
}

export interface NormalizeOptions {
  readonly allowUntonemappedHdr?: boolean;
  readonly timeoutMs?: number;
}

export async function normalizeMedia(
  inputPath: string,
  outputPath: string,
  caps: FfmpegCapabilities,
  options: NormalizeOptions = {},
): Promise<NormalizationResult> {
  requireFfmpeg(caps);
  const info = await probeMedia(inputPath);
  if (!info.hasVideo) {
    throw new RenderError("unsupported_media_format", "el medio no tiene pista de video", {
      details: { path: inputPath },
    });
  }
  const plan = planNormalization(info, caps);

  if (plan.toneMapping === "unavailable" && options.allowUntonemappedHdr !== true) {
    throw new RenderError(
      "render_capability_missing",
      "el medio es HDR y este build de ffmpeg no puede convertirlo a SDR",
      { details: { missing: ["zscale"], colorTransfer: info.colorTransfer } },
    );
  }

  const args = [...plan.args, outputPath];
  const result = await runFfmpeg(args, {
    expectOutput: outputPath,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  return { ...plan, outputPath, outputBytes: result.outputBytes, source: info };
}
