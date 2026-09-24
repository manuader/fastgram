/**
 * `MediaDownloader` sobre `yt-dlp` — `PU-MEME-001`, D-12.
 *
 * `yt-dlp` no se auditó línea por línea (son cientos de extractores): se confía
 * en la procedencia, un binario de la release oficial instalado por Homebrew
 * (`docs/AUDITORIA-SCRAPERS.md`). Lo que sí controla este adaptador es **cómo**
 * se lo llama:
 *
 * - como proceso hijo, **sin shell**, con la URL como un argumento más y
 *   detrás de `--` (una URL que empieza con `-` no se lee como opción);
 * - con `--no-config`: ningún archivo de configuración del usuario agrega
 *   opciones (un `--exec` en `~/.config/yt-dlp/config` correría en cada import);
 * - con el entorno mínimo (`minimalChildEnv`), sin las keys del worker;
 * - con un timeout duro que mata también al FFmpeg que lanza para unir pistas.
 *
 * ## Dos pasadas
 *
 * 1. `--dump-single-json`: sin bajar nada, dice si es un live, una playlist,
 *    cuánto dura y (a veces) cuánto pesa. Los topes se deciden acá, antes de
 *    gastar ancho de banda, con un código que el usuario entiende.
 * 2. La bajada, con `--load-info-json` (el mismo video que se midió),
 *    `--max-filesize` y `--match-filters` como segunda red: el sitio puede no
 *    declarar duración ni tamaño en la primera pasada.
 *
 * Si `yt-dlp` sale bien **sin archivo**, lo saltó un filtro. Como la duración
 * conocida ya se chequeó en la pasada 1, lo que queda es el tamaño
 * (`--max-filesize`): `too_large`. Con `--print` activo `yt-dlp` es silencioso
 * y no dice cuál de los dos fue; es la inferencia menos mala.
 *
 * ## Lo que nunca sale
 *
 * El stderr. Se usa para distinguir `unsupported_url` («Unsupported URL») de
 * `download_failed` y se descarta; el llamador recibe sólo el código.
 */
import { lookup } from "node:dns/promises";
import { readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DownloadedClip,
  MediaDownloadOutcome,
  MediaDownloadRequest,
  MediaDownloader,
  MediaImportFailureCode,
} from "@fastgram/ports";

import { classifyAddress } from "../social-reader/website-ssrf.js";
import { minimalChildEnv, runProcess, type ProcessRunner } from "./run-process.js";

/** Resuelve un host a todas sus direcciones. Inyectable para tests sin red. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

const systemResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

export interface YtDlpDownloaderConfig {
  /** Ruta del binario. Default `yt-dlp` (el del `PATH`). Ver `YTDLP_PATH` del worker. */
  readonly binary?: string;
  /** `--ffmpeg-location`, si el FFmpeg no está en el `PATH` del hijo. */
  readonly ffmpegLocation?: string;
  /** Sólo tests. */
  readonly run?: ProcessRunner;
  /** Sólo tests: el entorno del hijo. */
  readonly env?: NodeJS.ProcessEnv;
  /** Sólo tests: la resolución DNS del chequeo de red local. */
  readonly resolveHost?: HostResolver;
}

/** El JSON de YouTube ronda los 2–5 MB; 32 MB es margen sin dejar que crezca sin tope. */
const MAX_INFO_JSON_BYTES = 32 * 1024 * 1024;
/** La bajada sólo imprime la ruta final. */
const MAX_DOWNLOAD_STDOUT_BYTES = 64 * 1024;
const MAX_TITLE = 200;

/**
 * Formatos. Video: H.264 + AAC en MP4 si existe (no hay que transcodificar
 * después), si no lo mejor que haya, **remuxado** a MP4. La normalización del
 * Media Bank (`media-normalization`) se encarga del resto como con cualquier
 * video subido. Audio: m4a si existe, si no se extrae a m4a.
 */
const VIDEO_FORMAT =
  "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/bv*+ba/b";
const AUDIO_FORMAT = "ba[ext=m4a]/ba[ext=mp3]/ba/b";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
};

interface InfoJson {
  readonly _type?: unknown;
  readonly is_live?: unknown;
  readonly live_status?: unknown;
  readonly duration?: unknown;
  readonly filesize?: unknown;
  readonly filesize_approx?: unknown;
  readonly title?: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

function classifyFailure(stderr: string): MediaImportFailureCode {
  // Los mensajes de `yt-dlp` para «ningún extractor la reconoce». El genérico
  // (`generic`) intenta cualquier página y, si no encuentra un video, cae en el
  // segundo.
  if (/Unsupported URL/i.test(stderr)) return "unsupported_url";
  if (/Unable to extract|no video formats found|No video could be found/i.test(stderr)) {
    return "unsupported_url";
  }
  if (/larger than max-filesize/i.test(stderr)) return "too_large";
  return "download_failed";
}

export class YtDlpDownloader implements MediaDownloader {
  readonly #binary: string;
  readonly #ffmpegLocation: string | undefined;
  readonly #run: ProcessRunner;
  readonly #env: NodeJS.ProcessEnv;
  readonly #resolve: HostResolver;

  constructor(config: YtDlpDownloaderConfig = {}) {
    this.#binary = config.binary ?? "yt-dlp";
    this.#ffmpegLocation = config.ffmpegLocation;
    this.#run = config.run ?? runProcess;
    this.#env = config.env ?? minimalChildEnv();
    this.#resolve = config.resolveHost ?? systemResolver;
  }

  /**
   * ¿El host resuelve a la red local? `core` ya rechaza hosts e IPs privadas
   * **escritas** en la URL; esto cubre el nombre público que apunta adentro
   * (`127.0.0.1.nip.io`). No cierra el DNS rebinding —`yt-dlp` vuelve a
   * resolver por su cuenta, y los redirects tampoco pasan por acá—: es un
   * filtro, no una frontera. Mismo clasificador que el extractor de webs.
   */
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

