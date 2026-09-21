import { describe, expect, it } from "vitest";
import {
  BACKGROUND_OPACITY_MAX,
  BACKGROUND_OPACITY_MIN,
  BUILD_FONT_WEIGHT_MAX,
  BUILD_FONT_WEIGHT_MIN,
  CONTENT_BUILD_DELETE_GRACE_MINUTES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  GENERATED_TEXT_MAX,
  REGENERATE_PROMPT_MAX,
  SLIDESHOW_MAX_SLIDES,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
  TEXT_BOX_MAX_LENGTH,
  TEXT_POSITION_MAX,
  TEXT_POSITION_MIN,
  TEXT_WIDTH_PERCENT_MAX,
  TEXT_WIDTH_PERCENT_MIN,
  buildTextSchema,
  contentTextBoxSchema,
  greenScreenBuildPayloadSchema,
  listContentQuerySchema,
  regenerateContentRequestSchema,
  slideshowBuildPayloadSchema,
  updateContentRequestSchema,
  videoHookBuildPayloadSchema,
  wallOfTextBuildPayloadSchema,
} from "./content";

const textBox = {
  id: "slide-0-text-0",
  text: "Consistency without burnout",
  position: { x: 50, y: 70 },
  widthPercent: 80,
  font: { family: "inter" as const, weight: 500, size: 18 },
  color: "#FFFFFF",
  stroke: { width: 3, color: "#000000" },
  background: null,
};

const mediaEl = {
  url: "https://cdn.example.com/bg.mp4",
  drawX: 0,
  drawY: 0,
  drawW: 1080,
  drawH: 1920,
};

const buildText = {
  content: "hook",
  x: 0,
  y: 0,
  width: 1080,
  fontSize: 18,
  color: "#FFFFFF",
  textAlign: "center" as const,
};

