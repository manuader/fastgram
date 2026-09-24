/**
 * `FfmpegClipInspector` contra el FFmpeg real, sobre clips que genera el test.
 * Si no hay FFmpeg en el PATH, se saltea (y lo dice).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  FfmpegClipInspector,
  borderCells,
  sampleTimes,
} from "./ffmpeg-clip-inspector.js";

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS = hasFfmpeg();
const dir = mkdtempSync(path.join(tmpdir(), "inspector-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function clip(name: string, source: string): string {
  const out = path.join(dir, name);
  execFileSync("ffmpeg", [
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `${source}${source.includes("=") ? ":" : "="}s=320x568:d=2:r=15`,
    "-f",
    "lavfi",
    "-i",
    "sine=f=440:d=2",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    out,
  ]);
  return out;
}

describe("utilidades puras", () => {
  it("sampleTimes reparte en el interior", () => {
    expect(sampleTimes(4, 3)).toEqual([1, 2, 3]);
    expect(sampleTimes(null, 1)).toEqual([0.5]);
  });

  it("borderCells devuelve las 60 celdas del marco de una grilla 16×16", () => {
    const raw = new Uint8Array(16 * 16 * 3);
    expect(borderCells(raw)).toHaveLength(60);
  });
});

describe.skipIf(!HAS)("FfmpegClipInspector (FFmpeg real)", () => {
  const inspector = new FfmpegClipInspector();

  it("probe mide duración, dimensiones y pistas", async () => {
    const p = await inspector.probe(clip("green.mp4", "color=c=0x00FF00"));
    expect(p.hasVideo).toBe(true);
    expect(p.hasAudio).toBe(true);
    expect(p.width).toBe(320);
    expect(p.durationSeconds).toBeGreaterThan(1.5);
  });

  it("frames devuelve JPEGs con el lado mayor acotado", async () => {
    const frames = await inspector.frames(clip("t.mp4", "testsrc2"), 3, 128);
    expect(frames).toHaveLength(3);
    for (const f of frames) expect([f[0], f[1]]).toEqual([0xff, 0xd8]);
  });

  it("borderSamples de un clip verde es verde", async () => {
    const samples = await inspector.borderSamples(path.join(dir, "green.mp4"), 2);
    expect(samples).toHaveLength(120);
    for (const s of samples) {
      expect(s.g).toBeGreaterThan(200);
      expect(s.r).toBeLessThan(40);
    }
  });

  it("un archivo que no es video → bad_request, sin el stderr", async () => {
    await expect(inspector.probe(path.join(dir, "no-existe.mp4"))).rejects.toMatchObject({
      code: "bad_request",
    });
  });
});
