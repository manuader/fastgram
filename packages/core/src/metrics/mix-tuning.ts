/**
 * Auto-tune del content mix — `PU-AUTO-004` («métricas de vuelta y ajuste de
 * pesos»), `FR-055` (los cuatro pesos suman 100), `AI-012` (regla dura).
 *
 * Una función pura: con las métricas de las últimas publicaciones por
 * formato, **propone** pesos nuevos para `slideshowWeight` /
 * `wallOfTextWeight` / `greenScreenWeight` / `videoHookWeight`. Quién la
 * aplica, cuándo y cómo se registra es del worker (`metrics-sync`).
 *
 * ## Las cuatro reglas, y por qué cada una
 *
 * 1. **Un formato con peso 0 queda en 0** (`AI-012`: *«un tipo con peso 0 está
 *    excluido, no es fallback»*). El usuario lo apagó; que rinda bien en posts
 *    viejos no lo revive. Tampoco recibe puntos al redondear.
 * 2. **El cambio por ciclo está acotado** ({@link MIX_TUNING_DEFAULTS.maxStepPoints},
 *    ±10 puntos por formato). Con pocas publicaciones el engagement es ruido;
 *    un ajuste grande por una semana buena le cambiaría la marca al usuario
 *    sin que lo decida.
 * 3. **Exploración mínima** ({@link MIX_TUNING_DEFAULTS.minExplorationPoints},
 *    5 puntos): el ajuste nunca baja un formato activo por debajo de eso. Sin
 *    exploración, un formato que tuvo mala suerte deja de generarse y nunca
 *    más produce la evidencia para volver a subir. Si el usuario ya lo tenía
 *    por debajo (p. ej. 3), el ajuste no lo baja más, pero tampoco lo sube a
 *    la fuerza.
 * 4. **Suma exacta 100**, con enteros: es el CHECK de `blitz_preferences`.
 *
 * ## Cómo se mide «rindió mejor»
 *
 * El engagement rate no se compara entre redes (una vista de X es una
 * impresión; una de Instagram, una reproducción). Así que cada post se
 * **normaliza por su red**: su tasa dividida por la tasa media de esa red en
 * la misma muestra. Un formato puntúa la media de sus posts normalizados; 1 =
 * «como el promedio».
 *
 * Con esos puntajes, el objetivo es multiplicativo (`peso × puntaje`,
 * reescalado a 100) y el paso real es ese objetivo **acotado por las reglas 2
 * y 3 con un mismo factor para todos**, que es lo que mantiene la suma en 100
 * sin tener que decidir a quién sacarle la diferencia.
 *
 * Un formato activo con menos de {@link MIX_TUNING_DEFAULTS.minSamplesPerFormat}
 * posts medidos puntúa 1 (sin evidencia, neutral). Si menos de dos formatos
 * tienen evidencia no hay nada que comparar y no se cambia nada.
 */
import { DomainError } from "../errors.js";
import type { ContentMixWeight } from "../discovery/blitz-preferences.js";
import { engagementRate, type EngagementInput } from "./engagement.js";

export const MIX_FORMATS = [
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
] as const;
export type MixFormat = (typeof MIX_FORMATS)[number];

/** Formato → columna de `blitz_preferences`. */
export const MIX_FORMAT_WEIGHT_FIELD: Readonly<Record<MixFormat, ContentMixWeight>> = {
  slideshow: "slideshowWeight",
  "wall-of-text": "wallOfTextWeight",
  "green-screen": "greenScreenWeight",
  "video-hook": "videoHookWeight",
};

export type FormatWeights = Readonly<Record<MixFormat, number>>;

export const MIX_TUNING_DEFAULTS = {
  maxStepPoints: 10,
  minExplorationPoints: 5,
  minSamplesPerFormat: 3,
  /** Las últimas N publicaciones medidas por formato. */
  samplesPerFormat: 20,
  /**
   * Un post entra a la muestra recién a las 48 h: antes, sus números todavía
   * se asientan (Instagram: hasta 48 h de demora) y castigarían a lo nuevo.
   */
  settleHours: 48,
  /** Cada cuánto se aplica. «Semanal» es lo que pidió el dueño. */
  intervalDays: 7,
} as const;

export interface MixTuningOptions {
  readonly maxStepPoints?: number;
  readonly minExplorationPoints?: number;
  readonly minSamplesPerFormat?: number;
}

export interface MixSample extends EngagementInput {
  readonly format: MixFormat;
  readonly network: string;
}