describe("geometría y tipografía de la caja de texto · FR-051 · PRD:1183-1185", () => {
  it("text ≤ 5000 y puede estar vacío · PRD:1183", () => {
    expect(TEXT_BOX_MAX_LENGTH).toBe(5000);
    expect(contentTextBoxSchema.parse({ ...textBox, text: "" }).text).toBe("");
    expect(
      contentTextBoxSchema.parse({ ...textBox, text: "x".repeat(5000) }).text,
    ).toHaveLength(5000);
    expect(() =>
      contentTextBoxSchema.parse({ ...textBox, text: "x".repeat(5001) }),
    ).toThrow();
  });

  it("position.x / position.y ∈ [0, 100] · PRD:1184", () => {
    expect(TEXT_POSITION_MIN).toBe(0);
    expect(TEXT_POSITION_MAX).toBe(100);
    expect(
      contentTextBoxSchema.parse({ ...textBox, position: { x: 0, y: 100 } }).position.x,
    ).toBe(0);
    expect(() =>
      contentTextBoxSchema.parse({ ...textBox, position: { x: -1, y: 0 } }),
    ).toThrow();
    expect(() =>
      contentTextBoxSchema.parse({ ...textBox, position: { x: 0, y: 101 } }),
    ).toThrow();
  });

  it("widthPercent ∈ [25, 100] · PRD:1184", () => {
    expect(TEXT_WIDTH_PERCENT_MIN).toBe(25);
    expect(TEXT_WIDTH_PERCENT_MAX).toBe(100);
    expect(
      contentTextBoxSchema.parse({ ...textBox, widthPercent: 25 }).widthPercent,
    ).toBe(25);
    expect(
      contentTextBoxSchema.parse({ ...textBox, widthPercent: 100 }).widthPercent,
    ).toBe(100);
    expect(() => contentTextBoxSchema.parse({ ...textBox, widthPercent: 24 })).toThrow();
    expect(() => contentTextBoxSchema.parse({ ...textBox, widthPercent: 101 })).toThrow();
  });

  it("font.size ∈ [8, 72] · PRD:1184", () => {
    expect(FONT_SIZE_MIN).toBe(8);
    expect(FONT_SIZE_MAX).toBe(72);
    expect(
      contentTextBoxSchema.parse({ ...textBox, font: { ...textBox.font, size: 8 } }).font
        .size,
    ).toBe(8);
    expect(
      contentTextBoxSchema.parse({ ...textBox, font: { ...textBox.font, size: 72 } }).font
        .size,
    ).toBe(72);
    expect(() =>
      contentTextBoxSchema.parse({ ...textBox, font: { ...textBox.font, size: 7 } }),
    ).toThrow();
    expect(() =>
      contentTextBoxSchema.parse({ ...textBox, font: { ...textBox.font, size: 73 } }),
    ).toThrow();
  });

  it("stroke.width ∈ [0, 8] · PRD:1184", () => {
    expect(STROKE_WIDTH_MIN).toBe(0);
    expect(STROKE_WIDTH_MAX).toBe(8);
    expect(
      contentTextBoxSchema.parse({ ...textBox, stroke: { width: 0, color: "#000000" } })
        .stroke.width,
    ).toBe(0);
    expect(() =>
      contentTextBoxSchema.parse({ ...textBox, stroke: { width: 9, color: "#000000" } }),
    ).toThrow();
  });

  it("background.opacity ∈ [0, 1]; `null` elimina el fondo · PRD:1185", () => {
    expect(BACKGROUND_OPACITY_MIN).toBe(0);
    expect(BACKGROUND_OPACITY_MAX).toBe(1);
    expect(
      contentTextBoxSchema.parse({ ...textBox, background: null }).background,
    ).toBeNull();
    expect(
      contentTextBoxSchema.parse({
        ...textBox,
        background: { color: "#FFFFFF", opacity: 1, style: "pill" },
      }).background,
    ).not.toBeNull();
    expect(() =>
      contentTextBoxSchema.parse({
        ...textBox,
        background: { color: "#FFFFFF", opacity: 1.1, style: "pill" },
      }),
    ).toThrow();
  });

  it("el peso tiene que existir para esa familia · PRD:1186", () => {
    expect(
      contentTextBoxSchema.parse({
        ...textBox,
        font: { family: "anton", weight: 400, size: 18 },
      }).font.weight,
    ).toBe(400);
    expect(() =>
      contentTextBoxSchema.parse({
        ...textBox,
        font: { family: "anton", weight: 700, size: 18 },
      }),
    ).toThrow();
    expect(() =>
      contentTextBoxSchema.parse({
        ...textBox,
        font: { family: "playfair", weight: 300, size: 18 },
      }),
    ).toThrow();
  });

  it("rechaza campos desconocidos sin aplicar nada · PRD:1188", () => {
    expect(() => contentTextBoxSchema.parse({ ...textBox, rotation: 15 })).toThrow();
  });
});

describe("payloads de build · FR-070 · PRD:1453-1459", () => {
  it("máximo 20 slides por slideshow · PRD:1450", () => {
    expect(SLIDESHOW_MAX_SLIDES).toBe(20);
    const slide = {
      canvas: { width: 1080, height: 1350, aspectRatio: "4:5" as const },
      image: { ...mediaEl, url: "https://cdn.example.com/s.png" },
      texts: [buildText],
    };
    const twenty = Array.from({ length: 20 }, () => slide);
    expect(
      slideshowBuildPayloadSchema.parse({ num_images: 20, images: twenty }).images,
    ).toHaveLength(20);
    expect(() =>
      slideshowBuildPayloadSchema.parse({ num_images: 21, images: [...twenty, slide] }),
    ).toThrow();
  });

  it("num_images debe coincidir con images.length · PRD:1458", () => {
    const slide = {
      canvas: { width: 1080, height: 1350, aspectRatio: "4:5" as const },
      image: { ...mediaEl, url: "https://cdn.example.com/s.png" },
      texts: [buildText],
    };
    expect(() =>
      slideshowBuildPayloadSchema.parse({ num_images: 2, images: [slide] }),
    ).toThrow();
  });

  it("wall-of-text es {canvas, video, audio, text} · PRD:1455", () => {
    const payload = {
      canvas: { width: 1080, height: 1920 },
      video: mediaEl,
      audio: { url: "https://cdn.example.com/track.mp3" },
      text: buildText,
    };
    expect(wallOfTextBuildPayloadSchema.parse(payload).video.drawW).toBe(1080);
  });

  it("`No audio` omite el bloque audio · FR-053.1 · PRD:1234", () => {
    const payload = {
      canvas: { width: 1080, height: 1920 },
      video: mediaEl,
      text: buildText,
    };
    expect(wallOfTextBuildPayloadSchema.parse(payload).audio).toBeUndefined();
  });

  it("green-screen es {canvas, image, video, text} · PRD:1456", () => {
    const payload = {
      canvas: { width: 1080, height: 1920 },
      image: { ...mediaEl, url: "https://cdn.example.com/bg.png" },
      video: mediaEl,
      text: buildText,
    };
    expect(greenScreenBuildPayloadSchema.parse(payload).image.url).toContain("bg.png");
  });

  it("video-hook usa las claves literales hook_video y demo_video · PRD:1457", () => {
    const payload = {
      canvas: { width: 1080, height: 1920 },
      hook_video: mediaEl,
      demo_video: mediaEl,
      text: buildText,
    };
    expect(videoHookBuildPayloadSchema.parse(payload).hook_video.drawH).toBe(1920);
    expect(() =>
      videoHookBuildPayloadSchema.parse({
        canvas: { width: 1080, height: 1920 },
        hookVideo: mediaEl,
        demoVideo: mediaEl,
        text: buildText,
      }),
    ).toThrow();
  });

  it("fontWeight del payload de build va de 100 a 900 · PRD:1453", () => {
    expect(BUILD_FONT_WEIGHT_MIN).toBe(100);
    expect(BUILD_FONT_WEIGHT_MAX).toBe(900);
    expect(buildTextSchema.parse({ ...buildText, fontWeight: 100 }).fontWeight).toBe(100);
    expect(buildTextSchema.parse({ ...buildText, fontWeight: 900 }).fontWeight).toBe(900);
    expect(() => buildTextSchema.parse({ ...buildText, fontWeight: 1000 })).toThrow();
  });
});

