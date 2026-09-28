/**
 * Mezcla del reel: volumen, fades y ducking como **envolventes** de volumen
 * (`data-automation`, carril `volume`) que el mezclador de HyperFrames aplica
 * igual en preview y en render.
 *
 * `data-volume` queda en 1 cuando hay carril y el volumen real va adentro de
 * los puntos: la documentación dice que el carril gana sobre un tween de
 * volumen pero no fija cómo se combina con `data-volume`, y no se adivina.
 */
import { num } from "./html.js";

/** Rampa del ducking: 250 ms para bajar y para volver. */
export const DUCK_RAMP_SEC = 0.25;

export interface Interval {
  readonly start: number;
  readonly end: number;
}

export interface EnvelopeSpec {
  readonly start: number;
  readonly end: number;
  readonly volume: number;
  readonly fadeInSec: number;
  readonly fadeOutSec: number;
  /** Tramos (hora del reel) donde la pista baja a `duckLevel`. */
  readonly ducks: readonly Interval[];
  readonly duckLevel: number;
}

export interface EnvelopePoint {
  /** Hora del reel. */
  readonly t: number;
  readonly v: number;
}

/** Une tramos que se tocan o se pisan (más cerca que dos rampas). */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && it.start <= last.end + 2 * DUCK_RAMP_SEC) {
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, it.end) };
    } else {
      out.push({ ...it });
    }
  }
  return out;
}

function gainAt(spec: EnvelopeSpec, t: number): number {
  let g = spec.volume;
  if (spec.fadeInSec > 0 && t < spec.start + spec.fadeInSec) {
    g *= Math.max(0, (t - spec.start) / spec.fadeInSec);
  }
  if (spec.fadeOutSec > 0 && t > spec.end - spec.fadeOutSec) {
    g *= Math.max(0, (spec.end - t) / spec.fadeOutSec);
  }
  for (const d of spec.ducks) {
    const down = d.start - DUCK_RAMP_SEC;
    const up = d.end + DUCK_RAMP_SEC;
    if (t <= down || t >= up) continue;
    let k: number;
    if (t < d.start) k = (t - down) / DUCK_RAMP_SEC;
    else if (t > d.end) k = (up - t) / DUCK_RAMP_SEC;
    else k = 1;
    g *= 1 - k * (1 - spec.duckLevel);
  }
  return g;
}

/**
 * Los puntos de la envolvente, en hora del reel. Vacío = volumen constante
 * (sin fades ni ducking): basta `data-volume`.
 */
export function envelopePoints(spec: EnvelopeSpec): EnvelopePoint[] {
  const ducks = spec.ducks.filter((d) => d.end > spec.start && d.start < spec.end);
  if (spec.fadeInSec <= 0 && spec.fadeOutSec <= 0 && ducks.length === 0) return [];
  const clamp = (t: number): number => Math.min(spec.end, Math.max(spec.start, t));
  const times = new Set<number>([spec.start, spec.end]);
  if (spec.fadeInSec > 0) times.add(clamp(spec.start + spec.fadeInSec));
  if (spec.fadeOutSec > 0) times.add(clamp(spec.end - spec.fadeOutSec));
  for (const d of ducks) {
    for (const t of [d.start - DUCK_RAMP_SEC, d.start, d.end, d.end + DUCK_RAMP_SEC]) {
      times.add(clamp(t));
    }
  }
  const effective: EnvelopeSpec = { ...spec, ducks };
  return [...times]
    .map((t) => Number(num(t, 3)))
    .sort((a, b) => a - b)
    .filter((t, i, all) => i === 0 || t !== all[i - 1])
    .map((t) => ({ t, v: Number(num(gainAt(effective, t), 4)) }));
}

/** Valor interpolado de la envolvente en `t` (para cortar en segmentos de loop). */
function valueAt(points: readonly EnvelopePoint[], t: number): number {
  const first = points[0];
  if (first === undefined) return 1;
  if (t <= first.t) return first.v;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as EnvelopePoint;
    const b = points[i] as EnvelopePoint;
    if (t <= b.t) {
      const span = b.t - a.t;
      return span <= 0 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / span;
    }
  }
  return (points[points.length - 1] as EnvelopePoint).v;
}

/**
 * El atributo `data-automation` para un segmento `[segStart, segEnd)` de la
 * pista (un loop se parte en segmentos, cada uno con su `<audio>`). Los `t` del
 * carril son locales al segmento.
 */
export function automationFor(
  points: readonly EnvelopePoint[],
  segStart: number,
  segEnd: number,
): string | null {
  if (points.length === 0) return null;
  const inside = points.filter((p) => p.t > segStart && p.t < segEnd);
  const local = [
    { t: 0, v: valueAt(points, segStart) },
    ...inside.map((p) => ({ t: p.t - segStart, v: p.v })),
    { t: segEnd - segStart, v: valueAt(points, segEnd) },
  ].map((p) => ({ t: Number(num(p.t, 3)), v: Number(num(p.v, 4)) }));
  return JSON.stringify({ version: 1, lanes: [{ target: "volume", points: local }] });
}

/**
 * Segmentos de una media que se repite (`loop`) o no, dentro de `[start, end)`.
 * Sin duración conocida o sin loop: un solo segmento (HyperFrames congela el
 * último frame si el archivo se acaba antes).
 */
export function segmentsOf(
  start: number,
  end: number,
  mediaStartSec: number,
  sourceSec: number | null,
  loop: boolean,
): { start: number; end: number; mediaStart: number }[] {
  const usable = sourceSec === null ? null : sourceSec - mediaStartSec;
  if (!loop || usable === null || usable <= 0.1 || usable >= end - start) {
    return [{ start, end, mediaStart: mediaStartSec }];
  }
  const out: { start: number; end: number; mediaStart: number }[] = [];
  // Tope defensivo: un clip de 0,1 s en 60 s serían 600 elementos.
  for (let s = start, i = 0; s < end - 1e-6 && i < 120; s += usable, i += 1) {
    out.push({ start: s, end: Math.min(end, s + usable), mediaStart: mediaStartSec });
  }
  return out;
}
