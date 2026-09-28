/**
 * El mapeo de `buildPayload` a {@link RenderJob} — `FR-070`.
 *
 * Lo que persigue este archivo no es "convierte un objeto en otro". Son tres
 * cosas que, de fallar, fallan en silencio:
 *
 *  1. Que la **discriminación por forma** coincida con la que hizo la ruta al
 *     decidir `contents.type`. Son dos deducciones separadas en dos procesos, y
 *     si se separan, la pieza se construye con el formato equivocado.
 *  2. Que un payload sin audio **se acepte** (`FR-053.1`), que es el caso más
 *     común y el que el puerto rechazaba.
 *  3. Que un payload corrupto se rechace en vez de llegar al motor.
 */
import { describe, expect, it } from "vitest";

import type { ContentTextBox } from "@fastgram/core";

import { formatOf, toEditedRenderJob, toRenderJob, withBrandLook } from "./render-job.js";

const TEXTO = {
  content: "hola",
  x: 50,
  y: 50,
  width: 800,
  fontSize: 48,
  color: "#FFFFFF",
  textAlign: "center" as const,
};

const MEDIA = {
  url: "https://cdn.example.test/a.mp4",
  drawX: 0,
  drawY: 0,
  drawW: 1080,
  drawH: 1920,
};
const CANVAS = { width: 1080, height: 1920 };

const WALL_OF_TEXT = { canvas: CANVAS, video: MEDIA, text: TEXTO };
const GREEN_SCREEN = { canvas: CANVAS, image: MEDIA, video: MEDIA, text: TEXTO };
const VIDEO_HOOK = { canvas: CANVAS, hook_video: MEDIA, demo_video: MEDIA, text: TEXTO };
const SLIDESHOW = {
  num_images: 1,
  images: [
    {
      canvas: { width: 1080, height: 1350, aspectRatio: "4:5" as const },
      image: MEDIA,
      texts: [TEXTO],
    },
  ],
};

describe("discriminación por forma", () => {
  it("reconoce los cuatro formatos", () => {
    expect(formatOf(WALL_OF_TEXT)).toBe("wall-of-text");
    expect(formatOf(GREEN_SCREEN)).toBe("green-screen");
    expect(formatOf(VIDEO_HOOK)).toBe("video-hook");
    expect(formatOf(SLIDESHOW)).toBe("slideshow");
  });

  it("`green-screen` no se confunde con `wall-of-text` por tener `video`", () => {
    // Los dos tienen `canvas`, `video` y `text`. Lo que los separa es `image`, y
    // preguntar por `video` primero los uniría — que es el orden equivocado y el
    // que la cabecera del módulo advierte.
    expect(formatOf(GREEN_SCREEN)).not.toBe("wall-of-text");
  });
});

describe("toRenderJob", () => {
  it("acepta un wall-of-text SIN audio — FR-053.1", () => {
    // Es el payload que crea `POST /content` en su propia suite, así que si esto
    // fallara, el camino más común del producto no podría construirse nunca.
    const out = toRenderJob(WALL_OF_TEXT, "wall-of-text");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.job.format).toBe("wall-of-text");
    expect("audio" in out.job).toBe(false);
  });

  it("conserva el audio cuando viene", () => {
    const out = toRenderJob(
      { ...WALL_OF_TEXT, audio: { url: "https://cdn.example.test/s.mp3" } },
      "wall-of-text",
    );
    expect(out.ok).toBe(true);
    if (!out.ok || out.job.format !== "wall-of-text") return;
    expect(out.job.audio?.url).toBe("https://cdn.example.test/s.mp3");
  });

  it("copia los slides con su aspect ratio", () => {
    const out = toRenderJob(SLIDESHOW, "slideshow");
    expect(out.ok).toBe(true);
    if (!out.ok || out.job.format !== "slideshow") return;
    expect(out.job.num_images).toBe(1);
    expect(out.job.images[0]?.canvas.aspectRatio).toBe("4:5");
    expect(out.job.images[0]?.texts).toHaveLength(1);
  });

  it("no arrastra claves opcionales en `undefined`", () => {
    // `exactOptionalPropertyTypes` lo impide al compilar, pero el objeto que
    // llega es `unknown` y el spread podría meterlas igual en runtime. Una clave
    // presente con valor `undefined` sobrevive a `JSON.stringify` como ausente
    // en JSON pero **no** en el fingerprint del renderer, que canonicaliza el
    // objeto: sería un cache miss permanente e invisible.
    const out = toRenderJob(WALL_OF_TEXT, "wall-of-text");
    if (!out.ok || out.job.format !== "wall-of-text") throw new Error("debía mapear");
    expect(Object.keys(out.job.text)).not.toContain("fontWeight");
  });

  it("rechaza un payload que no cumple el contrato", () => {
    const out = toRenderJob({ canvas: CANVAS, video: MEDIA }, "wall-of-text");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("buildPayload");
  });

  it("rechaza `null`, que es lo que devuelve la columna cuando nadie la escribió", () => {
    // El caso real: `POST /content/custom/video` crea la pieza sin payload.
    expect(toRenderJob(null, "wall-of-text").ok).toBe(false);
  });

  it("rechaza cuando la forma del payload y el `type` de la fila no coinciden", () => {
    // Si esto pasara sin error, la pieza se construiría como otra cosa de la que
    // el usuario pidió, y la API seguiría diciendo que es un slideshow.
    const out = toRenderJob(WALL_OF_TEXT, "slideshow");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("wall-of-text");
    expect(out.reason).toContain("slideshow");
  });

  it("rechaza un fontSize fuera de rango en vez de mandarlo al motor", () => {
    // `FR-051` acota `[8, 72]`. Llega acá desde un `jsonb` que pudo escribir una
    // versión anterior del código, así que revalidarlo no es redundante.
    const out = toRenderJob(
      { ...WALL_OF_TEXT, text: { ...TEXTO, fontSize: 300 } },
      "wall-of-text",
    );
    expect(out.ok).toBe(false);
  });
});

