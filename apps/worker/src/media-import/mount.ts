/**
 * Montar `media-import` — `PU-MEME-001`.
 *
 * Se monta **sólo si `yt-dlp` y FFmpeg responden** al arrancar. Sin ellos,
 * cada import terminaría `failed`/`download_failed`, y eso sería mentir: el
 * link está bien, lo que falta es la herramienta (trampa 30). Sin montar, el
 * job espera en la cola y el estado dice `queued`, que es verdad; el arranque
 * lo dice con el porqué.
 *
 * Los binarios salen de `YTDLP_PATH`, `FFMPEG_PATH` y `FFPROBE_PATH` (default:
 * los del `PATH`). Se leen acá y no en `env.ts` porque ese archivo no es de
 * esta tarea: está en el reporte.
 */
import {
  ChromaKeyBackgroundRemoval,
  FfmpegClipInspector,
  YtDlpDownloader,
  minimalChildEnv,
  runProcess,
} from "@fastgram/adapters";
import { greenScreenVerdict, type SecretEnv } from "@fastgram/core";
import type { ModelRegistry } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { MediaImportDeps } from "./handler.js";
import { createMediaImportProviders } from "./providers.js";

export type MediaImportMount =
  | {
      readonly kind: "mounted";
      readonly deps: Pick<
        MediaImportDeps,
        "downloader" | "inspector" | "chroma" | "backgroundRemoval" | "tagger"
      >;
      readonly ytDlpVersion: string;
    }
  | { readonly kind: "unmounted"; readonly why: string };

export interface MediaImportMountConfig {
  readonly env: SecretEnv;
  readonly registry: ModelRegistry;
  readonly logger: BuildLogger;
}

async function version(binary: string, args: string[]): Promise<string | null> {
  const r = await runProcess(binary, args, {
    timeoutMs: 15_000,
    maxStdoutBytes: 64 * 1024,
    env: minimalChildEnv(),
  });
  if (r.exitCode !== 0) return null;
  return r.stdout.split(/\r?\n/)[0]?.trim() ?? "";
}

export async function mountMediaImport(
  config: MediaImportMountConfig,
): Promise<MediaImportMount> {
  const ytdlp = config.env["YTDLP_PATH"]?.trim() || "yt-dlp";
  const ffmpeg = config.env["FFMPEG_PATH"]?.trim() || "ffmpeg";
  const ffprobe = config.env["FFPROBE_PATH"]?.trim() || "ffprobe";

  const [yv, fv, pv] = await Promise.all([
    version(ytdlp, ["--version"]),
    version(ffmpeg, ["-version"]),
    version(ffprobe, ["-version"]),
  ]);
  const missing = [
    ...(yv === null ? [`yt-dlp (${ytdlp}; YTDLP_PATH)`] : []),
    ...(fv === null ? [`ffmpeg (${ffmpeg}; FFMPEG_PATH)`] : []),
    ...(pv === null ? [`ffprobe (${ffprobe}; FFPROBE_PATH)`] : []),
  ];
  if (missing.length > 0 || yv === null) {
    return {
      kind: "unmounted",
      why:
        `no responden ${missing.join(", ")}: los imports por link quedan \`queued\` ` +
        "hasta que un worker con esas herramientas los tome",
    };
  }

  const inspector = new FfmpegClipInspector({ ffmpeg, ffprobe });
  const providers = createMediaImportProviders({
    registry: config.registry,
    secrets: config.env,
    logger: config.logger,
  });
  return {
    kind: "mounted",
    ytDlpVersion: yv,
    deps: {
      downloader: new YtDlpDownloader({
        binary: ytdlp,
        // Si FFmpeg no está en el PATH, `yt-dlp` no podría unir las pistas.
        ...(ffmpeg === "ffmpeg" ? {} : { ffmpegLocation: ffmpeg }),
      }),
      inspector,
      chroma: new ChromaKeyBackgroundRemoval({ inspector, verdict: greenScreenVerdict }),
      backgroundRemoval: () => providers.backgroundRemoval(),
      tagger: () => providers.tagger(),
    },
  };
}
