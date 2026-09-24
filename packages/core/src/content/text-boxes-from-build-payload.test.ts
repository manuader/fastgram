/**
 * La inversa de `applyTextBoxesToBuildPayload`: del payload de build a las cajas
 * del editor. Lo que fija:
 *
 *  - valores literales (centro en %, ancho en %, fuente sin escalar);
 *  - la ida y vuelta sobre los cuatro formatos y varios canvas: aplicar las
 *    cajas derivadas da un payload que renderiza igual que el original;
 *  - que todo lo derivado pasa la validación del `PATCH` (`assertValidTextBoxes`),
 *    incluso desde payloads con valores que el contrato del `PATCH` no admite.
 */
import { describe, expect, it } from "vitest";

import { assertValidTextBoxes, FONT_WEIGHTS } from "./text-boxes.js";
import {
  buildTextToTextBox,
  deriveTextBoxesFromBuildPayload,
  nearestAllowedWeight,
} from "./text-boxes-from-build-payload.js";
import {
  applyTextBoxesToBuildPayload,
  type EditableBuildPayload,
  type EditableBuildText,
} from "./text-boxes-to-build-payload.js";

const P1920 = { width: 1080, height: 1920 };
const P1350 = { width: 1080, height: 1350 };

const media = {
  url: "https://cdn.test/v.mp4",
  drawX: 0,
  drawY: 0,
  drawW: 1080,
  drawH: 1920,
};

// El texto que escribe Blitz (`blitz-build.ts`, `textFor`) en 1080×1920.
const blitzText: EditableBuildText = {
  content: "Consistency without burnout",
  x: 540,
  y: 1344,
  width: 972,
  fontSize: 18,
  color: "#FFFFFF",
  textAlign: "center",
  fontWeight: 700,
  strokeWidth: 3,
  strokeColor: "#000000",
};

describe("buildTextToTextBox — valores literales", () => {
  it("texto de Blitz en 1080×1920 → centro (50 %, 70 %), ancho 90 %, fuente 18 tal cual", () => {
    expect(buildTextToTextBox(blitzText, P1920, "slide-0-text-0", 0)).toEqual({
      id: "slide-0-text-0",
      slideIndex: 0,
      text: "Consistency without burnout",
      position: { x: 50, y: 70 },
      widthPercent: 90,
      font: { family: "inter", weight: 700, size: 18 },
      color: "#FFFFFF",
      stroke: { width: 3, color: "#000000" },
      background: null,
    });
  });

  it("fontSize y strokeWidth NO se dividen: el payload ya está en unidades de editor", () => {
    const b = buildTextToTextBox(
      { ...blitzText, fontSize: 30, strokeWidth: 5 },
      P1350,
      "x",
      0,
    );
    expect(b.font.size).toBe(30);
    expect(b.stroke.width).toBe(5);
  });

  it("y sobre el alto, x y ancho sobre el ancho: (216, 1080) en 1080×1350 → (20, 80)", () => {
    const b = buildTextToTextBox({ ...blitzText, x: 216, y: 1080 }, P1350, "x", 0);
    expect(b.position).toEqual({ x: 20, y: 80 });
  });

  it("porcentaje con 6 decimales: 333 px de 1080 → 30.833333", () => {
    const b = buildTextToTextBox({ ...blitzText, x: 333 }, P1920, "x", 0);
    expect(b.position.x).toBe(30.833333);
  });

  it("sin peso ni stroke: los defaults del render (400; 3 px #000000)", () => {
    const b = buildTextToTextBox(
      {
        content: "a",
        x: 540,
        y: 960,
        width: 864,
        fontSize: 18,
        color: "#FFD600",
        textAlign: "left",
      },
      P1920,
      "x",
      0,
    );
    expect(b.font).toEqual({ family: "inter", weight: 400, size: 18 });
    expect(b.stroke).toEqual({ width: 3, color: "#000000" });
    expect(b.color).toBe("#FFD600");
  });

  it("backgroundColor → fondo pill opaco (lo que manda el adaptador)", () => {
    const b = buildTextToTextBox(
      { ...blitzText, backgroundColor: "#112233" },
      P1920,
      "x",
      0,
    );
    expect(b.background).toEqual({ color: "#112233", opacity: 1, style: "pill" });
  });
});

