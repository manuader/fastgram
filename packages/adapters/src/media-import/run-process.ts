/**
 * Correr un binario como proceso hijo **sin shell** — `PU-MEME-001`.
 *
 * Tres garantías que el resto del paquete da por sentadas:
 *
 * 1. **Sin shell, argumentos como array.** La URL que pega el usuario viaja
 *    como un elemento de `args` y nunca se interpola en un string: no hay
 *    comillas que escapar porque no hay intérprete que las lea.
 * 2. **Timeout duro que mata al grupo.** `yt-dlp` lanza FFmpeg como nieto para
 *    unir video y audio. Matar sólo al hijo deja al nieto escribiendo en un
 *    directorio que el llamador está por borrar. Se lanza en su propio grupo
 *    (`detached`) y el timeout manda `SIGKILL` a `-pid`.
 * 3. **Salida acotada.** El JSON de `--dump-single-json` de YouTube pesa
 *    varios MB; se corta en `maxStdoutBytes` y del stderr se guarda sólo la
 *    cola, que es donde está el motivo del error. Nada de esto sale por la API:
 *    se usa para clasificar el fallo.
 */
import { spawn } from "node:child_process";

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  /** El mismo stdout sin decodificar, para salidas binarias (cuadros de FFmpeg). */
  readonly stdoutBytes: Buffer;
  /** Los últimos bytes del stderr. Sólo para clasificar y para el log. */
  readonly stderrTail: string;
  readonly timedOut: boolean;
  /** El stdout superó el tope: el proceso se mató. */
  readonly stdoutOverflow: boolean;
  /** No se pudo lanzar (binario inexistente, sin permiso). */
  readonly spawnError: string | null;
}

export interface RunProcessOptions {
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

const STDERR_TAIL_BYTES = 8 * 1024;

export type ProcessRunner = (
  binary: string,
  args: readonly string[],
  options: RunProcessOptions,
) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = (binary, args, options) =>
  new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const child = spawn(binary, [...args], {
      shell: false,
      detached: true,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // El grupo ya terminó: nada que matar.
        try {
          child.kill("SIGKILL");
        } catch {
          /* ya muerto */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      if (stdoutLength + chunk.length > options.maxStdoutBytes) {
        overflow = true;
        killGroup();
        return;
      }
      stdoutChunks.push(chunk);
      stdoutLength += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > STDERR_TAIL_BYTES) {
        stderr = stderr.subarray(stderr.length - STDERR_TAIL_BYTES);
      }
    });

    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        stdout: "",
        stdoutBytes: Buffer.alloc(0),
        stderrTail: "",
        timedOut: false,
        stdoutOverflow: false,
        spawnError: error.message,
      });
    });
    child.on("close", (exitCode, signal) => {
      const stdout = Buffer.concat(stdoutChunks);
      finish({
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stdoutBytes: stdout,
        stderrTail: stderr.toString("utf8"),
        timedOut,
        stdoutOverflow: overflow,
        spawnError: null,
      });
    });
  });

/**
 * El entorno del hijo: lo mínimo para que encuentre sus binarios y su
 * directorio temporal. **No** el del worker, que tiene `DATABASE_URL`, las
 * keys de S3 y las de los proveedores: un extractor de `yt-dlp` o un plugin no
 * tiene por qué verlas.
 */
export function minimalChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
