/**
 * `P2-RENDER-010` — Cache por hash del payload de build.
 *
 * Es la palanca de costo #2 del plan (IMPL §5): "el PRD dice que una edición
 * menor reconstruye el mismo contentId; si sólo cambió el texto, no re-encodear
 * el video de fondo".
 *
 * Por eso el payload se hashea EN DOS PARTES:
 *
 *   mediaKey    → todo lo que afecta al encode del fondo: URLs, geometría de
 *                 dibujo, modo de recorte, canvas, chromakey, audio, reparto
 *                 hook/demo. Un cambio acá obliga a re-encodear.
 *   overlayKey  → sólo lo que afecta al overlay: las cajas de texto, el canvas
 *                 (porque las unidades de editor se resuelven contra él) y la
 *                 versión del registro tipográfico.
 *
 * `FR-051` dice que los cambios de copy/tipografía/color/posición son *minor
 * edits*. Con este corte, una minor edit deja `mediaKey` intacto: el fondo se
 * reutiliza tal cual y sólo se recompone el overlay.
 *
 * `buildKey` combina las dos y es la clave del artefacto final.
 */
import { createHash } from "node:crypto";
import { codeVersion } from "./codeVersion.js";
import { FONT_REGISTRY_VERSION } from "./fonts.js";
import type { BuildPayload } from "./payload.js";

/**
 * Versión del motor que entra en las tres claves.
 *
 * **Antes era `"1"`**, con un comentario pidiendo que se subiera a mano en cada
 * cambio del filtergraph o del overlay. Nunca se subió, y no se iba a subir: es
 * el tipo de instrucción que funciona hasta el primer día apurado. Mientras
 * tanto, un deploy que movía la tipografía servía los MP4 viejos desde la cache
 * de este servicio, callado.
 *
 * Ahora sale del hash del código que este proceso corre (`codeVersion`): no hay
 * nada que acordarse de subir. El razonamiento completo —y lo que cuesta— está
 * en `codeVersion.ts`.
 *
 * Es el **piso**, no el techo: sólo cubre nuestro código. `computeCacheKeys`
 * acepta la etiqueta completa (`render/engineVersion.ts`), que además incluye
 * las versiones de ffmpeg, sharp/libvips/Pango/FreeType y el registro
 * tipográfico. El motor le pasa esa; el default de acá existe para los tests y
 * para cualquier uso puro, donde sondear ffmpeg no tendría sentido.
 */
export function defaultEngineVersion(): string {
  return codeVersion();
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** JSON canónico: claves ordenadas y `undefined` eliminado. Determinista. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}

function toCanonical(value: unknown): Json {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(toCanonical);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, Json> = {};
    for (const [key, v] of entries) out[key] = toCanonical(v);
    return out;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("no se puede hashear un número no finito");
    // -0 y 0 deben hashear igual.
    return value === 0 ? 0 : value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  throw new TypeError(`tipo no hasheable: ${typeof value}`);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface CacheKeys {
  readonly mediaKey: string;
  readonly overlayKey: string;
  readonly buildKey: string;
}

/** La parte del payload que afecta al encode del fondo. Sin textos. */
export function mediaFingerprint(payload: BuildPayload): unknown {
  switch (payload.type) {
    case "slideshow":
      return {
        type: payload.type,
        numImages: payload.numImages,
        slides: payload.slides.map((slide) => ({
          canvas: slide.canvas,
          image: slide.image,
        })),
      };
    case "wall-of-text":
      return {
        type: payload.type,
        canvas: payload.canvas,
        video: payload.video,
        audio: payload.audio,
      };
    case "green-screen":
      return {
        type: payload.type,
        canvas: payload.canvas,
        image: payload.image,
        video: payload.video,
        chromaKey: payload.chromaKey,
      };
    case "video-hook":
      return {
        type: payload.type,
        canvas: payload.canvas,
        hookVideo: payload.hookVideo,
        demoVideo: payload.demoVideo,
        audio: payload.audio,
        hookHeightRatio: payload.hookHeightRatio,
      };
  }
}

/** La parte que afecta sólo al overlay de texto. */
export function overlayFingerprint(payload: BuildPayload): unknown {
  const canvases =
    payload.type === "slideshow"
      ? payload.slides.map((slide) => slide.canvas)
      : [payload.canvas];
  const texts =
    payload.type === "slideshow"
      ? payload.slides.map((slide) => slide.texts)
      : [payload.texts];
  return { type: payload.type, canvases, texts, fonts: FONT_REGISTRY_VERSION };
}

export function computeCacheKeys(
  payload: BuildPayload,
  engineVersion: string = defaultEngineVersion(),
): CacheKeys {
  const mediaKey = sha256Hex(
    `${engineVersion}|media|${canonicalJson(mediaFingerprint(payload))}`,
  );
  const overlayKey = sha256Hex(
    `${engineVersion}|overlay|${canonicalJson(overlayFingerprint(payload))}`,
  );
  return {
    mediaKey,
    overlayKey,
    buildKey: sha256Hex(`${engineVersion}|build|${mediaKey}|${overlayKey}`),
  };
}