describe("normalización a lo que acepta el PATCH", () => {
  it("peso fuera de los de inter → el permitido más cercano (empate → el menor)", () => {
    expect(nearestAllowedWeight("inter", 100)).toBe(300);
    expect(nearestAllowedWeight("inter", 900)).toBe(700);
    expect(nearestAllowedWeight("inter", 450)).toBe(400);
    expect(nearestAllowedWeight("inter", 460)).toBe(500);
    expect(nearestAllowedWeight("anton", 700)).toBe(400);
  });

  it("geometría, tamaño y stroke fuera de rango se acotan; colores inválidos caen al default", () => {
    const b = buildTextToTextBox(
      {
        content: "x".repeat(6000),
        x: -10,
        y: 5000,
        width: 100,
        fontSize: 200,
        color: "red",
        textAlign: "center",
        fontWeight: 900,
        strokeWidth: 20,
        strokeColor: "#abc",
        backgroundColor: "rgba(0,0,0,.5)",
      },
      P1920,
      "slide-0-text-0",
      0,
    );
    expect(b.position).toEqual({ x: 0, y: 100 });
    expect(b.widthPercent).toBe(25);
    expect(b.font).toEqual({ family: "inter", weight: 700, size: 72 });
    expect(b.stroke).toEqual({ width: 8, color: "#000000" });
    expect(b.color).toBe("#FFFFFF");
    expect(b.background).toBeNull();
    expect(b.text).toHaveLength(5000);
    expect(() => assertValidTextBoxes([b])).not.toThrow();
  });

  it("ancho de más del 100 % → 100", () => {
    expect(
      buildTextToTextBox({ ...blitzText, width: 2000 }, P1920, "x", 0).widthPercent,
    ).toBe(100);
  });
});

describe("deriveTextBoxesFromBuildPayload — ids y superficies", () => {
  it("formato de una superficie: una caja slide-0-text-0 con slideIndex 0", () => {
    const boxes = deriveTextBoxesFromBuildPayload({
      canvas: P1920,
      video: media,
      text: blitzText,
    } as EditableBuildPayload);
    expect(boxes.map((b) => [b.id, b.slideIndex])).toEqual([["slide-0-text-0", 0]]);
  });

  it("slideshow: slide-<i>-text-<j>; un slide sin textos no aporta cajas", () => {
    const slide = (texts: EditableBuildText[]) => ({
      canvas: { ...P1350, aspectRatio: "4:5" },
      image: media,
      texts,
    });
    const boxes = deriveTextBoxesFromBuildPayload({
      num_images: 3,
      images: [slide([blitzText]), slide([]), slide([blitzText, blitzText])],
    });
    expect(boxes.map((b) => [b.id, b.slideIndex])).toEqual([
      ["slide-0-text-0", 0],
      ["slide-2-text-0", 2],
      ["slide-2-text-1", 2],
    ]);
  });
});

// ── Ida y vuelta ──────────────────────────────────────────────────────────────

/** PRNG determinista (mulberry32): el test falla siempre igual o no falla. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CANVASES = [
  { width: 1080, height: 1920 },
  { width: 1080, height: 1350 },
  { width: 1080, height: 1080 },
  { width: 720, height: 1280 },
  { width: 1333, height: 777 },
  { width: 4096, height: 4096 },
];

const pick = <T>(r: () => number, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)] as T;
const hex = (r: () => number): string =>
  `#${Math.floor(r() * 0xffffff)
    .toString(16)
    .padStart(6, "0")
    .toUpperCase()}`;
/** Hasta 4 decimales, como cualquier payload que el render acepta sin ruido. */
const px4 = (r: () => number, max: number): number => Math.round(r() * max * 1e4) / 1e4;

function randomText(r: () => number, canvas: { width: number; height: number }) {
  const t: EditableBuildText = {
    content: pick(r, ["", "Hola", "Una línea\ncon salto", "🔥 emoji"]),
    x: pick(r, [px4(r, canvas.width), Math.round(r() * canvas.width)]),
    y: pick(r, [px4(r, canvas.height), Math.round(r() * canvas.height)]),
    width: Math.round((0.25 + r() * 0.75) * canvas.width * 1e4) / 1e4,
    fontSize: pick(r, [8, 18, 24.5, 72, Math.round(8 + r() * 64)]),
    color: hex(r),
    textAlign: pick(r, ["left", "center", "right"] as const),
    ...(r() < 0.7 ? { fontWeight: pick(r, FONT_WEIGHTS["inter"] ?? [400]) } : {}),
    ...(r() < 0.6 ? { strokeWidth: pick(r, [0, 1.5, 3, 8]) } : {}),
    ...(r() < 0.6 ? { strokeColor: hex(r) } : {}),
    ...(r() < 0.4 ? { backgroundColor: hex(r) } : {}),
  };
  return t;
}

