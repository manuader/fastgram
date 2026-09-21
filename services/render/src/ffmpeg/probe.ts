/** Lectura de metadatos con ffprobe. La salida cruda nunca sale hacia afuera. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RenderError } from "../errors.js";
import { FFPROBE_BIN } from "./capabilities.js";

const execFileAsync = promisify(execFile);

/** Transferencias HDR que exigen tone mapping (`NFR-014`). */
export const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);
/** Transferencias BT.2020 SDR de gama amplia: convertibles con `colorspace`. */
export const WIDE_GAMUT_TRANSFERS = new Set(["bt2020-10", "bt2020-12"]);

export interface MediaInfo {
  readonly path: string;
  readonly formatNames: readonly string[];
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
  format?: { format_name?: string; duration?: string };
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
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        path,
      ],
      { maxBuffer: 8_000_000 },
    );
    // El JSON de ffprobe es datos externos: se valida por forma, no se confía.
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch (cause) {
    throw new RenderError("media_probe_failed", "no se pudo leer el medio", {
      details: { path },
      cause,
    });
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const transfer = video?.color_transfer ?? null;
  const primaries = video?.color_primaries ?? null;

  return {
    path,
    formatNames: (parsed.format?.format_name ?? "").split(",").filter((s) => s.length > 0),
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
  };
}
