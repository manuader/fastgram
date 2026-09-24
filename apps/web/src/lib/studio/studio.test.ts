import { studioContentRequestSchema } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import {
  canGenerate,
  emptyDraft,
  studioFormatOf,
  studioSteps,
  toStudioRequest,
  withTextCount,
  type StudioDraft,
  type StudioPick,
} from "./studio";

const img = (n: number): StudioPick => ({
  mediaId: `00000000-0000-4000-8000-00000000000${String(n)}`,
  url: `https://cdn.test/${String(n)}.jpg`,
  mediaType: "image",
});
const vid = (n: number): StudioPick => ({ ...img(n), mediaType: "video" });

describe("Studio · F-073: Save deshabilitado hasta completar los pasos", () => {
  it("un draft vacío no se puede generar, y dice qué falta", () => {
    const steps = studioSteps("wall-of-text", emptyDraft());
    expect(steps).toEqual([
      { id: "media", done: false },
      { id: "text", done: false },
      { id: "style", done: true },
    ]);
    expect(canGenerate("wall-of-text", emptyDraft())).toBe(false);
    expect(toStudioRequest("wall-of-text", emptyDraft())).toBeNull();
  });

  it("wall of text: video + texto → cuerpo válido para la API", () => {
    const draft: StudioDraft = { ...emptyDraft(), video: vid(1), texts: ["Hola"] };
    expect(canGenerate("wall-of-text", draft)).toBe(true);
    const body = toStudioRequest("wall-of-text", draft);
    expect(body).toEqual({
      format: "wall-of-text",
      media: { video: vid(1).mediaId },
      texts: ["Hola"],
      textStylePresetId: "tiktok-classic",
    });
    expect(studioContentRequestSchema.safeParse(body).success).toBe(true);
  });

  it("green screen pide las dos piezas", () => {
    const half: StudioDraft = { ...emptyDraft(), image: img(1), texts: ["x"] };
    expect(canGenerate("green-screen", half)).toBe(false);
    expect(canGenerate("green-screen", { ...half, video: vid(2) })).toBe(true);
  });

  it("slideshow: un texto por slide, y un texto vacío bloquea", () => {
    const base = withTextCount("slideshow", {
      ...emptyDraft(),
      slides: [img(1), img(2)],
    });
    expect(base.texts).toEqual(["", ""]);
    expect(canGenerate("slideshow", { ...base, texts: ["a", ""] })).toBe(false);
    const body = toStudioRequest("slideshow", { ...base, texts: ["a", "b"] });
    expect(body?.media.slides).toHaveLength(2);
    expect(body?.aspectRatio).toBe("4:5");
    expect(studioContentRequestSchema.safeParse(body).success).toBe(true);
  });

  it("con IA alcanza el brief, y viaja como `ai`", () => {
    const draft: StudioDraft = {
      ...emptyDraft(),
      video: vid(1),
      textMode: "ai",
      aiPrompt: "  running tips ",
      mentionBusiness: true,
    };
    expect(canGenerate("wall-of-text", draft)).toBe(true);
    expect(toStudioRequest("wall-of-text", draft)?.ai).toEqual({
      prompt: "running tips",
      mentionBusiness: true,
    });
    expect(canGenerate("wall-of-text", { ...draft, aiPrompt: "   " })).toBe(false);
  });

  it("un estilo desconocido no pasa", () => {
    const draft: StudioDraft = {
      ...emptyDraft(),
      video: vid(1),
      texts: ["x"],
      stylePresetId: "neon-glow",
    };
    expect(canGenerate("wall-of-text", draft)).toBe(false);
  });

  it("las rutas del PRD mapean a los cuatro formatos, y nada más", () => {
    expect(studioFormatOf("green-screen-meme")).toBe("green-screen");
    expect(studioFormatOf("video-hook-and-demo")).toBe("video-hook");
    expect(studioFormatOf("claymation")).toBeNull();
    expect(studioFormatOf("custom")).toBeNull();
  });
});