  #common(): string[] {
    return [
      "--no-config",
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--socket-timeout",
      "30",
      ...(this.#ffmpegLocation === undefined
        ? []
        : ["--ffmpeg-location", this.#ffmpegLocation]),
    ];
  }

  async download(request: MediaDownloadRequest): Promise<MediaDownloadOutcome> {
    const started = Date.now();
    const remaining = (): number =>
      Math.max(1_000, request.timeoutMs - (Date.now() - started));
    const fail = (code: MediaImportFailureCode): MediaDownloadOutcome => ({
      ok: false,
      code,
    });

    const inside = await this.#pointsInside(request.url);
    if (inside === null) return fail("download_failed");
    if (inside) return fail("unsupported_url");

    // ── 1. Medir sin bajar ──
    const probe = await this.#run(
      this.#binary,
      [...this.#common(), "--dump-single-json", "--", request.url],
      { timeoutMs: remaining(), maxStdoutBytes: MAX_INFO_JSON_BYTES, env: this.#env },
    );
    if (probe.spawnError !== null || probe.timedOut || probe.stdoutOverflow) {
      return fail("download_failed");
    }
    if (probe.exitCode !== 0) return fail(classifyFailure(probe.stderrTail));

    let info: InfoJson;
    try {
      const parsed: unknown = JSON.parse(probe.stdout);
      if (typeof parsed !== "object" || parsed === null) return fail("download_failed");
      info = parsed as InfoJson;
    } catch {
      return fail("download_failed");
    }
    // Una playlist (o un canal) aunque se pidió `--no-playlist`: el link no es
    // de un clip. Un live no termina nunca.
    if (info._type === "playlist" || info._type === "multi_video") {
      return fail("unsupported_url");
    }
    if (
      info.is_live === true ||
      info.live_status === "is_live" ||
      info.live_status === "is_upcoming"
    ) {
      return fail("unsupported_url");
    }
    const declaredDuration = num(info.duration);
    if (declaredDuration !== null && declaredDuration > request.maxDurationSeconds) {
      return fail("too_long");
    }
    const declaredSize = num(info.filesize) ?? num(info.filesize_approx);
    if (declaredSize !== null && declaredSize > request.maxBytes)
      return fail("too_large");

    const infoPath = path.join(request.directory, "info.json");
    await writeFile(infoPath, probe.stdout, { mode: 0o600 });

    // ── 2. Bajar ──
    const isVideo = request.kind === "video";
    const args = [
      ...this.#common(),
      "--load-info-json",
      infoPath,
      "--max-filesize",
      String(request.maxBytes),
      // Segunda red para lo que la pasada 1 no supo: `<=?` deja pasar la
      // duración desconocida (se mide después con el inspector).
      "--match-filters",
      `!is_live & duration <=? ${request.maxDurationSeconds}`,
      "-f",
      isVideo ? VIDEO_FORMAT : AUDIO_FORMAT,
      ...(isVideo
        ? ["--merge-output-format", "mp4", "--remux-video", "mp4"]
        : ["-x", "--audio-format", "m4a"]),
      "--restrict-filenames",
      "--no-mtime",
      "-o",
      path.join(request.directory, "clip.%(ext)s"),
      "--print",
      "after_move:filepath",
    ];
    const run = await this.#run(this.#binary, args, {
      timeoutMs: remaining(),
      maxStdoutBytes: MAX_DOWNLOAD_STDOUT_BYTES,
      env: this.#env,
    });
    if (run.spawnError !== null || run.timedOut || run.stdoutOverflow) {
      return fail("download_failed");
    }
    if (run.exitCode !== 0) return fail(classifyFailure(run.stderrTail));

    const printed = run.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .at(-1);
    const file = await this.#locate(request.directory, printed);
    if (file === null) return fail("too_large");

    const extension = path.extname(file).slice(1).toLowerCase();
    const contentType = CONTENT_TYPES[extension];
    if (contentType === undefined) return fail("download_failed");
    if (isVideo !== contentType.startsWith("video/")) return fail("download_failed");
    const size = (await stat(file)).size;
    if (size > request.maxBytes) return fail("too_large");
    if (size === 0) return fail("download_failed");

    const title =
      typeof info.title === "string" && info.title.trim().length > 0
        ? info.title.trim().slice(0, MAX_TITLE)
        : null;
    const clip: DownloadedClip = {
      path: file,
      contentType,
      extension,
      sizeBytes: size,
      durationSeconds: declaredDuration,
      title,
    };
    return { ok: true, clip };
  }

  /**
   * La ruta final, **sólo si está dentro del directorio pedido**. Lo que imprime
   * `yt-dlp` es salida de un proceso de terceros: no se abre un archivo fuera
   * del temporal porque lo diga el stdout.
   */
  async #locate(directory: string, printed: string | undefined): Promise<string | null> {
    const root = await realpath(directory);
    const inside = async (candidate: string): Promise<string | null> => {
      try {
        const real = await realpath(candidate);
        return real.startsWith(root + path.sep) ? real : null;
      } catch {
        return null;
      }
    };
    if (printed !== undefined) {
      const found = await inside(path.resolve(directory, printed));
      if (found !== null) return found;
    }
    // Sin línea impresa: el `clip.*` que haya quedado (ni `.part` ni el JSON).
    const entries = await readdir(root);
    const clip = entries.find(
      (e) => e.startsWith("clip.") && !e.endsWith(".part") && !e.endsWith(".json"),
    );
    return clip === undefined ? null : inside(path.join(root, clip));
  }
}
