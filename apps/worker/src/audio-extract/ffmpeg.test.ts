/**
 * `FfmpegAudioExtractor`: los argumentos, y —si la máquina tiene FFmpeg— una
 * extracción de verdad sobre un video sintético con y sin audio. Sin FFmpeg,
 * la parte real se saltea (lo dice el nombre del test).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FfmpegAudioExtractor, extractArgs } from "./ffmpeg.js";

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG = hasFfmpeg();

describe("extractArgs", () => {
  it("sólo la primera pista de audio, AAC en MP4, cortada al tope", () => {
    const args = extractArgs("/in", "/out.m4a", 300);
    expect(args).toEqual(expect.arrayContaining(["-map", "0:a:0", "-vn", "-c:a", "aac"]));
    expect(args[args.indexOf("-t") + 1]).toBe("300");
    expect(args[args.indexOf("-i") + 1]).toBe("/in");
    expect(args.at(-1)).toBe("/out.m4a");
    // Sin shell: nada de interpolar la ruta en un string.
    expect(args).not.toContain("/in /out.m4a");
  });
});

describe.skipIf(!FFMPEG)("FfmpegAudioExtractor (FFmpeg real)", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fastgram-audio-test-"));
    const base = ["-hide_banner", "-loglevel", "error", "-y"];
    execFileSync("ffmpeg", [
      ...base,
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      path.join(dir, "con-audio.mp4"),
    ]);
    execFileSync("ffmpeg", [
      ...base,
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:d=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path.join(dir, "mudo.mp4"),
    ]);
  }, 30_000);
  afterAll(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
  });

  it("saca el audio de un video con sonido", async () => {
    const extractor = new FfmpegAudioExtractor();
    const input = path.join(dir, "con-audio.mp4");
    const probe = await extractor.probe(input);
    expect(probe.hasAudio).toBe(true);
    const output = path.join(dir, "salida.m4a");
    expect(await extractor.extract(input, output, 300)).toBe(true);
    expect((await stat(output)).size).toBeGreaterThan(0);
    const out = await extractor.probe(output);
    expect(out.hasAudio).toBe(true);
    expect(out.durationSeconds).toBeGreaterThan(1.5);
    expect(out.durationSeconds).toBeLessThan(2.5);
  });

  it("un video mudo se detecta antes (y FFmpeg igual falla sin pista)", async () => {
    const extractor = new FfmpegAudioExtractor();
    const input = path.join(dir, "mudo.mp4");
    expect((await extractor.probe(input)).hasAudio).toBe(false);
    expect(await extractor.extract(input, path.join(dir, "nada.m4a"), 300)).toBe(false);
  });

  it("corta al tope", async () => {
    const extractor = new FfmpegAudioExtractor();
    const output = path.join(dir, "corta.m4a");
    expect(await extractor.extract(path.join(dir, "con-audio.mp4"), output, 1)).toBe(
      true,
    );
    const out = await extractor.probe(output);
    expect(out.durationSeconds).toBeLessThan(1.3);
  });
});
