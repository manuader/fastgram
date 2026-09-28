import { describe, expect, it } from "vitest";
import { contentBuildPayloadSchema } from "./content.js";
import { contentTypeSchema } from "../primitives/enums.js";
import {
  REEL_CAPTION_WORD_MAX_LENGTH,
  REEL_DURATION_MAX_SEC,
  REEL_DURATION_MIN_SEC,
  REEL_MAX_CAPTION_WORDS,
  REEL_MAX_CLIP_LAYERS,
  REEL_MAX_LAYERS,
  REEL_MAX_MEDIA_LAYERS,
  REEL_MAX_TEXT_LAYERS,
  REEL_MIN_LAYER_SEC,
  REEL_TEXT_ANIMATIONS,
  REEL_TEXT_MAX_LENGTH,
  REEL_TRANSITIONS,
  REEL_DEFAULT_THEME,
  reelBuildPayloadSchema,
  reelMediaUrls,
  reelSpecSchema,
  type ReelLayer,
  type ReelSpec,
} from "./reel.js";

const text = (
  id: string,
  over: Partial<Extract<ReelLayer, { kind: "text" }>> = {},
): ReelLayer => ({
  id,
  kind: "text",
  start: 0.5,
  end: 4,
  z: 10,
  text: "Stop scrolling",
  font: { family: "anton", weight: 400, size: 40 },
  color: "#FFFFFF",
  stroke: { width: 3, color: "#000000" },
  background: null,
  position: { x: 50, y: 20 },
  widthPercent: 90,
  animation: "pop",
  exit: "fade",
  ...over,
});

function sample(): ReelSpec {
  return {
    version: 1,
    durationSec: 15,
    canvas: { width: 1080, height: 1920 },
    fps: 30,
    language: "en",
    theme: REEL_DEFAULT_THEME,
    mix: { duckMusic: true, duckLevel: 0.3 },
    layers: [
      {
        id: "bg",
        kind: "background",
        start: 0,
        end: 15,
        z: 0,
        fill: { type: "image", url: "https://media.example/bg.jpg", motion: "ken-burns" },
        transitionIn: { kind: "cut", durationSec: 0.3 },
      },
      {
        id: "clip",
        kind: "clip",
        start: 1,
        end: 11,
        z: 5,
        url: "https://media.example/gs.mp4",
        chroma: "green",
        fit: "contain",
        rect: { x: 50, y: 70, width: 100, height: 60 },
        mediaStartSec: 0,
        volume: 1,
        loop: false,
      },
      text("hook"),
      {
        id: "subs",
        kind: "captions",
        start: 1,
        end: 11,
        z: 20,
        sourceLayerId: "clip",
        style: "bold-pop",
        font: { family: "montserrat", weight: 700, size: 30 },
        color: "#FFFFFF",
        activeColor: "#FFE14D",
        stroke: { width: 3, color: "#000000" },
        positionY: 80,
        wordsPerChunk: 3,
      },
      {
        id: "music",
        kind: "audio",
        role: "music",
        start: 0,
        end: 15,
        url: "https://media.example/music.mp3",
        volume: 0.6,
        mediaStartSec: 0,
        fadeInSec: 1,
        fadeOutSec: 1.5,
        loop: true,
      },
    ],
  };
}