function randomPayload(r: () => number, format: string): EditableBuildPayload {
  const canvas = pick(r, CANVASES);
  const m = { ...media, drawW: canvas.width, drawH: canvas.height };
  switch (format) {
    case "slideshow": {
      const n = 1 + Math.floor(r() * 5);
      return {
        num_images: n,
        images: Array.from({ length: n }, () => {
          const c = pick(r, CANVASES);
          return {
            canvas: { ...c, aspectRatio: "4:5" },
            image: m,
            texts: Array.from({ length: Math.floor(r() * 12) }, () => randomText(r, c)),
          };
        }),
      } as EditableBuildPayload;
    }
    case "wall-of-text":
      return {
        canvas,
        video: m,
        audio: { url: "https://lib.test/a.mp3" },
        text: randomText(r, canvas),
      } as EditableBuildPayload;
    case "green-screen":
      return {
        canvas,
        image: m,
        video: m,
        text: randomText(r, canvas),
      } as EditableBuildPayload;
    default:
      return {
        canvas,
        hook_video: m,
        demo_video: m,
        text: randomText(r, canvas),
      } as EditableBuildPayload;
  }
}

/**
 * Lo que el render ve de un texto: los opcionales resueltos con los defaults
 * del adaptador y del servicio (peso 400, stroke 3/#000000, familia inter).
 * Dos textos con la misma vista renderizan igual y tienen la misma clave de cache.
 */
function rendered(t: EditableBuildText, family: string | undefined) {
  return {
    content: t.content,
    x: t.x,
    y: t.y,
    width: t.width,
    fontSize: t.fontSize,
    color: t.color,
    textAlign: t.textAlign,
    family: family ?? "inter",
    weight: t.fontWeight ?? 400,
    stroke:
      t.strokeWidth === undefined && t.strokeColor === undefined
        ? { width: 3, color: "#000000" }
        : { width: t.strokeWidth ?? 3, color: t.strokeColor ?? "#000000" },
    background: t.backgroundColor ?? null,
  };
}

function textsOf(p: EditableBuildPayload): readonly (readonly EditableBuildText[])[] {
  return "num_images" in p ? p.images.map((s) => s.texts) : [[p.text]];
}

describe("ida y vuelta: apply(p, derive(p)) renderiza igual que p", () => {
  for (const format of ["slideshow", "wall-of-text", "green-screen", "video-hook"]) {
    it(`${format}: 300 payloads al azar sobre 6 canvas`, () => {
      const r = rng(format.length * 7919);
      for (let n = 0; n < 300; n++) {
        const original = randomPayload(r, format);
        const boxes = deriveTextBoxesFromBuildPayload(original);
        if (boxes.length > 0) expect(() => assertValidTextBoxes(boxes)).not.toThrow();

        const back = applyTextBoxesToBuildPayload(original, boxes);
        if (!back.ok) throw new Error(`${format} #${String(n)}: ${back.reason}`);

        const before = textsOf(original).map((s) => s.map((t) => rendered(t, undefined)));
        const after = textsOf(back.payload).map((s, i) =>
          s.map((t, k) => rendered(t, back.fontFamilies[i]?.[k])),
        );
        expect(after).toEqual(before);

        // Lo que no es texto viaja idéntico (misma referencia).
        if ("num_images" in original && "num_images" in back.payload) {
          back.payload.images.forEach((s, i) => {
            expect(s.canvas).toBe(original.images[i]?.canvas);
          });
        } else if (!("num_images" in original) && !("num_images" in back.payload)) {
          expect(back.payload.canvas).toBe(original.canvas);
        }
      }
    });
  }

  it("el caso de Blitz exacto: vuelve bit a bit, más los defaults explícitos", () => {
    const original = {
      canvas: P1920,
      video: media,
      text: blitzText,
    } as EditableBuildPayload;
    const back = applyTextBoxesToBuildPayload(
      original,
      deriveTextBoxesFromBuildPayload(original),
    );
    if (!back.ok) throw new Error(back.reason);
    expect(back.payload).toEqual(original);
    expect(back.fontFamilies).toEqual([["inter"]]);
  });
});
