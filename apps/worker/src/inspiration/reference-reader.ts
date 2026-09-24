/**
 * Leer una referencia **sin login y sin bajar el video** — Inspiration de uso
 * personal (`F-041`, `P2-TREND-002`/`003`, `D-13`).
 *
 * Una sola pasada de `yt-dlp`:
 *
 * ```
 * yt-dlp --no-config --no-playlist --no-warnings --no-progress
 *        --socket-timeout 30
 *        --no-simulate --skip-download
 *        --write-thumbnail --convert-thumbnails jpg -o <tmp>/thumb.%(ext)s
 *        --dump-single-json -- <url>
 * ```
 *
 * `--dump-single-json` implica `--simulate`; `--no-simulate` +
 * `--skip-download` hace que escriba **sólo** la miniatura y siga imprimiendo
 * el JSON (verificado con yt-dlp 2026.08.19 contra YouTube el 2026-09-24).
 * `--convert-thumbnails jpg` usa FFmpeg: el modelo de visión recibe la imagen
 * como `data:image/jpeg` (`OpenAiVisionTagger`), y YouTube a veces la da en
 * webp.
 *
 * ## Las mismas garantías que el import por link
 *
 * Mismo criterio que `YtDlpDownloader` (`packages/adapters`): proceso hijo sin
 * shell con la URL detrás de `--`, `--no-config`, entorno mínimo, timeout duro
 * que mata al grupo, stdout acotado, y el host resuelto antes de lanzar para no
 * hablar con la red local. El stderr **nunca** sale: se usa para elegir un
 * código estable y se descarta.
 *
 * Esto vive en el worker y no en `packages/adapters` porque ese paquete no es
 * de esta tarea; usa sus primitivas exportadas (`runProcess`,
 * `minimalChildEnv`, `classifyAddress`). Si mañana lo usa otro, se muda.
 */
import { lookup } from "node:dns/promises";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  classifyAddress,
  minimalChildEnv,
  runProcess,
  type ProcessRunner,
} from "@fastgram/adapters";
import type { MediaImportFailureCode } from "@fastgram/ports";

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

const systemResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

/** El JSON de YouTube ronda los 2–5 MB; mismo tope que el downloader. */
const MAX_INFO_JSON_BYTES = 32 * 1024 * 1024;

export type ReferenceReadOutcome =
  | {
      readonly ok: true;
      /** El JSON de `yt-dlp`, ya parseado. Texto de terceros: dato. */
      readonly info: unknown;
      /** La miniatura, si el sitio tenía y cupo. */
      readonly thumbnail: {
        readonly body: Uint8Array;
        readonly extension: string;
      } | null;
    }
  | { readonly ok: false; readonly code: MediaImportFailureCode };

export interface ReferenceReader {
  read(request: {
    readonly url: string;
    /** Temporal **de quien llama**; se escribe sólo ahí adentro. */
    readonly directory: string;
    readonly timeoutMs: number;
    readonly maxThumbnailBytes: number;
  }): Promise<ReferenceReadOutcome>;
}

export interface YtDlpReferenceReaderConfig {
  readonly binary?: string;
  readonly ffmpegLocation?: string;
  /** Sólo tests. */
  readonly run?: ProcessRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly resolveHost?: HostResolver;
}

function classifyFailure(stderr: string): MediaImportFailureCode {
  if (/Unsupported URL/i.test(stderr)) return "unsupported_url";
  if (/Unable to extract|no video formats found|No video could be found/i.test(stderr)) {
    return "unsupported_url";
  }
  return "download_failed";
}

const THUMB_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

export class YtDlpReferenceReader implements ReferenceReader {
  readonly #binary: string;
  readonly #ffmpegLocation: string | undefined;
  readonly #run: ProcessRunner;
  readonly #env: NodeJS.ProcessEnv;
  readonly #resolve: HostResolver;

  constructor(config: YtDlpReferenceReaderConfig = {}) {
    this.#binary = config.binary ?? "yt-dlp";
    this.#ffmpegLocation = config.ffmpegLocation;
    this.#run = config.run ?? runProcess;
    this.#env = config.env ?? minimalChildEnv();
    this.#resolve = config.resolveHost ?? systemResolver;
  }

  /** `true` = apunta adentro; `null` = no resolvió. Ver `YtDlpDownloader`. */
  async #pointsInside(url: string): Promise<boolean | null> {
    let hostname: string;
    try {
      hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return true;
    }
    let addresses: readonly string[];
    try {
      addresses = await this.#resolve(hostname);
    } catch {
      return null;
    }
    return addresses.length === 0 || addresses.some((a) => classifyAddress(a) !== null);
  }

  async read(request: {
    readonly url: string;
    readonly directory: string;
    readonly timeoutMs: number;
    readonly maxThumbnailBytes: number;
  }): Promise<ReferenceReadOutcome> {
    const fail = (code: MediaImportFailureCode): ReferenceReadOutcome => ({
      ok: false,
      code,
    });
    const inside = await this.#pointsInside(request.url);
    if (inside === null) return fail("download_failed");
    if (inside) return fail("unsupported_url");

    const run = await this.#run(
      this.#binary,
      [
        "--no-config",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--socket-timeout",
        "30",
        ...(this.#ffmpegLocation === undefined
          ? []
          : ["--ffmpeg-location", this.#ffmpegLocation]),
        "--no-simulate",
        "--skip-download",
        "--write-thumbnail",
        "--convert-thumbnails",
        "jpg",
        "-o",
        path.join(request.directory, "thumb.%(ext)s"),
        "--dump-single-json",
        "--",
        request.url,
      ],
      {
        timeoutMs: request.timeoutMs,
        maxStdoutBytes: MAX_INFO_JSON_BYTES,
        env: this.#env,
      },
    );
    if (run.spawnError !== null || run.timedOut || run.stdoutOverflow) {
      return fail("download_failed");
    }
    if (run.exitCode !== 0) return fail(classifyFailure(run.stderrTail));

    let info: unknown;
    try {
      info = JSON.parse(run.stdout) as unknown;
    } catch {
      return fail("download_failed");
    }
    if (typeof info !== "object" || info === null) return fail("download_failed");
    return { ok: true, info, thumbnail: await this.#thumbnail(request) };
  }

  /** La miniatura que dejó `yt-dlp`, **sólo si está dentro del temporal** y cabe. */
  async #thumbnail(request: {
    readonly directory: string;
    readonly maxThumbnailBytes: number;
  }): Promise<{ body: Uint8Array; extension: string } | null> {
    try {
      const root = await realpath(request.directory);
      const entries = await readdir(root);
      const name = entries.find((e) => {
        const ext = path.extname(e).slice(1).toLowerCase();
        return e.startsWith("thumb.") && THUMB_EXTENSIONS.has(ext);
      });
      if (name === undefined) return null;
      const file = await realpath(path.join(root, name));
      if (!file.startsWith(root + path.sep)) return null;
      const size = (await stat(file)).size;
      if (size === 0 || size > request.maxThumbnailBytes) return null;
      const extension = path.extname(file).slice(1).toLowerCase();
      return {
        body: new Uint8Array(await readFile(file)),
        extension: extension === "jpeg" ? "jpg" : extension,
      };
    } catch {
      return null;
    }
  }
}
