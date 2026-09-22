/**
 * `P2-RENDER-016` — el canvas impar.
 *
 * Lo que se mide es la decisión, no el mensaje: un canvas impar en un formato de
 * VIDEO se rechaza en la validación, y en el slideshow no, porque el slideshow
 * no pasa por libx264. El porqué está en `canvas.ts`.
 */
import { describe, expect, it } from "vitest";
import { classifyStderr } from "../ffmpeg/run.js";
import { canvasForAspect, evenCanvasSchema, isEvenCanvas } from "./canvas.js";
import { buildPayloadSchema } from "./payload.js";

const text = {
  id: "t1",
  text: "hola",
  position: { x: 50, y: 50 },
  widthPercent: 80,
  font: { family: "inter", weight: 400, size: 24 },
};

function videoPayload(canvas: { width: number; height: number }): unknown {
  return {
    type: "wall-of-text",
    canvas,
    video: { url: "https://cdn.example.com/media/ws-1/v.mp4" },
    texts: [text],
  };
}

describe("canvas par", () => {
  it("acepta un canvas par", () => {
    expect(evenCanvasSchema.safeParse({ width: 1080, height: 1920 }).success).toBe(true);
  });

  it("rechaza el canvas medido que mataba el build: 1081×1921", () => {
    const parsed = evenCanvasSchema.safeParse({ width: 1081, height: 1921 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // Los dos ejes, cada uno con su ruta: quien llama tiene que poder arreglar
    // los dos de una sola vez.
    expect(parsed.error.issues.map((issue) => issue.path.join("."))).toEqual([
      "width",
      "height",
    ]);
    expect(parsed.error.issues[0]?.message).toContain("1080");
  });

  it("un solo eje impar también alcanza", () => {
    expect(evenCanvasSchema.safeParse({ width: 1080, height: 1921 }).success).toBe(false);
    expect(evenCanvasSchema.safeParse({ width: 1081, height: 1920 }).success).toBe(false);
  });

  it("los canvas que produce el servicio desde el aspect ratio ya son pares", () => {
    for (const aspect of ["1:1", "4:5", "3:4", "9:16"] as const) {
      expect(isEvenCanvas(canvasForAspect(aspect))).toBe(true);
    }
  });
});

describe("el payload de build", () => {
  it("los tres formatos de video rechazan el canvas impar antes de tocar ffmpeg", () => {
    const parsed = buildPayloadSchema.safeParse(
      videoPayload({ width: 1081, height: 1921 }),
    );
    expect(parsed.success).toBe(false);
  });

  /**
   * El slideshow sale por sharp a JPEG y rinde perfecto con dimensiones
   * impares. Rechazarlo sería aplicar una restricción del encoder donde el
   * encoder no está.
   */
  it("el slideshow SÍ acepta un canvas impar: no pasa por libx264", () => {
    const parsed = buildPayloadSchema.safeParse({
      type: "slideshow",
      numImages: 1,
      slides: [
        {
          canvas: { width: 1081, height: 1351, aspectRatio: "4:5" },
          image: { url: "https://cdn.example.com/media/ws-1/a.png" },
          texts: [text],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("la red de seguridad en el stderr", () => {
  /**
   * El stderr real de ffmpeg 9.0.1 con `scale=1081:1921`, medido el 2026-09-22.
   * Salía como `render_failed` (500), que el adaptador clasifica como
   * REINTENTABLE: tres encodes completos para un error de payload.
   */
  it("«width not divisible by 2» es bad_request, no render_failed", () => {
    expect(classifyStderr("[libx264 @ 0x1] width not divisible by 2 (1081x1921)")).toBe(
      "bad_request",
    );
    expect(classifyStderr("[libx264 @ 0x1] height not divisible by 2 (1080x1921)")).toBe(
      "bad_request",
    );
  });

  it("lo que no reconoce sigue siendo render_failed", () => {
    expect(classifyStderr("algo raro pasó adentro de ffmpeg")).toBe("render_failed");
  });
});
