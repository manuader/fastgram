/**
 * Transcripción para los subtítulos del reel: audio → palabras con tiempo.
 *
 * Dos motores, los dos locales y sin red:
 *  · `whisper`  — `whisper-cli` (whisper.cpp) con un modelo ggml. Multilingüe
 *    con un modelo sin `.en` (`ggml-small.bin`, `ggml-base.bin`). Salida
 *    `-ojf`: tokens con `offsets.from/to` en ms.
 *  · `parakeet` — `parakeet-mlx` (Apple Silicon). v2 es sólo inglés; v3 suma
 *    25 idiomas europeos. Salida JSON con tokens `start/end` en segundos.
 *
 * Por qué no `hyperframes transcribe`: descarga su modelo la primera vez
 * (red en un render) y con `--engine parakeet` pide la v3 aunque la máquina
 * tenga otra. Acá el modelo es configuración: si no hay, el reel sale sin
 * subtítulos y con un aviso, no falla (medido: esta Mac no tenía ningún ggml
 * real, sólo el `for-tests-ggml-tiny.bin` del paquete de brew).
 *
 * Los dos motores devuelven sub-palabras ("St", "op"); se unen por el espacio
 * inicial, que es como los dos marcan el comienzo de palabra.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CacheStore } from "../cache/store.js";
import { runFfmpeg } from "../ffmpeg/run.js";
import { fileSha256 } from "./chroma.js";

const execFileAsync = promisify(execFile);

export interface AsrWord {
  readonly text: string;
  /** Segundos desde el inicio del ARCHIVO (no del reel). */
  readonly start: number;
  readonly end: number;
}

export interface AsrToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export type AsrEngine = "none" | "whisper" | "parakeet";

export interface AsrConfig {
  readonly engine: AsrEngine;
  readonly bin: string;
  /** Ruta al `.bin` (whisper) o repo de HF ya en cache (parakeet). */
  readonly model: string | null;
  readonly timeoutMs: number;
}

export const ASR_TIMEOUT_MS = 180_000;

/** Tokens del motor → palabras. Pura: la fija el test. */
export function tokensToWords(tokens: readonly AsrToken[]): AsrWord[] {
  const words: { text: string; start: number; end: number }[] = [];
  for (const token of tokens) {
    const raw = token.text;
    // Tokens especiales de whisper (`[_BEG_]`, `[_TT_150]`, `<|endoftext|>`).
    if (/^\s*\[_.*_?\]\s*$/.test(raw) || /^\s*<\|.*\|>\s*$/.test(raw)) continue;
    if (raw.trim() === "") continue;
    const startsWord = /^\s/.test(raw) || words.length === 0;
    const last = words[words.length - 1];
    const isPunctuation = !/[\p{L}\p{N}]/u.test(raw);
    if (!startsWord && last !== undefined) {
      last.text += raw;
      last.end = Math.max(last.end, token.end);
    } else if (isPunctuation && last !== undefined) {
      // Un "." suelto se pega a la palabra anterior: no es un renglón.
      last.text += raw.trim();
      last.end = Math.max(last.end, token.end);
    } else {
      words.push({ text: raw.trim(), start: token.start, end: token.end });
    }
  }
  return words
    .filter((w) => /[\p{L}\p{N}]/u.test(w.text))
    .map((w) => ({
      text: w.text.slice(0, 40),
      start: Math.round(w.start * 1000) / 1000,
      end: Math.round(Math.max(w.end, w.start + 0.05) * 1000) / 1000,
    }));
}

interface WhisperJson {
  transcription?: {
    tokens?: { text?: string; offsets?: { from?: number; to?: number } }[];
  }[];
}

export function parseWhisperJson(json: WhisperJson): AsrToken[] {
  const out: AsrToken[] = [];
  for (const segment of json.transcription ?? []) {
    for (const t of segment.tokens ?? []) {
      if (typeof t.text !== "string") continue;
      const from = t.offsets?.from;
      const to = t.offsets?.to;
      if (typeof from !== "number" || typeof to !== "number") continue;
      out.push({ text: t.text, start: from / 1000, end: to / 1000 });
    }
  }
  return out;
}

