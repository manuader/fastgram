/**
 * `PU-EDIT-002` — el mapeo de cajas del editor a `buildPayload`.
 *
 * Los esperados son literales a propósito (trampa de «el test recalcula con la
 * misma fórmula»): si alguien cambia centro por esquina, o escala la fuente
 * acá además de en el render, estos números dejan de coincidir.
 */
import { describe, expect, it } from "vitest";

import type { ContentTextBox } from "./text-boxes.js";
import {
  applyTextBoxesToBuildPayload,
  textBoxToBuildText,
  type EditableBuildText,
} from "./text-boxes-to-build-payload.js";

const P1350 = { width: 1080, height: 1350 };
const P1920 = { width: 1080, height: 1920 };

function box(overrides: Partial<ContentTextBox> = {}): ContentTextBox {
  return {
    id: "slide-0-text-0",
    slideIndex: 0,
    text: "Hola",
    position: { x: 50, y: 50 },
    widthPercent: 80,
    font: { family: "inter", weight: 700, size: 18 },
    color: "#FFFFFF",
    stroke: { width: 3, color: "#000000" },
    background: null,
    ...overrides,
  };
}

const original: EditableBuildText = {
  content: "Original",
  x: 540,
  y: 960,
  width: 972,
  fontSize: 18,
  color: "#000000",
  textAlign: "left",
  fontWeight: 500,
};

const media = {
  url: "https://cdn.test/v.mp4",
  drawX: 0,
  drawY: 0,
  drawW: 1080,
  drawH: 1920,
};

describe("textBoxToBuildText — geometría (centro + ancho, % → px)", () => {
  it("(50,50) al 80 % en 1080×1350 → centro (540, 675), ancho 864", () => {
    const t = textBoxToBuildText(box(), P1350, "center");
    expect([t.x, t.y, t.width]).toEqual([540, 675, 864]);
  });

  it("(50,50) al 80 % en 1080×1920 → centro (540, 960), ancho 864", () => {
    const t = textBoxToBuildText(box(), P1920, "center");
    expect([t.x, t.y, t.width]).toEqual([540, 960, 864]);
  });

  it("bordes: 0 y 100 caen en el borde del lienzo (el centro, no la esquina)", () => {
    const origen = textBoxToBuildText(box({ position: { x: 0, y: 0 } }), P1920, "center");
    expect([origen.x, origen.y]).toEqual([0, 0]);
    const fin = textBoxToBuildText(
      box({ position: { x: 100, y: 100 } }),
      P1350,
      "center",
    );
    expect([fin.x, fin.y]).toEqual([1080, 1350]);
  });

  it("widthPercent 25 → 270 px y 100 → 1080 px (el ancho es del lienzo, no del alto)", () => {
    expect(textBoxToBuildText(box({ widthPercent: 25 }), P1920, "center").width).toBe(
      270,
    );
    expect(textBoxToBuildText(box({ widthPercent: 100 }), P1350, "center").width).toBe(
      1080,
    );
  });

  it("y (20, 75) en 1080×1920 → (216, 1440)", () => {
    const t = textBoxToBuildText(box({ position: { x: 20, y: 75 } }), P1920, "center");
    expect([t.x, t.y]).toEqual([216, 1440]);
  });

  it("sin ruido de coma flotante: 33,3 % de 1080 es 359,64", () => {
    expect(textBoxToBuildText(box({ widthPercent: 33.3 }), P1350, "center").width).toBe(
      359.64,
    );
  });
});

describe("textBoxToBuildText — fuente y stroke quedan en unidades de editor", () => {
  it("size 18 y stroke 3 viajan tal cual: el ×3 de 1080 lo aplica el render (18 → 54)", () => {
    // Si este test viera 54, la escala se aplicaría dos veces (acá y en
    // `editorUnitsToCanvasPx`): 18 → 162 px en el video.
    const t = textBoxToBuildText(box(), P1350, "center");
    expect(t.fontSize).toBe(18);
    expect(t.strokeWidth).toBe(3);
    expect((t.fontSize * P1350.width) / 360).toBe(54);
  });
});

describe("textBoxToBuildText — estilo", () => {
  it("color, peso, stroke y texto de la caja; alineación la que se le pasa", () => {
    const t = textBoxToBuildText(
      box({
        text: "Nuevo",
        color: "#FFD600",
        font: { family: "anton", weight: 400, size: 30 },
        stroke: { width: 0, color: "#112233" },
      }),
      P1920,
      "right",
    );
    expect(t).toEqual({
      content: "Nuevo",
      x: 540,
      y: 960,
      width: 864,
      fontSize: 30,
      color: "#FFD600",
      textAlign: "right",
      fontWeight: 400,
      strokeWidth: 0,
      strokeColor: "#112233",
    });
  });

  it("fondo: el color viaja; null lo quita; opacidad 0 también lo quita", () => {
    const con = textBoxToBuildText(
      box({ background: { color: "#000000", opacity: 0.6, style: "pill" } }),
      P1920,
      "center",
    );
    expect(con.backgroundColor).toBe("#000000");
    expect("backgroundColor" in textBoxToBuildText(box(), P1920, "center")).toBe(false);
    const invisible = textBoxToBuildText(
      box({ background: { color: "#000000", opacity: 0, style: "full-width" } }),
      P1920,
      "center",
    );
    expect("backgroundColor" in invisible).toBe(false);
  });
});