function issuesOf(spec: unknown): string[] {
  const parsed = reelSpecSchema.safeParse(spec);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

describe("reelSpecSchema", () => {
  it("accepts a full reel", () => {
    expect(issuesOf(sample())).toEqual([]);
  });

  it("pins the numbers", () => {
    expect([REEL_DURATION_MIN_SEC, REEL_DURATION_MAX_SEC]).toEqual([5, 60]);
    expect(REEL_MAX_LAYERS).toBe(24);
    expect(REEL_MAX_TEXT_LAYERS).toBe(12);
    expect(REEL_MAX_MEDIA_LAYERS).toBe(10);
    expect(REEL_MAX_CLIP_LAYERS).toBe(4);
    expect(REEL_TEXT_MAX_LENGTH).toBe(280);
    expect(REEL_MAX_CAPTION_WORDS).toBe(600);
    expect(REEL_CAPTION_WORD_MAX_LENGTH).toBe(40);
    expect(REEL_MIN_LAYER_SEC).toBe(0.2);
    expect(REEL_TEXT_ANIMATIONS).toHaveLength(10);
    expect(REEL_TRANSITIONS).toHaveLength(8);
  });

  it("rejects durations outside 5–60 s", () => {
    expect(issuesOf({ ...sample(), durationSec: 4.9 })).not.toEqual([]);
    expect(issuesOf({ ...sample(), durationSec: 60.1 })).not.toEqual([]);
    const ok = sample();
    expect(issuesOf({ ...ok, durationSec: 60 })).toEqual([]);
  });

  it("only takes the 1080×1920 canvas at 30 fps", () => {
    expect(issuesOf({ ...sample(), canvas: { width: 1080, height: 1080 } })).not.toEqual(
      [],
    );
    expect(issuesOf({ ...sample(), fps: 60 })).not.toEqual([]);
  });

  it("rejects a layer that ends after the reel, is too short, or repeats an id", () => {
    const s = sample();
    expect(
      issuesOf({ ...s, layers: [...s.layers, text("late", { end: 15.5 })] }),
    ).toContain("layer ends after the reel");
    expect(
      issuesOf({ ...s, layers: [...s.layers, text("blink", { start: 2, end: 2.1 })] }),
    ).toContain("a layer lasts at least 0.2s");
    expect(issuesOf({ ...s, layers: [...s.layers, text("hook")] })).toContain(
      "duplicate layer id hook",
    );
  });

  it("caps text length and text layers", () => {
    const s = sample();
    expect(
      issuesOf({
        ...s,
        layers: [text("t", { text: "x".repeat(REEL_TEXT_MAX_LENGTH + 1) })],
      }),
    ).not.toEqual([]);
    const many = Array.from({ length: REEL_MAX_TEXT_LAYERS + 1 }, (_, i) =>
      text(`t${String(i)}`),
    );
    expect(issuesOf({ ...s, layers: many })).toContain("at most 12 text layers");
    expect(
      issuesOf({
        ...s,
        layers: Array.from({ length: REEL_MAX_TEXT_LAYERS }, (_, i) =>
          text(`t${String(i)}`),
        ),
      }),
    ).toEqual([]);
  });

  it("caps the total of layers, clips and media", () => {
    const s = sample();
    const clip = s.layers[1] as Extract<ReelLayer, { kind: "clip" }>;
    const clips = Array.from({ length: REEL_MAX_CLIP_LAYERS + 1 }, (_, i) => ({
      ...clip,
      id: `c${String(i)}`,
    }));
    expect(issuesOf({ ...s, layers: clips })).toContain("at most 4 clips");
    const images = Array.from({ length: REEL_MAX_MEDIA_LAYERS + 1 }, (_, i) => ({
      id: `i${String(i)}`,
      kind: "image" as const,
      start: 0,
      end: 3,
      z: 3,
      url: "https://media.example/i.jpg",
      fit: "cover" as const,
      rect: { x: 50, y: 50, width: 40, height: 20 },
      animation: "pop" as const,
      exit: "none" as const,
    }));
    expect(issuesOf({ ...s, layers: images })).toContain("at most 10 media layers");
    const tooMany = Array.from({ length: REEL_MAX_LAYERS + 1 }, (_, i) => ({
      ...(s.layers[0] as ReelLayer),
      id: `b${String(i)}`,
    }));
    expect(issuesOf({ ...s, layers: tooMany })).not.toEqual([]);
  });

  it("allows one music and one voice layer", () => {
    const s = sample();
    const music = s.layers[4] as ReelLayer;
    expect(
      issuesOf({ ...s, layers: [...s.layers, { ...music, id: "music2" }] }),
    ).toContain("at most one music layer");
  });

  it("points captions at a clip or a voice", () => {
    const s = sample();
    const layers = s.layers.map((l) =>
      l.kind === "captions" ? { ...l, sourceLayerId: "music" } : l,
    );
    expect(issuesOf({ ...s, layers })).toContain(
      "captions must point at a clip or a voice layer",
    );
  });

  it("keeps caption words in order and inside the reel", () => {
    const s = sample();
    const withWords = (words: { text: string; start: number; end: number }[]) => ({
      ...s,
      layers: s.layers.map((l) => (l.kind === "captions" ? { ...l, words } : l)),
    });
    expect(issuesOf(withWords([{ text: "hi", start: 1, end: 1.3 }]))).toEqual([]);
    expect(
      issuesOf(
        withWords([
          { text: "b", start: 2, end: 2.2 },
          { text: "a", start: 1, end: 1.2 },
        ]),
      ),
    ).toContain("caption words must be in order");
    expect(issuesOf(withWords([{ text: "x", start: 14.9, end: 15.4 }]))).toContain(
      "word after the reel",
    );
    expect(
      issuesOf(
        withWords(
          Array.from({ length: REEL_MAX_CAPTION_WORDS + 1 }, (_, i) => ({
            text: "w",
            start: i * 0.01,
            end: i * 0.01 + 0.005,
          })),
        ),
      ),
    ).not.toEqual([]);
  });

  it("checks the font weight against the family", () => {
    const s = sample();
    expect(
      issuesOf({
        ...s,
        layers: [text("t", { font: { family: "anton", weight: 700, size: 40 } })],
      }),
    ).toContain("weight is not available for this font family");
  });

  it("rejects unknown animations and fields", () => {
    const s = sample();
    expect(
      issuesOf({
        ...s,
        layers: [{ ...text("t"), animation: "spin" } as unknown as ReelLayer],
      }),
    ).not.toEqual([]);
    expect(issuesOf({ ...s, extra: true })).not.toEqual([]);
  });
});

describe("reel build payload", () => {
  it("is part of the content payload union and is only matched by its `reel` key", () => {
    const payload = { reel: sample() };
    expect(reelBuildPayloadSchema.safeParse(payload).success).toBe(true);
    expect(contentBuildPayloadSchema.safeParse(payload).success).toBe(true);
    expect(contentTypeSchema.safeParse("reel").success).toBe(true);
  });

  it("lists every media URL of the spec", () => {
    expect(reelMediaUrls(sample())).toEqual([
      "https://media.example/bg.jpg",
      "https://media.example/gs.mp4",
      "https://media.example/music.mp3",
    ]);
  });
});