export interface FormatStat {
  readonly format: MixFormat;
  /** Posts de este formato con tasa calculable. */
  readonly samples: number;
  /** Media de las tasas normalizadas por red; `null` sin muestras. */
  readonly score: number | null;
}

export type MixTuningUnchangedReason =
  "single_active_format" | "insufficient_data" | "no_significant_difference";

export type MixTuningOutcome =
  | {
      readonly kind: "changed";
      readonly from: FormatWeights;
      readonly to: FormatWeights;
      readonly stats: readonly FormatStat[];
    }
  | {
      readonly kind: "unchanged";
      readonly reason: MixTuningUnchangedReason;
      readonly from: FormatWeights;
      readonly stats: readonly FormatStat[];
    };

function assertWeights(w: FormatWeights): void {
  let sum = 0;
  for (const f of MIX_FORMATS) {
    const v = w[f];
    if (!Number.isInteger(v) || v < 0) {
      throw new DomainError("out_of_range", "Format weights must be whole numbers ≥ 0.", {
        format: f,
        value: v,
      });
    }
    sum += v;
  }
  if (sum !== 100) {
    throw new DomainError("out_of_range", "Format weights must add up to 100.", { sum });
  }
}

/** Puntaje por formato: media de la tasa de cada post dividida por la media de su red. */
export function formatStats(samples: readonly MixSample[]): FormatStat[] {
  const byNetwork = new Map<string, number[]>();
  const rated: { format: MixFormat; network: string; rate: number }[] = [];
  for (const s of samples) {
    const rate = engagementRate(s);
    if (rate === null) continue;
    rated.push({ format: s.format, network: s.network, rate });
    const list = byNetwork.get(s.network) ?? [];
    list.push(rate);
    byNetwork.set(s.network, list);
  }
  const baseline = new Map<string, number>();
  for (const [network, rates] of byNetwork) {
    baseline.set(network, rates.reduce((a, b) => a + b, 0) / rates.length);
  }
  return MIX_FORMATS.map((format) => {
    const normalized: number[] = [];
    for (const r of rated) {
      if (r.format !== format) continue;
      const base = baseline.get(r.network) ?? 0;
      // Una red donde todo dio 0 no dice nada de ningún formato.
      if (base > 0) normalized.push(r.rate / base);
    }
    return {
      format,
      samples: normalized.length,
      score:
        normalized.length === 0
          ? null
          : normalized.reduce((a, b) => a + b, 0) / normalized.length,
    };
  });
}

/**
 * Enteros que suman `total`, lo más cerca posible de `raw` (mayor resto). Los
 * formatos fuera de `eligible` quedan exactamente como vinieron (los de peso 0
 * no reciben el punto que sobra, `AI-012`).
 */
function roundToTotal(
  raw: Readonly<Record<MixFormat, number>>,
  eligible: readonly MixFormat[],
  total: number,
): Record<MixFormat, number> {
  const out = {} as Record<MixFormat, number>;
  let assigned = 0;
  for (const f of MIX_FORMATS) {
    // `+ 1e-9`: un 34.999999 que es 35 en la aritmética exacta no pierde el punto.
    out[f] = eligible.includes(f) ? Math.floor(raw[f] + 1e-9) : raw[f];
    assigned += out[f];
  }
  let left = total - assigned;
  const byRemainder = [...eligible].sort(
    (a, b) => raw[b] - Math.floor(raw[b] + 1e-9) - (raw[a] - Math.floor(raw[a] + 1e-9)),
  );
  for (const f of byRemainder) {
    if (left <= 0) break;
    out[f] += 1;
    left -= 1;
  }
  return out;
}