describe("applyTextBoxesToBuildPayload — formatos de un texto", () => {
  const wall = { canvas: P1920, video: media, text: original };

  it("reemplaza `text`, conserva media y canvas y la alineación original", () => {
    const r = applyTextBoxesToBuildPayload(wall, [
      box({ position: { x: 20, y: 30 }, text: "Editado" }),
    ]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.payload.video).toBe(media);
    expect(r.payload.canvas).toBe(P1920);
    expect(r.payload.text).toMatchObject({
      content: "Editado",
      x: 216,
      y: 576,
      width: 864,
      textAlign: "left",
    });
    expect(r.fontFamilies).toEqual([["inter"]]);
  });

  it("conserva claves que no conoce (audio)", () => {
    const conAudio = { ...wall, audio: { url: "https://lib.test/a.mp3" } };
    const r = applyTextBoxesToBuildPayload(conAudio, [box()]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.payload.audio).toEqual({ url: "https://lib.test/a.mp3" });
  });

  it("no muta el payload original", () => {
    const copia = structuredClone(wall);
    applyTextBoxesToBuildPayload(wall, [box({ text: "otro" })]);
    expect(wall).toEqual(copia);
  });

  it("caja sin slideIndex también vale", () => {
    const r = applyTextBoxesToBuildPayload(wall, [box({ slideIndex: undefined })]);
    expect(r.ok).toBe(true);
  });

  it("más de una caja: se rechaza, no se elige ni se une", () => {
    const r = applyTextBoxesToBuildPayload(wall, [box(), box({ id: "slide-0-text-1" })]);
    expect(r).toMatchObject({ ok: false, code: "multiple_boxes_on_single_text_format" });
  });

  it("slideIndex distinto de 0 en un formato de una superficie: se rechaza", () => {
    const r = applyTextBoxesToBuildPayload(wall, [box({ slideIndex: 1 })]);
    expect(r).toMatchObject({ ok: false, code: "text_box_slide_out_of_range" });
  });

  it("cajas inválidas (fuera de rango): se rechaza con código estable", () => {
    const r = applyTextBoxesToBuildPayload(wall, [box({ widthPercent: 10 })]);
    expect(r).toMatchObject({ ok: false, code: "invalid_text_boxes" });
  });

  it("sin cajas: el payload vuelve igual", () => {
    const r = applyTextBoxesToBuildPayload(wall, []);
    if (!r.ok) throw new Error(r.reason);
    expect(r.payload).toBe(wall);
    expect(r.fontFamilies).toEqual([[undefined]]);
  });
});

describe("applyTextBoxesToBuildPayload — slideshow", () => {
  const slide = (texts: EditableBuildText[]) => ({
    canvas: { ...P1350, aspectRatio: "4:5" },
    image: media,
    texts,
  });
  const show = {
    num_images: 3,
    images: [slide([original]), slide([original]), slide([original, original])],
  };

  it("`texts` por slide; el slide sin cajas conserva sus textos", () => {
    const r = applyTextBoxesToBuildPayload(show, [
      box({ id: "slide-2-text-10", slideIndex: 2, text: "segunda" }),
      box({ id: "slide-0-text-0", slideIndex: 0, text: "uno" }),
      box({
        id: "slide-2-text-2",
        slideIndex: 2,
        text: "primera",
        font: { family: "anton", weight: 400, size: 18 },
      }),
    ]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.payload.num_images).toBe(3);
    expect(r.payload.images[0]?.texts.map((t) => t.content)).toEqual(["uno"]);
    expect(r.payload.images[1]?.texts).toEqual([original]);
    // Orden numérico por id: `-2` antes que `-10`.
    expect(r.payload.images[2]?.texts.map((t) => t.content)).toEqual([
      "primera",
      "segunda",
    ]);
    expect(r.payload.images[0]?.texts[0]).toMatchObject({
      x: 540,
      y: 675,
      textAlign: "left",
    });
    expect(r.fontFamilies).toEqual([["inter"], [undefined], ["anton", "inter"]]);
    expect(r.payload.images[2]?.image).toBe(media);
  });

  it("caja sin slideIndex o de un slide que no existe: se rechaza", () => {
    expect(
      applyTextBoxesToBuildPayload(show, [box({ slideIndex: undefined })]),
    ).toMatchObject({
      ok: false,
      code: "text_box_slide_out_of_range",
    });
    expect(applyTextBoxesToBuildPayload(show, [box({ slideIndex: 3 })])).toMatchObject({
      ok: false,
      code: "text_box_slide_out_of_range",
    });
  });

  it("más cajas que textos originales: las nuevas se alinean al centro", () => {
    const r = applyTextBoxesToBuildPayload(show, [
      box({ id: "slide-0-text-0" }),
      box({ id: "slide-0-text-1" }),
    ]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.payload.images[0]?.texts.map((t) => t.textAlign)).toEqual([
      "left",
      "center",
    ]);
  });
});
