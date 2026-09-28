/**
 * Montar `library-import` — sprint 9 (agente N).
 *
 * Se monta **sólo si FFmpeg y ffprobe responden** al arrancar (trampa 30):
 * sin ellos, cada asset terminaría `failed` por algo que no es del archivo.
 * Sin montar, la fila queda `processing` y el job espera, que es verdad.
 * No necesita `yt-dlp`: las fuentes de la biblioteca dan el archivo directo.
 *
 * Los binarios salen de `FFMPEG_PATH` y `FFPROBE_PATH` (los mismos que
 * `media-import`). El etiquetador se relee del registro de modelos en cada
 * job (`tagger.ts`).
 */
import { FfmpegClipInspector, minimalChildEnv, runProcess } from "@fastgram/adapters";
import type { SecretEnv } from "@fastgram/core";
import type { ModelRegistry } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { LibraryImportDeps } from "./handler.js";
import { createMediaTools } from "./media-tools.js";
import { createLibraryTaggerProvider } from "./tagger.js";

export type LibraryImportMount =
  | {
      readonly kind: "mounted";
      readonly deps: Pick<
        LibraryImportDeps,
        "tools" | "inspector" | "tagger" | "userAgent"
      >;
    }
  | { readonly kind: "unmounted"; readonly why: string };

export interface LibraryImportMountConfig {
  readonly env: SecretEnv;
  readonly registry: ModelRegistry;
  readonly logger: BuildLogger;
}

async function responds(binary: string): Promise<boolean> {
  const r = await runProcess(binary, ["-version"], {
    timeoutMs: 15_000,
    maxStdoutBytes: 64 * 1024,
    env: minimalChildEnv(),
  });
  return r.exitCode === 0;
}

export async function mountLibraryImport(
  config: LibraryImportMountConfig,
): Promise<LibraryImportMount> {
  const ffmpeg = config.env["FFMPEG_PATH"]?.trim() || "ffmpeg";
  const ffprobe = config.env["FFPROBE_PATH"]?.trim() || "ffprobe";
  const [f, p] = await Promise.all([responds(ffmpeg), responds(ffprobe)]);
  if (!f || !p) {
    const missing = [
      ...(f ? [] : [`ffmpeg (${ffmpeg}; FFMPEG_PATH)`]),
      ...(p ? [] : [`ffprobe (${ffprobe}; FFPROBE_PATH)`]),
    ];
    return {
      kind: "unmounted",
      why: `no responden ${missing.join(", ")}: los assets de la biblioteca quedan \`processing\``,
    };
  }
  // Wikimedia pide un User-Agent con contacto: el dueño puede poner el suyo.
  const userAgent = config.env["LIBRARY_USER_AGENT"]?.trim();
  return {
    kind: "mounted",
    deps: {
      tools: createMediaTools({ ffmpeg, ffprobe }),
      inspector: new FfmpegClipInspector({ ffmpeg, ffprobe }),
      tagger: createLibraryTaggerProvider({
        registry: config.registry,
        secrets: config.env,
        logger: config.logger,
      }),
      ...(userAgent === undefined || userAgent === "" ? {} : { userAgent }),
    },
  };
}
