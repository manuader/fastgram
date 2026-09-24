/**
 * `ClipInspector` con FFmpeg local — `PU-MEME-001`/`002`/`003`.
 *
 * Corre en el worker, sobre el archivo que `yt-dlp` acaba de bajar al
 * temporal: medirlo por HTTP contra `services/render` exigiría subirlo antes, y
 * la decisión («¿es verde?», «¿dura de más?») tiene que tomarse antes de que
 * el clip exista en el Media Bank.
 *
 * Mismas reglas que `run-process.ts`: sin shell, timeout duro, salida acotada,
 * y lo que FFmpeg dice en stderr no sale de acá.
 */
import {
  PortError,
  type ClipInspector,
  type ClipProbe,
  type RgbSample,
} from "@fastgram/ports";

import { minimalChildEnv, runProcess, type ProcessRunner } from "./run-process.js";

const SOURCE = "ClipInspector/ffmpeg";

export interface FfmpegClipInspectorConfig {
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  readonly run?: ProcessRunner;
  /** Por invocación. Un cuadro sale en décimas de segundo; 60 s es un cuelgue. */
  readonly timeoutMs?: number;
}

/** Lado de la grilla del muestreo de borde: 16×16 → 60 celdas de borde por cuadro. */
const GRID = 16;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

interface ProbeJson {
  streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
  format?: { duration?: string };
}

const toNumber = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** Instantes repartidos en el interior del clip: nunca el cuadro 0 (suele ser negro). */
export function sampleTimes(durationSeconds: number | null, count: number): number[] {
  const d = durationSeconds !== null && durationSeconds > 0 ? durationSeconds : 1;
  return Array.from({ length: count }, (_, i) => (d * (i + 1)) / (count + 1));
}

/** Celdas del marco exterior de una grilla `GRID×GRID` en RGB24. */
export function borderCells(raw: Uint8Array, grid: number = GRID): RgbSample[] {
  const out: RgbSample[] = [];
  const at = (x: number, y: number): RgbSample => {
    const i = (y * grid + x) * 3;
    return { r: raw[i] ?? 0, g: raw[i + 1] ?? 0, b: raw[i + 2] ?? 0 };
  };
  for (let x = 0; x < grid; x++) {
    out.push(at(x, 0), at(x, grid - 1));
  }
  for (let y = 1; y < grid - 1; y++) {
    out.push(at(0, y), at(grid - 1, y));
  }
  return out;
}

export class FfmpegClipInspector implements ClipInspector {
  readonly #ffmpeg: string;
  readonly #ffprobe: string;
  readonly #run: ProcessRunner;
  readonly #timeoutMs: number;
  readonly #env = minimalChildEnv();

  constructor(config: FfmpegClipInspectorConfig = {}) {
    this.#ffmpeg = config.ffmpeg ?? "ffmpeg";
    this.#ffprobe = config.ffprobe ?? "ffprobe";
    this.#run = config.run ?? runProcess;
    this.#timeoutMs = config.timeoutMs ?? 60_000;
  }

  async probe(path: string): Promise<ClipProbe> {
    const r = await this.#run(
      this.#ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
      { timeoutMs: this.#timeoutMs, maxStdoutBytes: 1024 * 1024, env: this.#env },
    );
    if (r.exitCode !== 0) {
      throw new PortError("bad_request", "The clip could not be read", {
        source: SOURCE,
      });
    }
    let parsed: ProbeJson;
    try {
      parsed = JSON.parse(r.stdout) as ProbeJson;
    } catch (cause) {
      throw new PortError(
        "provider_contract_violation",
        "ffprobe returned invalid JSON",
        {
          source: SOURCE,
          cause,
        },
      );
    }
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === "video");
    return {
      durationSeconds: toNumber(parsed.format?.duration) ?? toNumber(video?.duration),
      width: video?.width ?? null,
      height: video?.height ?? null,
      hasVideo: video !== undefined,
      hasAudio: streams.some((s) => s.codec_type === "audio"),
    };
  }

  async #frame(
    path: string,
    at: number,
    filter: string,
    format: string[],
  ): Promise<Buffer> {
    const r = await this.#run(
      this.#ffmpeg,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        at.toFixed(3),
        "-i",
        path,
        "-frames:v",
        "1",
        "-vf",
        filter,
        ...format,
        "pipe:1",
      ],
      { timeoutMs: this.#timeoutMs, maxStdoutBytes: MAX_FRAME_BYTES, env: this.#env },
    );
    if (r.exitCode !== 0 || r.stdoutBytes.length === 0) {
      throw new PortError("bad_request", "Could not extract a frame from the clip", {
        source: SOURCE,
      });
    }
    return r.stdoutBytes;
  }

  async frames(
    path: string,
    count: number,
    maxSide: number,
  ): Promise<readonly Uint8Array[]> {
    const { durationSeconds } = await this.probe(path);
    const side = Math.max(16, Math.round(maxSide));
    const out: Uint8Array[] = [];
    for (const t of sampleTimes(durationSeconds, count)) {
      out.push(
        await this.#frame(
          path,
          t,
          `scale=${side}:${side}:force_original_aspect_ratio=decrease`,
          ["-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe"],
        ),
      );
    }
    return out;
  }

  async borderSamples(path: string, count: number): Promise<readonly RgbSample[]> {
    const { durationSeconds } = await this.probe(path);
    const out: RgbSample[] = [];
    for (const t of sampleTimes(durationSeconds, count)) {
      const raw = await this.#frame(path, t, `scale=${GRID}:${GRID}:flags=area`, [
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
      ]);
      if (raw.length < GRID * GRID * 3) {
        throw new PortError("provider_contract_violation", "Short frame from ffmpeg", {
          source: SOURCE,
        });
      }
      out.push(...borderCells(raw));
    }
    return out;
  }
}
