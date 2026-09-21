/**
 * `P2-RENDER-010` — el corte del hash es lo que hace que una edición menor no
 * re-encodee el fondo (IMPL §5, palanca de costo #2).
 */
import { describe, expect, it } from "vitest";
import { buildPayloadSchema, type BuildPayload } from "./payload.js";
import { canonicalJson, computeCacheKeys } from "./hash.js";

const text = {
  id: "t1",
  text: "hola",
  position: { x: 50, y: 80 },
  widthPercent: 80,
  font: { family: "inter", weight: 600, size: 32 },
};

function wallOfText(overrides: Record<string, unknown> = {}): BuildPayload {
  return buildPayloadSchema.parse({
    type: "wall-of-text",
    canvas: { width: 1080, height: 1920 },
    video: { url: "https://cdn.example.com/media/ws-1/v.mp4" },
    audio: { url: "https://library.example.com/audio/a.m4a" },
    texts: [text],
    ...overrides,
  });
}

describe("claves de cache", () => {
  it("el mismo payload da las mismas claves", () => {
    expect(computeCacheKeys(wallOfText())).toEqual(computeCacheKeys(wallOfText()));
  });

  it("cambiar SÓLO el texto deja intacto mediaKey y cambia overlayKey y buildKey", () => {
    const before = computeCacheKeys(wallOfText());
    const after = computeCacheKeys(
      wallOfText({ texts: [{ ...text, text: "otra copy" }] }),
    );
    expect(after.mediaKey).toBe(before.mediaKey);
    expect(after.overlayKey).not.toBe(before.overlayKey);
    expect(after.buildKey).not.toBe(before.buildKey);
  });

  it("cambiar tipografía, color o posición tampoco re-encodea el fondo", () => {
    const before = computeCacheKeys(wallOfText());
    for (const override of [
      { texts: [{ ...text, color: "#FF0000" }] },
      { texts: [{ ...text, position: { x: 10, y: 10 } }] },
      { texts: [{ ...text, font: { family: "anton", weight: 400, size: 48 } }] },
      { texts: [{ ...text, stroke: { width: 8, color: "#112233" } }] },
    ]) {
      const after = computeCacheKeys(wallOfText(override));
      expect(after.mediaKey).toBe(before.mediaKey);
      expect(after.buildKey).not.toBe(before.buildKey);
    }
  });

  it("cambiar el video SÍ cambia mediaKey", () => {
    const before = computeCacheKeys(wallOfText());
    const after = computeCacheKeys(
      wallOfText({ video: { url: "https://cdn.example.com/media/ws-1/otro.mp4" } }),
    );
    expect(after.mediaKey).not.toBe(before.mediaKey);
  });

  it("cambiar el recorte o el focal cambia mediaKey", () => {
    const before = computeCacheKeys(wallOfText());
    const stretched = computeCacheKeys(
      wallOfText({
        video: { url: "https://cdn.example.com/media/ws-1/v.mp4", fit: "stretch" },
      }),
    );
    expect(stretched.mediaKey).not.toBe(before.mediaKey);
  });

  it("cambiar el canvas cambia las dos claves: afecta al encode y al layout del texto", () => {
    const before = computeCacheKeys(wallOfText());
    const after = computeCacheKeys(wallOfText({ canvas: { width: 1080, height: 1350 } }));
    expect(after.mediaKey).not.toBe(before.mediaKey);
    expect(after.overlayKey).not.toBe(before.overlayKey);
  });
});

describe("canonicalJson", () => {
  it("no depende del orden de las claves", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("ignora undefined y normaliza -0", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: -0 })).toBe(canonicalJson({ a: 0 }));
  });

  it("falla ante un número no finito en vez de hashear NaN", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
  });
});
