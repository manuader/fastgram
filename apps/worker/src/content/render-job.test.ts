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

import { formatOf, toRenderJob } from "./render-job.js";

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
