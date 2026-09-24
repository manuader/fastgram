/**
 * `PU-EDIT-003` — el borrador y el body del `PATCH`.
 */
import {
  editableContentSchema,
  updateContentRequestSchema,
  type EditableContent,
} from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import {
  assetsPatchOf,
  buildPatchBody,
  editorReducer,
  initialEditorState,
  isDirty,
  slideCount,
} from "./state";

const draw = (url: string) => ({ url, drawX: 0, drawY: 0, drawW: 1080, drawH: 1920 });

const box = (id: string, slideIndex: number) => ({
  id,
  slideIndex,
  text: `texto ${id}`,
  position: { x: 50, y: 50 },
  widthPercent: 80,
  font: { family: "inter", weight: 700, size: 18 },
  color: "#FFFFFF",
  stroke: { width: 3, color: "#000000" },
  background: null,
});

/** Validado contra el contrato: un fixture que el servidor no podría mandar no prueba nada. */
const greenScreen: EditableContent = editableContentSchema.parse({
  canvas: { width: 1080, height: 1920 },
  textBoxes: [box("slide-0-text-0", 0)],
  assets: {
    image: draw("https://cdn.test/bg.jpg"),
    video: draw("https://cdn.test/m.mp4"),
  },
});

const slideshow: EditableContent = editableContentSchema.parse({
  canvas: { width: 1080, height: 1350 },
  textBoxes: [box("slide-0-text-0", 0), box("slide-1-text-0", 1)],
  assets: { slides: [draw("https://cdn.test/s0.jpg"), draw("https://cdn.test/s1.jpg")] },
});

describe("reducer", () => {
  it("arranca limpio, con la primera caja seleccionada", () => {
    const s = initialEditorState(greenScreen);
    expect(isDirty(s)).toBe(false);
    expect(s.selectedId).toBe("slide-0-text-0");
  });

  it("place mueve el centro y ensucia; discard vuelve atrás", () => {
    let s = initialEditorState(greenScreen);
    s = editorReducer(s, { type: "place", id: "slide-0-text-0", x: 20, y: 130 });
    expect(s.draft.boxes[0]?.position).toEqual({ x: 20, y: 100 });
    expect(isDirty(s)).toBe(true);
    s = editorReducer(s, { type: "discard" });
    expect(isDirty(s)).toBe(false);
  });

  it("update con all aplica a todas las cajas (Apply to all text boxes)", () => {
    let s = initialEditorState(slideshow);
    s = editorReducer(s, {
      type: "update",
      id: "slide-0-text-0",
      all: true,
      patch: (b) => ({ ...b, color: "#FF0000" }),
    });
    expect(s.draft.boxes.map((b) => b.color)).toEqual(["#FF0000", "#FF0000"]);
  });

  it("slide cambia de slide y selecciona su primera caja", () => {
    let s = initialEditorState(slideshow);
    s = editorReducer(s, { type: "slide", index: 1 });
    expect([s.slide, s.selectedId]).toEqual([1, "slide-1-text-0"]);
    expect(slideCount(s)).toBe(2);
  });

  it("commit hace del borrador la base", () => {
    let s = initialEditorState(greenScreen);
    s = editorReducer(s, { type: "move", id: "slide-0-text-0", dx: 1, dy: 0 });
    s = editorReducer(s, { type: "commit" });
    expect(isDirty(s)).toBe(false);
  });

  it("audio en un formato sin pista no hace nada", () => {
    const s = initialEditorState(greenScreen);
    expect(editorReducer(s, { type: "audio", url: null })).toBe(s);
  });
});

describe("assetsPatchOf", () => {
  it("sin cambios → null", () => {
    expect(assetsPatchOf(greenScreen.assets ?? {}, greenScreen.assets ?? {})).toBeNull();
  });

  it("Swap image for slide 2 → sólo ese índice, sólo la url", () => {
    let s = initialEditorState(slideshow);
    s = editorReducer(s, { type: "swapSlide", index: 1, url: "https://cdn.test/n.jpg" });
    expect(assetsPatchOf(s.base.assets, s.draft.assets)).toEqual({
      slides: [{ index: 1, image: { url: "https://cdn.test/n.jpg" } }],
    });
  });

  it("zoom del meme → sólo draw*", () => {
    let s = initialEditorState(greenScreen);
    s = editorReducer(s, {
      type: "mediaRect",
      slot: "video",
      rect: { drawX: -270, drawY: -480, drawW: 1620, drawH: 2880 },
    });
    expect(assetsPatchOf(s.base.assets, s.draft.assets)).toEqual({
      video: { drawX: -270, drawY: -480, drawW: 1620, drawH: 2880 },
    });
  });

  it("No audio → audio: null", () => {
    const wall = editableContentSchema.parse({
      canvas: { width: 1080, height: 1920 },
      textBoxes: [box("t0", 0)],
      assets: {
        video: draw("https://cdn.test/v.mp4"),
        audio: { url: "https://cdn.test/a.mp3" },
      },
    });
    let s = initialEditorState(wall);
    s = editorReducer(s, { type: "audio", url: null });
    expect(assetsPatchOf(s.base.assets, s.draft.assets)).toEqual({ audio: null });
  });
});

describe("buildPatchBody — lo que sale por el cable", () => {
  it("sólo texto: revision + todas las cajas, sin assets; y el contrato lo acepta", () => {
    let s = initialEditorState(slideshow);
    s = editorReducer(s, {
      type: "update",
      id: "slide-1-text-0",
      patch: (b) => ({ ...b, text: "nuevo" }),
    });
    const body = buildPatchBody(4, s);
    expect(body.revision).toBe(4);
    expect(body.textBoxes.map((b) => b.id)).toEqual(["slide-0-text-0", "slide-1-text-0"]);
    expect(body.textBoxes[1]?.text).toBe("nuevo");
    expect("assets" in body).toBe(false);
    expect(updateContentRequestSchema.safeParse(body).success).toBe(true);
  });

  it("con swap: lleva assets y el contrato lo acepta", () => {
    let s = initialEditorState(greenScreen);
    s = editorReducer(s, {
      type: "swapMedia",
      slot: "video",
      url: "https://cdn.test/n.mp4",
    });
    const body = buildPatchBody(1, s);
    expect(body.assets).toEqual({ video: { url: "https://cdn.test/n.mp4" } });
    expect(updateContentRequestSchema.safeParse(body).success).toBe(true);
  });
});
