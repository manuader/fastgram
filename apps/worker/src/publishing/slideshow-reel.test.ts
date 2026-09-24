/**
 * Reel desde un slideshow (sprint 7, F-158). Sin FFmpeg real: el runner es un
 * doble que escribe el MP4 de salida, así que lo que se mide es el orden de las
 * slides, la clave por revisión, el reuso y la traducción de errores.
 */
import { writeFile } from "node:fs/promises";

import { FixedClock, MemoryStorage, canonicalObjectUrl } from "@fastgram/adapters";
import { describe, expect, it } from "vitest";

import {
  createFfmpegSlideshowReelComposer,
  isSlideshowReelError,
  slideshowReelArgs,
  slideshowReelKey,
  type FfmpegRunner,
} from "./slideshow-reel.js";

const clock = new FixedClock("2026-09-21T12:00:00.000Z");

async function seedSlides(storage: MemoryStorage, n: number): Promise<string[]> {
  const urls: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const key = `content/c1/slide-${String(i)}.png`;
    await storage.put({ key, body: new Uint8Array([i]), contentType: "image/png" });
    urls.push(await canonicalObjectUrl(storage, key));
  }
  return urls;
}

describe("slideshowReelArgs", () => {
  it("una entrada por slide, 3 s cada una, concat a 1080×1920 con faststart", () => {
    const args = slideshowReelArgs(["a.png", "b.png"], "out.mp4");
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args).toContain("3");
    const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(filter).toContain("scale=1080:1920");
    expect(filter).toContain("[v0][v1]concat=n=2:v=1:a=0[out]");
    expect(args).toContain("+faststart");
    expect(args[args.length - 1]).toBe("out.mp4");
  });
});

describe("createFfmpegSlideshowReelComposer", () => {
  it("compone en orden, sube por revisión y reusa lo ya compuesto", async () => {
    const storage = new MemoryStorage(clock);
    const files = await seedSlides(storage, 3);
    const calls: (readonly string[])[] = [];
    const run: FfmpegRunner = async (_bin, args) => {
      calls.push(args);
      await writeFile(args[args.length - 1] ?? "", new Uint8Array([1, 2, 3]));
    };
    const composer = createFfmpegSlideshowReelComposer({ storage, run });

    const url = await composer.compose({ contentId: "c1", revision: 2, files });
    expect(url).toBe(await canonicalObjectUrl(storage, slideshowReelKey("c1", 2)));
    expect(await storage.head(slideshowReelKey("c1", 2))).not.toBeNull();
    const inputs = (calls[0] ?? []).filter((_a, i, all) => all[i - 1] === "-i");
    expect(inputs.map((p) => p.split("/").pop())).toEqual([
      "slide-00.png",
      "slide-01.png",
      "slide-02.png",
    ]);

    await composer.compose({ contentId: "c1", revision: 2, files });
    expect(calls).toHaveLength(1);
  });

  it("sin FFmpeg: slideshow_reel_unavailable, sin el error crudo", async () => {
    const storage = new MemoryStorage(clock);
    const files = await seedSlides(storage, 1);
    const run: FfmpegRunner = async () => {
      throw Object.assign(new Error("spawn ffmpeg ENOENT /secret/path"), {
        code: "ENOENT",
      });
    };
    const composer = createFfmpegSlideshowReelComposer({ storage, run });
    const error = await composer
      .compose({ contentId: "c1", revision: 1, files })
      .catch((e: unknown) => e);
    expect(isSlideshowReelError(error)).toBe(true);
    if (!isSlideshowReelError(error)) return;
    expect(error.code).toBe("slideshow_reel_unavailable");
    expect(error.message).not.toContain("/secret/path");
  });

  it("FFmpeg falla: slideshow_reel_failed", async () => {
    const storage = new MemoryStorage(clock);
    const files = await seedSlides(storage, 1);
    const composer = createFfmpegSlideshowReelComposer({
      storage,
      run: async () => {
        throw new Error("boom");
      },
    });
    const error = await composer
      .compose({ contentId: "c1", revision: 1, files })
      .catch((e: unknown) => e);
    expect(isSlideshowReelError(error) && error.code).toBe("slideshow_reel_failed");
  });
});