describe("toEditedRenderJob — las cajas del editor llegan al job (PU-EDIT-002)", () => {
  const caja = (over: Partial<ContentTextBox> = {}): ContentTextBox => ({
    id: "slide-0-text-0",
    slideIndex: 0,
    text: "editado",
    position: { x: 25, y: 10 },
    widthPercent: 50,
    font: { family: "oswald", weight: 600, size: 24 },
    color: "#FF0000",
    stroke: { width: 4, color: "#00FF00" },
    background: { color: "#000000", opacity: 0.5, style: "pill" },
    ...over,
  });

  it("wall-of-text: geometría a px, fuente en unidades de editor, fontFamily puesto", () => {
    const r = toEditedRenderJob(WALL_OF_TEXT, "wall-of-text", [caja()]);
    if (!r.ok) throw new Error(r.reason);
    if (r.job.format !== "wall-of-text") throw new Error(r.job.format);
    expect(r.job.text).toEqual({
      content: "editado",
      x: 270,
      y: 192,
      width: 540,
      fontSize: 24,
      color: "#FF0000",
      textAlign: "center",
      fontWeight: 600,
      strokeWidth: 4,
      strokeColor: "#00FF00",
      backgroundColor: "#000000",
      fontFamily: "oswald",
    });
    expect(r.job.video).toEqual(MEDIA);
  });

  it("slideshow: cada slide con su canvas (1080×1350) y su familia", () => {
    const r = toEditedRenderJob(SLIDESHOW, "slideshow", [
      caja({ position: { x: 50, y: 50 } }),
    ]);
    if (!r.ok) throw new Error(r.reason);
    if (r.job.format !== "slideshow") throw new Error(r.job.format);
    expect(r.job.images[0]?.texts[0]).toMatchObject({
      x: 540,
      y: 675,
      fontFamily: "oswald",
    });
  });

  it("dos cajas en un formato de `text` singular → edit_not_renderable", () => {
    const r = toEditedRenderJob(GREEN_SCREEN, "green-screen", [
      caja(),
      caja({ id: "slide-0-text-1" }),
    ]);
    expect(r).toMatchObject({ ok: false, code: "edit_not_renderable" });
  });

  it("un payload persistido roto sigue siendo invalid_build_payload", () => {
    const r = toEditedRenderJob({ roto: true }, "wall-of-text", [caja()]);
    expect(r).toMatchObject({ ok: false, code: "invalid_build_payload" });
  });
});