export function proposeFormatWeights(
  current: FormatWeights,
  samples: readonly MixSample[],
  options: MixTuningOptions = {},
): MixTuningOutcome {
  assertWeights(current);
  const step = options.maxStepPoints ?? MIX_TUNING_DEFAULTS.maxStepPoints;
  const floor = options.minExplorationPoints ?? MIX_TUNING_DEFAULTS.minExplorationPoints;
  const minSamples =
    options.minSamplesPerFormat ?? MIX_TUNING_DEFAULTS.minSamplesPerFormat;
  if (step <= 0 || floor < 0 || floor * MIX_FORMATS.length > 100) {
    throw new DomainError("out_of_range", "Invalid mix tuning options.", { step, floor });
  }

  const stats = formatStats(samples);
  const from: FormatWeights = { ...current };
  const active = MIX_FORMATS.filter((f) => current[f] > 0);
  if (active.length < 2)
    return { kind: "unchanged", reason: "single_active_format", from, stats };

  const statOf = new Map(stats.map((s) => [s.format, s]));
  const evidenced = active.filter((f) => (statOf.get(f)?.samples ?? 0) >= minSamples);
  if (evidenced.length < 2)
    return { kind: "unchanged", reason: "insufficient_data", from, stats };

  const score = (f: MixFormat): number =>
    evidenced.includes(f) ? (statOf.get(f)?.score ?? 1) : 1;
  const mass = active.reduce((acc, f) => acc + current[f] * score(f), 0);
  if (mass <= 0)
    return { kind: "unchanged", reason: "no_significant_difference", from, stats };

  // Objetivo multiplicativo y el delta hacia él (suma 0 entre los activos).
  const delta = {} as Record<MixFormat, number>;
  for (const f of MIX_FORMATS) {
    delta[f] = active.includes(f) ? (100 * current[f] * score(f)) / mass - current[f] : 0;
  }

  // Regla 3: lo que ya está en el piso (o debajo) no baja más.
  for (const f of active) if (delta[f] < 0 && current[f] <= floor) delta[f] = 0;
  // …y eso rompe la suma 0: se achica el lado que sobra.
  const up = active.reduce((a, f) => a + Math.max(0, delta[f]), 0);
  const down = active.reduce((a, f) => a + Math.max(0, -delta[f]), 0);
  if (up === 0 || down === 0) {
    return { kind: "unchanged", reason: "no_significant_difference", from, stats };
  }
  for (const f of active) {
    if (delta[f] > 0 && up > down) delta[f] *= down / up;
    if (delta[f] < 0 && down > up) delta[f] *= up / down;
  }

  // Reglas 2 y 3 con un único factor: la suma sigue en 0.
  let scale = 1;
  for (const f of active) {
    const d = delta[f];
    if (d === 0) continue;
    scale = Math.min(scale, step / Math.abs(d));
    if (d < 0) scale = Math.min(scale, (current[f] - floor) / -d);
  }
  const raw = {} as Record<MixFormat, number>;
  for (const f of MIX_FORMATS) raw[f] = current[f] + scale * delta[f];

  const to = roundToTotal(raw, active, 100);
  if (MIX_FORMATS.every((f) => to[f] === current[f])) {
    return { kind: "unchanged", reason: "no_significant_difference", from, stats };
  }
  return { kind: "changed", from, to, stats };
}

/**
 * La muestra: posts **asentados** (≥ `settleHours` desde `postedAt`), con
 * métricas sincronizadas, de los cuatro formatos, los `samplesPerFormat` más
 * recientes de cada uno.
 */
export interface MixCandidatePost extends EngagementInput {
  readonly format: string;
  readonly network: string;
  readonly postedAtMs: number;
  readonly syncedAtMs: number | null;
}

export function selectMixSamples(
  posts: readonly MixCandidatePost[],
  nowMs: number,
  options: { readonly samplesPerFormat?: number; readonly settleHours?: number } = {},
): MixSample[] {
  const perFormat = options.samplesPerFormat ?? MIX_TUNING_DEFAULTS.samplesPerFormat;
  const settleMs = (options.settleHours ?? MIX_TUNING_DEFAULTS.settleHours) * 3_600_000;
  const isFormat = (v: string): v is MixFormat =>
    (MIX_FORMATS as readonly string[]).includes(v);
  const sorted = [...posts]
    .filter((p) => p.syncedAtMs !== null && p.postedAtMs <= nowMs - settleMs)
    .sort((a, b) => b.postedAtMs - a.postedAtMs);
  const taken = new Map<MixFormat, number>();
  const out: MixSample[] = [];
  for (const p of sorted) {
    if (!isFormat(p.format)) continue;
    const n = taken.get(p.format) ?? 0;
    if (n >= perFormat) continue;
    taken.set(p.format, n + 1);
    out.push({
      format: p.format,
      network: p.network,
      views: p.views,
      likes: p.likes,
      comments: p.comments,
      shares: p.shares,
    });
  }
  return out;
}

/** ¿Toca correr el auto-tune? Semanal, con la misma holgura que el sync. */
export function isMixTuningDue(lastRunAtMs: number | null, nowMs: number): boolean {
  if (lastRunAtMs === null) return true;
  const interval = MIX_TUNING_DEFAULTS.intervalDays * 86_400_000;
  return nowMs - lastRunAtMs >= interval - 5 * 60_000;
}
