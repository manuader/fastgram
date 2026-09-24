/**
 * `AudioExtractor` con FFmpeg local, y el montaje de `audio-extract`.
 *
 * Se monta **sólo si FFmpeg y ffprobe responden** al arrancar (trampa 30):
 * sin ellos, cada extracción terminaría `failed` por una herramienta que falta
 * y no por el video. Sin montar, el job espera en la cola, el estado dice
 * `queued` (verdad) y el arranque lo dice con el porqué.
 *
 * Los binarios salen de `FFMPEG_PATH` / `FFPROBE_PATH` (default: los del
 * `PATH`), las mismas variables que `media-import`.
 */
import {
  FfmpegClipInspector,
  minimalChildEnv,
  runProcess,
  type ProcessRunner,
} from "@fastgram/adapters";
import { AUDIO_EXTRACT_TIMEOUT_MS, type SecretEnv } from "@fastgram/core";

import type { AudioExtractor } from "./handler.js";

export interface FfmpegAudioExtractorConfig {
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  readonly run?: ProcessRunner;
  readonly timeoutMs?: number;
}

/**
 * Los argumentos de FFmpeg, aparte para poder testearlos sin binario.
 *
 * - `-map 0:a:0`: sólo la primera pista de audio; sin audio, FFmpeg falla (lo
 *   detectamos antes con ffprobe para dar `no_audio`).
 * - `-vn -sn -dn`: nada de video, subtítulos ni datos.
 * - AAC 128 kb/s en contenedor MP4 (`.m4a`, `audio/mp4`): lo acepta la
 *   biblioteca y lo mezcla el render sin transcodificar el formato.
 * - `-t`: el tope, como red por si la duración medida mintió.
 * - `-movflags +faststart`: el preview del navegador empieza sin bajar todo.
 */
export function extractArgs(input: string, output: string, maxSeconds: number): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-t",
    String(maxSeconds),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ];
}

export class FfmpegAudioExtractor implements AudioExtractor {
  readonly #ffmpeg: string;
  readonly #inspector: FfmpegClipInspector;
  readonly #run: ProcessRunner;
  readonly #timeoutMs: number;

  constructor(config: FfmpegAudioExtractorConfig = {}) {
    this.#ffmpeg = config.ffmpeg ?? "ffmpeg";
    this.#run = config.run ?? runProcess;
    this.#timeoutMs = config.timeoutMs ?? AUDIO_EXTRACT_TIMEOUT_MS;
    this.#inspector = new FfmpegClipInspector({
      ffmpeg: this.#ffmpeg,
      ffprobe: config.ffprobe ?? "ffprobe",
      run: this.#run,
    });
  }

  async probe(
    filePath: string,
  ): Promise<{ readonly durationSeconds: number | null; readonly hasAudio: boolean }> {
    const p = await this.#inspector.probe(filePath);
    return { durationSeconds: p.durationSeconds, hasAudio: p.hasAudio };
  }

  async extract(input: string, output: string, maxSeconds: number): Promise<boolean> {
    const r = await this.#run(this.#ffmpeg, extractArgs(input, output, maxSeconds), {
      timeoutMs: this.#timeoutMs,
      maxStdoutBytes: 64 * 1024,
      env: minimalChildEnv(),
    });
    return r.exitCode === 0 && !r.timedOut;
  }
}

export type AudioExtractMount =
  | { readonly kind: "mounted"; readonly extractor: AudioExtractor }
  | { readonly kind: "unmounted"; readonly why: string };

async function responds(binary: string): Promise<boolean> {
  const r = await runProcess(binary, ["-version"], {
    timeoutMs: 15_000,
    maxStdoutBytes: 64 * 1024,
    env: minimalChildEnv(),
  });
  return r.exitCode === 0;
}

export async function mountAudioExtract(env: SecretEnv): Promise<AudioExtractMount> {
  const ffmpeg = env["FFMPEG_PATH"]?.trim() || "ffmpeg";
  const ffprobe = env["FFPROBE_PATH"]?.trim() || "ffprobe";
  const [fv, pv] = await Promise.all([responds(ffmpeg), responds(ffprobe)]);
  const missing = [
    ...(fv ? [] : [`ffmpeg (${ffmpeg}; FFMPEG_PATH)`]),
    ...(pv ? [] : [`ffprobe (${ffprobe}; FFPROBE_PATH)`]),
  ];
  if (missing.length > 0) {
    return {
      kind: "unmounted",
      why:
        `no responden ${missing.join(", ")}: las extracciones de audio quedan ` +
        "`queued` hasta que un worker con FFmpeg las tome",
    };
  }
  return { kind: "mounted", extractor: new FfmpegAudioExtractor({ ffmpeg, ffprobe }) };
}
