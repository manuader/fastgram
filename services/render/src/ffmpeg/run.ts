/**
 * Ejecución de ffmpeg con dos garantías que el resto del servicio da por hechas:
 *
 *  1. **El código de salida 0 no alcanza.** Es la trampa de
 *     `services/vision/app/frames.py`: ffmpeg puede salir con 0 y no escribir
 *     nada. Acá, después de cada corrida, se verifica que el archivo exista y
 *     tenga tamaño > 0; si no, `render_empty_output`.
 *  2. **El stderr crudo no sale hacia afuera.** Se traduce a un código estable
 *     (regla del repo, IMPL §4). El texto original va en `cause`, que sólo se
 *     loguea del lado del servidor.
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { RenderError, type RenderErrorCode } from "../errors.js";
import { FFMPEG_BIN } from "./capabilities.js";

export interface RunOptions {
  /** Archivo que la corrida debe dejar escrito y no vacío. */
  readonly expectOutput?: string;
  readonly timeoutMs?: number;
  readonly bin?: string;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly outputBytes: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
const STDERR_CAP = 64_000;

/**
 * Patrones de stderr → código estable. El orden importa: gana el primero.
 * La lista se mantiene corta a propósito; lo que no matchea es `render_failed`.
 */
const STDERR_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly code: RenderErrorCode;
}[] = [
  {
    pattern: /No such filter|Filter not found|Unknown filter/i,
    code: "render_capability_missing",
  },
  { pattern: /Unknown encoder|Encoder .* not found/i, code: "render_capability_missing" },
  {
    pattern: /Invalid data found when processing input/i,
    code: "unsupported_media_format",
  },
  {
    pattern: /Decoder .* not found|Unsupported codec/i,
    code: "unsupported_media_format",
  },
  { pattern: /moov atom not found/i, code: "unsupported_media_format" },
  {
    pattern: /No such file or directory|Protocol not found/i,
    code: "media_probe_failed",
  },
  { pattern: /Server returned 40\d|HTTP error 40\d/i, code: "media_probe_failed" },
];

export function classifyStderr(stderr: string): RenderErrorCode {
  for (const entry of STDERR_PATTERNS) {
    if (entry.pattern.test(stderr)) return entry.code;
  }
  return "render_failed";
}

function tail(text: string, limit = STDERR_CAP): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

export async function runFfmpeg(
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const bin = options.bin ?? FFMPEG_BIN;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { code, signal, stdout, stderr, timedOut } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out = tail(out + chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      err = tail(err + chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, exitSignal) => {
      clearTimeout(timer);
      resolve({
        code: exitCode,
        signal: exitSignal,
        stdout: out,
        stderr: err,
        timedOut: killedByTimeout,
      });
    });
  }).catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/ENOENT/.test(message)) {
      throw new RenderError("ffmpeg_unavailable", "no se pudo ejecutar ffmpeg", {
        cause,
      });
    }
    throw new RenderError("render_failed", "no se pudo ejecutar ffmpeg", { cause });
  });

  if (timedOut) {
    throw new RenderError("render_timeout", "el render excedió el tiempo permitido", {
      details: { timeoutMs },
      cause: stderr,
    });
  }

  if (code !== 0) {
    throw new RenderError(classifyStderr(stderr), "el render falló", {
      details: { exitCode: code, signal },
      cause: stderr,
    });
  }

  // La verificación que importa: código 0 no prueba que haya salida.
  let outputBytes = 0;
  if (options.expectOutput !== undefined) {
    outputBytes = await assertNonEmptyOutput(options.expectOutput, stderr);
  }

  return { stdout, stderr, outputBytes };
}

/**
 * Falla con `render_empty_output` si el archivo no existe o pesa 0 bytes.
 * Exportada porque el pipeline de sharp necesita la misma garantía.
 */
export async function assertNonEmptyOutput(
  path: string,
  diagnostic = "",
): Promise<number> {
  let size: number;
  try {
    const stats = await stat(path);
    size = stats.size;
  } catch (cause) {
    throw new RenderError(
      "render_empty_output",
      "el render terminó sin error pero no escribió el archivo de salida",
      { details: { path }, cause: diagnostic || cause },
    );
  }
  if (size <= 0) {
    throw new RenderError(
      "render_empty_output",
      "el render terminó sin error pero el archivo de salida está vacío",
      { details: { path, bytes: size }, cause: diagnostic },
    );
  }
  return size;
}
