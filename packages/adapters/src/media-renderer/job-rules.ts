/**
 * Reglas de `RenderJob` que **no dependen del motor** — `FR-070`, `DATA-009`,
 * IMPL §5.
 *
 * Existe para que los dos adaptadores de `MediaRenderer` —el de memoria y el
 * HTTP— compartan una sola definición de tres cosas que tienen que ser
 * idénticas o el sistema miente:
 *
 *  1. **La validación del payload normativo.** `MemoryMediaRenderer` ya decía
 *     en su cabecera que «es la parte del puerto que no depende del motor, así
 *     que conviene que sea idéntica en los dos adaptadores». Dos copias de la
 *     misma regla es la forma de la trampa 19 (`docs/HANDOFF.md`): un nombre
 *     escrito de los dos lados ya divergió una vez, y la divergencia no falla,
 *     **pasa desapercibida**. Acá hay una sola.
 *  2. **La serialización canónica del fingerprint.** `core` arma los payloads
 *     con spreads, y dos spreads en distinto orden dan el mismo objeto con
 *     distinto `JSON.stringify`. Sin canonicalizar, el cache de IMPL §5 falla
 *     de forma intermitente y por una razón invisible en el diff.
 *  3. **Qué canvas describe a un job**, que es de dónde salen el `width` y el
 *     `height` de `RenderedMedia`.
 *
 * El `source` entra por parámetro porque es lo único que cambia entre
 * adaptadores: un `PortError` tiene que decir qué adaptador lo produjo
 * (`MediaRenderer/memory` vs `MediaRenderer/http`).
 */

import {
  MAX_FONT_SIZE,
  MAX_SLIDES,
  MIN_FONT_SIZE,
  PortError,
  SLIDE_ASPECT_RATIOS,
  type Canvas,
  type RenderJob,
  type RenderText,
} from "@fastgram/ports";

/* ------------------------------------------------------------------------ *
 * Validación del payload normativo de `FR-070`
 * ------------------------------------------------------------------------ */

export function assertJobIsValid(job: RenderJob, source: string): void {
  if (job.format === "slideshow") {
    if (job.num_images !== job.images.length) {
      // El error que el contrato público menciona explícitamente. Dejarlo
      // pasar produce un slideshow corto sin avisar.
      throw new PortError(
        "bad_request",
        "num_images does not match the number of images",
        { source },
      );
    }
    if (job.images.length === 0 || job.images.length > MAX_SLIDES) {
      throw new PortError(
        "bad_request",
        `a slideshow needs between 1 and ${String(MAX_SLIDES)} slides`,
        { source },
      );
    }
    for (const slide of job.images) {
      assertCanvas(slide.canvas, source);
      if (!SLIDE_ASPECT_RATIOS.includes(slide.canvas.aspectRatio)) {
        throw new PortError("bad_request", "unknown aspect ratio", { source });
      }
      for (const text of slide.texts) assertText(text, source);
    }
    return;
  }

  assertCanvas(job.canvas, source);
  assertText(job.text, source);
}

function assertCanvas(canvas: Canvas, source: string): void {
  if (canvas.width <= 0 || canvas.height <= 0) {
    throw new PortError("bad_request", "canvas without dimensions", { source });
  }
}

function assertText(text: RenderText, source: string): void {
  if (text.fontSize < MIN_FONT_SIZE || text.fontSize > MAX_FONT_SIZE) {
    throw new PortError(
      "bad_request",
      `fontSize must be between ${String(MIN_FONT_SIZE)} and ${String(MAX_FONT_SIZE)}`,
      { source },
    );
  }
}

/**
 * El canvas que describe al job. Para un slideshow es el del slide pedido:
 * todos comparten aspect ratio pero no tienen por qué compartir dimensiones en
 * píxeles.
 */
export function canvasOf(job: RenderJob, source: string, index = 0): Canvas {
  if (job.format !== "slideshow") return job.canvas;
  const slide = job.images[index];
  if (slide === undefined) {
    throw new PortError("bad_request", "a slideshow needs at least one slide", {
      source,
    });
  }
  return slide.canvas;
}

/* ------------------------------------------------------------------------ *
 * Serialización canónica
 * ------------------------------------------------------------------------ */

/**
 * `JSON.stringify` con las claves ordenadas en todos los niveles.
 *
 * Es lo que hace que el fingerprint no dependa del orden en que `core` haya
 * armado el objeto. El tipo de entrada es `unknown` y el recorrido es
 * defensivo a propósito: el job es un tipo cerrado hoy, pero el hash tiene que
 * seguir siendo estable si mañana le agregan un campo opcional.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(",")}}`;
}