interface ParakeetJson {
  sentences?: { tokens?: { text?: string; start?: number; end?: number }[] }[];
}

export function parseParakeetJson(json: ParakeetJson): AsrToken[] {
  const out: AsrToken[] = [];
  for (const sentence of json.sentences ?? []) {
    for (const t of sentence.tokens ?? []) {
      if (
        typeof t.text !== "string" ||
        typeof t.start !== "number" ||
        typeof t.end !== "number"
      ) {
        continue;
      }
      out.push({ text: t.text, start: t.start, end: t.end });
    }
  }
  return out;
}

export function asrAvailable(
  config: AsrConfig,
): { ok: true } | { ok: false; reason: string } {
  if (config.engine === "none")
    return { ok: false, reason: "ASR disabled (RENDER_REEL_ASR_ENGINE=none)" };
  if (config.model === null) {
    return {
      ok: false,
      reason: `no ${config.engine} model configured (RENDER_REEL_ASR_MODEL)`,
    };
  }
  return { ok: true };
}

/**
 * Transcribe el audio de un archivo local. `language` ISO 639-1 o `null`
 * (autodetección). Cachea el resultado por hash del archivo + motor + modelo +
 * idioma. Tira si el motor falla: quien llama decide (el render lo convierte
 * en aviso y sigue sin subtítulos).
 */
export async function transcribe(
  localPath: string,
  language: string | null,
  config: AsrConfig,
  cache: CacheStore,
  workDir: string,
): Promise<{ words: AsrWord[]; cache: "hit" | "miss" }> {
  const available = asrAvailable(config);
  if (!available.ok) throw new Error(available.reason);
  const digest = await fileSha256(localPath);
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        digest,
        engine: config.engine,
        model: config.model,
        language,
      }),
    )
    .digest("hex");
  const hit = await cache.get(key, "json");
  if (hit !== null) {
    return {
      words: JSON.parse(await readFile(hit.path, "utf8")) as AsrWord[],
      cache: "hit",
    };
  }

  const stem = `asr-${key.slice(0, 16)}`;
  const wav = path.join(workDir, `${stem}.wav`);
  await runFfmpeg(
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      localPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      wav,
    ],
    { expectOutput: wav },
  );

  let tokens: AsrToken[];
  if (config.engine === "whisper") {
    const outBase = path.join(workDir, stem);
    await execFileAsync(
      config.bin,
      [
        "-m",
        config.model as string,
        "-f",
        wav,
        "-l",
        language ?? "auto",
        "-ojf",
        "-of",
        outBase,
        "-np",
      ],
      { timeout: config.timeoutMs, maxBuffer: 16_000_000 },
    );
    tokens = parseWhisperJson(
      JSON.parse(await readFile(`${outBase}.json`, "utf8")) as WhisperJson,
    );
  } else {
    const outDir = path.join(workDir, `${stem}-out`);
    await execFileAsync(
      config.bin,
      [
        wav,
        "--model",
        config.model as string,
        "--output-format",
        "json",
        "--output-dir",
        outDir,
      ],
      // Sin red: el modelo tiene que estar en la cache de HF.
      {
        timeout: config.timeoutMs,
        maxBuffer: 16_000_000,
        env: { ...process.env, HF_HUB_OFFLINE: "1" },
      },
    );
    const files = (await readdir(outDir)).filter((f) => f.endsWith(".json"));
    const first = files[0];
    if (first === undefined) throw new Error("parakeet wrote no JSON");
    tokens = parseParakeetJson(
      JSON.parse(await readFile(path.join(outDir, first), "utf8")) as ParakeetJson,
    );
  }
  const words = tokensToWords(tokens);
  await cache.putBuffer(key, "json", Buffer.from(JSON.stringify(words)));
  return { words, cache: "miss" };
}