describe("edición · FR-051 · PRD:1180-1188", () => {
  it("textBoxes vacío se rechaza", () => {
    expect(() =>
      updateContentRequestSchema.parse({ revision: 1, textBoxes: [] }),
    ).toThrow();
  });

  it("ids duplicados se rechazan", () => {
    expect(() =>
      updateContentRequestSchema.parse({ revision: 1, textBoxes: [textBox, textBox] }),
    ).toThrow();
  });

  it("revision es obligatoria: es la concurrencia optimista (409 stale_revision)", () => {
    expect(() => updateContentRequestSchema.parse({ textBoxes: [textBox] })).toThrow();
    expect(
      updateContentRequestSchema.parse({ revision: 3, textBoxes: [textBox] }).revision,
    ).toBe(3);
  });
});

describe("regeneración · AI-004 · PRD:2603", () => {
  it("prompt ≤ 500 caracteres", () => {
    expect(REGENERATE_PROMPT_MAX).toBe(500);
    expect(
      regenerateContentRequestSchema.parse({ prompt: "p".repeat(500) }).prompt,
    ).toHaveLength(500);
    expect(() =>
      regenerateContentRequestSchema.parse({ prompt: "p".repeat(501) }),
    ).toThrow();
  });

  it("el body puede ir vacío", () => {
    expect(regenerateContentRequestSchema.parse({})).toEqual({});
  });
});

describe("otros números del contrato de contenido", () => {
  it("generatedText normalizado ≤ 2000 · DATA-008 · PRD:2079", () => {
    expect(GENERATED_TEXT_MAX).toBe(2000);
  });

  it("un BUILDING se puede borrar pasados 15 min · ERR-P02 · PRD:3184", () => {
    expect(CONTENT_BUILD_DELETE_GRACE_MINUTES).toBe(15);
  });
});

describe("listado de contenido · §12 · PRD:2721", () => {
  it("type y status son listas separadas por comas", () => {
    const parsed = listContentQuerySchema.parse({
      type: "slideshow,video-hook",
      status: "BUILDING,CREATED",
    });
    expect(parsed.type).toEqual(["slideshow", "video-hook"]);
    expect(parsed.status).toEqual(["BUILDING", "CREATED"]);
  });

  it("un valor no reconocido en la lista se rechaza → 400 bad_request", () => {
    expect(() => listContentQuerySchema.parse({ type: "slideshow,carousel" })).toThrow();
    expect(() => listContentQuerySchema.parse({ status: "POSTED" })).toThrow();
  });
});
