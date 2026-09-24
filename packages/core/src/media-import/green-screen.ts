/**
 * ¿El clip ya es de pantalla verde? — `PU-MEME-002`.
 *
 * Si el borde del cuadro es verde croma en casi todas las muestras, el clip no
 * necesita recorte: el render lo compone con su `chromakey`
 * (`services/render/src/render/formats.ts`). Es el camino gratis de
 * `PLAN-USO-PERSONAL` §4, y va antes que cualquier proveedor.
 *
 * Por qué el borde y no el cuadro entero: en un meme de croma la persona está
 * en el centro, y el centro es justo lo que no es verde. El borde es fondo casi
 * siempre; cuando no lo es (alguien cortado por el marco), baja la proporción
 * pero no la anula.
 *
 * ## Los umbrales
 *
 * Son elección nuestra, no un número publicado. Se calibraron con tres fuentes
 * sintéticas de FFmpeg (`color=0x00FF00`, `color=0x00B140` —el verde croma de
 * la industria— y `testsrc2`, un patrón con verde en una franja), medidas con
 * `FfmpegClipInspector` (5 cuadros × 60 celdas de borde, FFmpeg 9.0.1,
 * 2026-09-24): los dos verdes dan **1,00** y `testsrc2` **0,10**. El 0,6 deja
 * margen para una persona que toca el borde. El test de integración del worker
 * (`media-import.int.test.ts`) vuelve a medirlo y lo imprime.
 */
import type { RgbSample } from "@fastgram/ports";

/** Un canal verde bajo es sombra, no croma. */
const MIN_GREEN = 90;
/** Cuánto tiene que dominar el verde sobre rojo y azul en una muestra. */
const GREEN_DOMINANCE = 1.4;
/** Proporción de muestras verdes para llamar «verde» al clip. */
export const GREEN_SCREEN_MIN_SHARE = 0.6;

export function isGreenSample(s: RgbSample): boolean {
  return s.g >= MIN_GREEN && s.g >= s.r * GREEN_DOMINANCE && s.g >= s.b * GREEN_DOMINANCE;
}

export interface GreenScreenVerdict {
  readonly isGreen: boolean;
  /** Proporción de muestras verdes, 0–1. */
  readonly share: number;
  /** Promedio de las muestras verdes, `#RRGGBB`, o `null` si no hubo. */
  readonly keyColor: string | null;
}

const hex = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

export function greenScreenVerdict(samples: readonly RgbSample[]): GreenScreenVerdict {
  if (samples.length === 0) return { isGreen: false, share: 0, keyColor: null };
  const greens = samples.filter(isGreenSample);
  const share = greens.length / samples.length;
  const keyColor =
    greens.length === 0
      ? null
      : `#${hex(greens.reduce((a, s) => a + s.r, 0) / greens.length)}${hex(
          greens.reduce((a, s) => a + s.g, 0) / greens.length,
        )}${hex(greens.reduce((a, s) => a + s.b, 0) / greens.length)}`;
  return { isGreen: share >= GREEN_SCREEN_MIN_SHARE, share, keyColor };
}