describe("toEditedRenderJob — los swaps de media llegan al job (PU-EDIT-003)", () => {
  const NUEVO = { ...MEDIA, url: "https://cdn.example.test/nuevo.mp4" };

  it("green-screen: el video nuevo y su zoom reemplazan al original", () => {
    const zoom = { ...NUEVO, drawX: -270, drawY: -480, drawW: 1620, drawH: 2880 };
    const r = toEditedRenderJob(GREEN_SCREEN, "green-screen", [], {
      assets: { video: zoom },
    });
    if (!r.ok) throw new Error(r.reason);
    if (r.job.format !== "green-screen") throw new Error(r.job.format);
    expect(r.job.video).toEqual(zoom);
    expect(r.job.image).toEqual(MEDIA);
  });

  it("slideshow: Swap image for slide 1 sólo cambia ese slide", () => {
    const dos = {
      ...SLIDESHOW,
      num_images: 2,
      images: [...SLIDESHOW.images, ...SLIDESHOW.images],
    };
    const r = toEditedRenderJob(dos, "slideshow", [], {
      assets: { slides: [{ index: 1, image: NUEVO }] },
    });
    if (!r.ok) throw new Error(r.reason);
    if (r.job.format !== "slideshow") throw new Error(r.job.format);
    expect(r.job.images.map((s) => s.image.url)).toEqual([MEDIA.url, NUEVO.url]);
  });

  it("wall-of-text: No audio omite el bloque (FR-053.1)", () => {
    const conAudio = {
      ...WALL_OF_TEXT,
      audio: { url: "https://cdn.example.test/a.mp3" },
    };
    const r = toEditedRenderJob(conAudio, "wall-of-text", [], {
      assets: { audio: null },
    });
    if (!r.ok) throw new Error(r.reason);
    expect("audio" in r.job).toBe(false);
  });

  it("swaps y cajas juntos", () => {
    const r = toEditedRenderJob(
      WALL_OF_TEXT,
      "wall-of-text",
      [
        {
          id: "t0",
          text: "x",
          position: { x: 50, y: 50 },
          widthPercent: 80,
          font: { family: "inter", weight: 700, size: 18 },
          color: "#FFFFFF",
          stroke: { width: 0, color: "#000000" },
          background: null,
        },
      ],
      { assets: { video: NUEVO } },
    );
    if (!r.ok) throw new Error(r.reason);
    if (r.job.format !== "wall-of-text") throw new Error(r.job.format);
    expect(r.job.video.url).toBe(NUEVO.url);
    expect(r.job.text.content).toBe("x");
  });

  it("studioState ilegible o swap que no calza → edit_not_renderable", () => {
    expect(
      toEditedRenderJob(WALL_OF_TEXT, "wall-of-text", [], { assets: "roto" }),
    ).toMatchObject({ ok: false, code: "edit_not_renderable" });
    expect(
      toEditedRenderJob(WALL_OF_TEXT, "wall-of-text", [], { assets: { image: MEDIA } }),
    ).toMatchObject({ ok: false, code: "edit_not_renderable" });
  });
});

describe("withBrandLook · sprint 9 (S)", () => {
  const look = (licensed: boolean, logoUrls: string[] = []) => ({
    tokens: {
      colors: [],
      semantic: {
        surfaceDark: null,
        surfaceLight: null,
        textOnDark: null,
        textOnLight: null,
        accents: [],
      },
      families: [
        {
          name: "Rotis",
          id: "rotis",
          origin: "file" as const,
          category: "sans" as const,
          license: "needs_confirmation" as const,
          licenseConfirmed: licensed,
          faces: [{ weight: 700, style: "normal" as const, file: "r.otf" }],
          weights: [700],
          fallback: "montserrat",
        },
      ],
      roles: [],
      spacing: [],
    },
    fontFiles: [
      {
        familyId: "rotis",
        weight: 700,
        style: "normal" as const,
        url: "https://b/fonts/c/r.otf",
      },
    ],
    logoUrls,
  });
  const job = {
    format: "wall-of-text" as const,
    canvas: { width: 1080, height: 1920 },
    video: {
      url: "https://b/media/c/v.mp4",
      drawX: 0,
      drawY: 0,
      drawW: 1080,
      drawH: 1920,
    },
    text: {
      content: "hola",
      x: 540,
      y: 960,
      width: 900,
      fontSize: 32,
      color: "#FFFFFF",
      textAlign: "center" as const,
      fontFamily: "brand:rotis",
      fontWeight: 700,
    },
  };
  const logo = { corner: "top-right" as const, size: "small" as const, opacity: 0.9 };

  it("sin marca ni logo devuelve el mismo job (el fingerprint no se mueve)", () => {
    const plain = { ...job, text: { ...job.text, fontFamily: "inter", fontWeight: 400 } };
    expect(withBrandLook(plain, look(true), null)).toBe(plain);
    expect(withBrandLook(plain, null, logo)).toBe(plain);
  });

  it("con licencia manda las caras; con logo y variantes, la capa", () => {
    const out = withBrandLook(job, look(true, ["https://b/media/c/l.png"]), logo);
    expect(out.format === "wall-of-text" && out.text.fontFamily).toBe("brand:rotis");
    expect(out.brand).toEqual({
      fonts: [
        { id: "rotis", weight: 700, style: "normal", url: "https://b/fonts/c/r.otf" },
      ],
      logo: { images: [{ url: "https://b/media/c/l.png" }], ...logo },
    });
  });

  it("licencia destildada: reemplazo registrado, sin caras", () => {
    const out = withBrandLook(job, look(false), null);
    expect(out.format === "wall-of-text" && out.text).toMatchObject({
      fontFamily: "montserrat",
      fontWeight: 700,
    });
    expect(out.brand).toBeUndefined();
  });

  it("logo pedido pero la marca no tiene variantes: no hay capa", () => {
    const plain = { ...job, text: { ...job.text, fontFamily: "inter", fontWeight: 400 } };
    expect(withBrandLook(plain, look(true, []), logo)).toBe(plain);
  });
});
