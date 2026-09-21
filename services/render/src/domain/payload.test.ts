/** Números de `FR-070`: 20 slides, 4 aspect ratios, numImages == images.length. */
import { describe, expect, it } from "vitest";
import { ASPECT_RATIOS, canvasForAspect, DEFAULT_SLIDESHOW_ASPECT } from "./canvas.js";
import {
  buildPayloadSchema,
  collectMediaReferences,
  MAX_SLIDES,
  slideshowPayloadSchema,
} from "./payload.js";

const text = {
  id: "t1",
  text: "hola",
  position: { x: 50, y: 80 },
  widthPercent: 80,
  font: { family: "inter", weight: 600, size: 32 },
};

function slide(index: number, aspect: (typeof ASPECT_RATIOS)[number] = "4:5") {
  const canvas = canvasForAspect(aspect);
  return {
    canvas: { ...canvas, aspectRatio: aspect },
    image: { url: `https://cdn.example.com/media/ws-1/img-${index}.jpg` },
    texts: [{ ...text, id: `t${index}` }],
  };
}

function slideshow(count: number, numImages = count) {
  return {
    type: "slideshow",
    numImages,
    slides: Array.from({ length: count }, (_, index) => slide(index)),
  };
}

describe("slideshow — FR-070", () => {
  it("acepta hasta 20 slides", () => {
    expect(MAX_SLIDES).toBe(20);
    expect(slideshowPayloadSchema.safeParse(slideshow(20)).success).toBe(true);
  });

  it("rechaza 21 slides", () => {
    expect(slideshowPayloadSchema.safeParse(slideshow(21)).success).toBe(false);
  });

  it("rechaza numImages que no coincide con la cantidad de slides", () => {
    const result = slideshowPayloadSchema.safeParse(slideshow(3, 4));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("no coincide");
  });

  it("acepta los cuatro aspect ratios y ninguno más", () => {
    expect(ASPECT_RATIOS).toEqual(["1:1", "4:5", "3:4", "9:16"]);
    for (const aspect of ASPECT_RATIOS) {
      const payload = { type: "slideshow", numImages: 1, slides: [slide(0, aspect)] };
      expect(slideshowPayloadSchema.safeParse(payload).success).toBe(true);
    }
    const invalid = {
      type: "slideshow",
      numImages: 1,
      slides: [
        { ...slide(0), canvas: { width: 1080, height: 1080, aspectRatio: "16:9" } },
      ],
    };
    expect(slideshowPayloadSchema.safeParse(invalid).success).toBe(false);
  });

  it("el default documentado del slideshow es 4:5", () => {
    expect(DEFAULT_SLIDESHOW_ASPECT).toBe("4:5");
    expect(canvasForAspect("4:5")).toEqual({ width: 1080, height: 1350 });
    expect(canvasForAspect("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(canvasForAspect("1:1")).toEqual({ width: 1080, height: 1080 });
    expect(canvasForAspect("3:4")).toEqual({ width: 1080, height: 1440 });
  });

  it("rechaza slides con aspect ratios mezclados", () => {
    const payload = {
      type: "slideshow",
      numImages: 2,
      slides: [slide(0, "4:5"), slide(1, "9:16")],
    };
    expect(slideshowPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("la unión discriminada aplica las mismas reglas", () => {
    expect(buildPayloadSchema.safeParse(slideshow(3, 4)).success).toBe(false);
    expect(buildPayloadSchema.safeParse(slideshow(3)).success).toBe(true);
  });
});

describe("los otros tres formatos", () => {
  const canvas = { width: 1080, height: 1920 };
  const video = { url: "https://cdn.example.com/media/ws-1/v.mp4" };
  const audio = { url: "https://library.example.com/audio/a.m4a" };

  it("wall-of-text lleva canvas, video, audio y textos", () => {
    const parsed = buildPayloadSchema.safeParse({
      type: "wall-of-text",
      canvas,
      video,
      audio,
      texts: [text],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // `EXT-006`: el default es recortar, no estirar.
    expect(parsed.data.type === "wall-of-text" && parsed.data.video.fit).toBe("cover");
  });

  it("green-screen compone el croma sobre la imagen y trae defaults de chroma", () => {
    const parsed = buildPayloadSchema.safeParse({
      type: "green-screen",
      canvas,
      image: { url: "https://cdn.example.com/media/ws-1/bg.jpg" },
      video,
      texts: [text],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.type !== "green-screen") return;
    expect(parsed.data.chromaKey.color).toBe("#00FF00");
  });

  it("video-hook exige hook y demo", () => {
    const ok = buildPayloadSchema.safeParse({
      type: "video-hook",
      canvas,
      hookVideo: video,
      demoVideo: { url: "https://cdn.example.com/media/ws-1/demo.mp4" },
      audio,
      texts: [text],
    });
    expect(ok.success).toBe(true);
    const missingDemo = buildPayloadSchema.safeParse({
      type: "video-hook",
      canvas,
      hookVideo: video,
      audio,
      texts: [text],
    });
    expect(missingDemo.success).toBe(false);
  });

  it("enumera todas las URLs con su rol, y marca el audio como audio", () => {
    const parsed = buildPayloadSchema.parse({
      type: "video-hook",
      canvas,
      hookVideo: video,
      demoVideo: { url: "https://cdn.example.com/media/ws-1/demo.mp4" },
      audio,
      texts: [text],
    });
    const refs = collectMediaReferences(parsed);
    expect(refs).toHaveLength(3);
    expect(refs.filter((r) => r.role === "audio")).toHaveLength(1);
    expect(refs.find((r) => r.role === "audio")?.url).toBe(audio.url);
  });

  it("rechaza campos desconocidos en el payload", () => {
    expect(
      buildPayloadSchema.safeParse({
        type: "wall-of-text",
        canvas,
        video,
        audio,
        texts: [text],
        watermark: true,
      }).success,
    ).toBe(false);
  });
});
