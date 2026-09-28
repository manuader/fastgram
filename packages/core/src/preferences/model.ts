/**
 * Modelo de preferencias — sprint 9 (agente Q), `PU-S9-011`, `D-22`.
 *
 * ## Qué hace, en una frase
 *
 * Cuenta, por rasgo, cuánto aceptó y cuánto rechazó el dueño —con más peso lo
 * reciente—, lo convierte en un puntaje en [-1, 1] y, con eso, un multiplicador
 * para el peso de cada candidato. Todo explicable: cada número de la pantalla
 * «What Blitz learned» sale de una cuenta que se puede rehacer a mano.
 *
 * ## Las piezas, y los números que las calibran
 *
 * - **Señales** ({@link PREFERENCE_SIGNAL_WEIGHTS}): aceptar suma 1 a cada rasgo de la
 *   pieza; descartar resta 1. Editar resta sobre el rasgo que se sacó y suma
 *   sobre el que se puso, **débil** (0,3 después de aceptar; 0,5 antes): el
 *   dueño ya dijo que sí a la pieza, la edición corrige un detalle.
 * - **Decaimiento**: cada señal pesa `2^(-edad / vida media)`. Vida media por
 *   defecto 30 días (`D-22`): lo de hace dos meses cuenta un cuarto.
 * - **Prior Beta(1,1)**: puntaje = `2·(pos+1)/(pos+neg+2) − 1`. Sin evidencia
 *   es 0; tres aceptaciones sin rechazos dan 0,6, no 1.
 * - **Evidencia mínima** ({@link DEFAULT_PREFERENCE_MIN_EVIDENCE} = 3): por debajo, el
 *   puntaje es 0. Una sola decisión no mueve nada.
 * - **Marca + dueño**: el gusto del dueño (todas sus marcas, sin la actual)
 *   entra como prior de la marca con {@link DEFAULT_PREFERENCE_OWNER_WEIGHT} decisiones de
 *   peso. Una marca nueva hereda al dueño; una con cien decisiones propias casi
 *   no lo mira. Es el encogimiento clásico de un modelo jerárquico.
 * - **Multiplicador**: `2^(fuerza · Σ puntajes)` acotado a [1/16, 16], con
 *   fuerza {@link DEFAULT_PREFERENCE_STRENGTH} = 2: un rasgo con puntaje 1
 *   multiplica por 4 el peso del candidato; con −1 lo divide por 4. Con
 *   fuerza 1 (×2) el test de 30 decisiones apenas movía los fondos oscuros
 *   (51 % → 41 %): el dueño no lo vería.
 * - **Exploración** (default 15 %, rango 0–50 %): con esa probabilidad se
 *   elige ignorando las preferencias. Es lo que evita encerrarse: sin ella, lo
 *   que nunca se muestra nunca se puede aceptar y el modelo no se entera.
 */
import type { Rng } from "@fastgram/ports";

import {
  parsePreferenceFeature,
  type PreferenceFeatureFamily,
  type PreferenceFeatureKey,
  type PreferenceAspect,
} from "./features.js";

export const PREFERENCE_SIGNAL_KINDS = [
  "accept",
  "discard",
  "edit_before_accept",
  "edit_after_accept",
] as const;
export type PreferenceSignalKind = (typeof PREFERENCE_SIGNAL_KINDS)[number];

/** El peso de cada tipo de señal. Ver la cabecera. */
export const PREFERENCE_SIGNAL_WEIGHTS: Readonly<Record<PreferenceSignalKind, number>> = {
  accept: 1,
  discard: 1,
  edit_before_accept: 0.5,
  edit_after_accept: 0.3,
};

export const DEFAULT_PREFERENCE_EXPLORATION = 0.15;
export const PREFERENCE_EXPLORATION_RANGE = { min: 0, max: 0.5 } as const;
export const DEFAULT_PREFERENCE_HALF_LIFE_DAYS = 30;
export const PREFERENCE_HALF_LIFE_RANGE_DAYS = { min: 1, max: 365 } as const;
export const DEFAULT_PREFERENCE_MIN_EVIDENCE = 3;
/** Cuántas decisiones «vale» el gusto del dueño como prior de una marca. */
export const DEFAULT_PREFERENCE_OWNER_WEIGHT = 5;
/** Exponente del multiplicador: `2^(fuerza · Σ puntajes)`. Ver la cabecera. */
export const DEFAULT_PREFERENCE_STRENGTH = 2;
/** Techo y piso del multiplicador: 2^±4. */
export const PREFERENCE_MULTIPLIER_BOUNDS = { min: 1 / 16, max: 16 } as const;
/**
 * Más allá de diez vidas medias una señal pesa < 0,1 %: no se lee. Es lo que
 * acota el recálculo sin cambiar el resultado de forma visible.
 */
export const PREFERENCE_SIGNAL_HORIZON_HALF_LIVES = 10;

const DAY_MS = 86_400_000;

export interface PreferenceSignal {
  readonly kind: PreferenceSignalKind;
  /** Los rasgos de la pieza cuando se decidió (aceptar/descartar). */
  readonly features: readonly PreferenceFeatureKey[];
  /** Edición: lo que el dueño sacó. */
  readonly removed?: readonly PreferenceFeatureKey[] | undefined;
  /** Edición: lo que el dueño puso. */
  readonly added?: readonly PreferenceFeatureKey[] | undefined;
  /** Por defecto, {@link PREFERENCE_SIGNAL_WEIGHTS}[kind]. */
  readonly weight?: number | undefined;
  readonly occurredAtMs: number;
}

/** Lo acumulado de un rasgo. `pos`/`neg` decaídos a `computedAtMs`. */
export interface PreferenceFeatureStat {
  readonly pos: number;
  readonly neg: number;
  /** Cuenta cruda (sin decaer) de señales a favor: «12 de 14». */
  readonly accepts: number;
  /** Cuenta cruda de todas las señales sobre el rasgo. */
  readonly total: number;
  readonly lastMs: number;
}

export interface PreferenceStats {
  readonly computedAtMs: number;
  readonly halfLifeDays: number;
  readonly signalCount: number;
  readonly features: Readonly<Record<PreferenceFeatureKey, PreferenceFeatureStat>>;
}

export const emptyPreferenceStats = (
  nowMs: number,
  halfLifeDays = DEFAULT_PREFERENCE_HALF_LIFE_DAYS,
): PreferenceStats => ({
  computedAtMs: nowMs,
  halfLifeDays,
  signalCount: 0,
  features: {},
});

export function preferenceDecayFactor(ageMs: number, halfLifeDays: number): number {
  if (ageMs <= 0) return 1;
  return 2 ** (-ageMs / (halfLifeDays * DAY_MS));
}

/** Las contribuciones de una señal: rasgo → (+w | −w). */
export function preferenceSignalContributions(
  signal: PreferenceSignal,
): { feature: PreferenceFeatureKey; delta: number }[] {
  const w = signal.weight ?? PREFERENCE_SIGNAL_WEIGHTS[signal.kind];
  switch (signal.kind) {
    case "accept":
      return signal.features.map((feature) => ({ feature, delta: w }));
    case "discard":
      return signal.features.map((feature) => ({ feature, delta: -w }));
    case "edit_before_accept":
    case "edit_after_accept":
      return [
        ...(signal.removed ?? []).map((feature) => ({ feature, delta: -w })),
        ...(signal.added ?? []).map((feature) => ({ feature, delta: w })),
      ];
  }
}

export interface PreferenceAggregateOptions {
  readonly nowMs: number;
  readonly halfLifeDays?: number | undefined;
  /** Sólo señales posteriores (el reset del dueño). */
  readonly sinceMs?: number | null | undefined;
  /** Filtra rasgos (p. ej. sólo los que pasan al nivel del dueño). */
  readonly keep?: ((feature: PreferenceFeatureKey) => boolean) | undefined;
}

/** Suma las señales en estadísticas por rasgo, decaídas a `nowMs`. */
export function aggregatePreferenceSignals(
  signals: readonly PreferenceSignal[],
  options: PreferenceAggregateOptions,
): PreferenceStats {
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_PREFERENCE_HALF_LIFE_DAYS;
  const acc = new Map<
    PreferenceFeatureKey,
    { pos: number; neg: number; accepts: number; total: number; lastMs: number }
  >();
  let count = 0;
  for (const s of signals) {
    if (
      options.sinceMs !== null &&
      options.sinceMs !== undefined &&
      s.occurredAtMs <= options.sinceMs
    ) {
      continue;
    }
    const factor = preferenceDecayFactor(options.nowMs - s.occurredAtMs, halfLifeDays);
    let counted = false;
    for (const { feature, delta } of preferenceSignalContributions(s)) {
      if (parsePreferenceFeature(feature) === null) continue;
      if (options.keep !== undefined && !options.keep(feature)) continue;
      const cur = acc.get(feature) ?? { pos: 0, neg: 0, accepts: 0, total: 0, lastMs: 0 };
      if (delta > 0) {
        cur.pos += delta * factor;
        cur.accepts += 1;
      } else {
        cur.neg += -delta * factor;
      }
      cur.total += 1;
      cur.lastMs = Math.max(cur.lastMs, s.occurredAtMs);
      acc.set(feature, cur);
      counted = true;
    }
    if (counted) count += 1;
  }
  return {
    computedAtMs: options.nowMs,
    halfLifeDays,
    signalCount: count,
    features: Object.fromEntries(acc),
  };
}

/** Las mismas estadísticas vistas desde más tarde (sólo decae `pos`/`neg`). */
export function decayPreferenceStats(
  stats: PreferenceStats,
  toMs: number,
): PreferenceStats {
  const f = preferenceDecayFactor(toMs - stats.computedAtMs, stats.halfLifeDays);
  if (f === 1) return stats;
  const features: Record<PreferenceFeatureKey, PreferenceFeatureStat> = {};
  for (const [k, s] of Object.entries(stats.features)) {
    features[k] = { ...s, pos: s.pos * f, neg: s.neg * f };
  }
  return { ...stats, computedAtMs: toMs, features };
}

/** Suma varias (p. ej. las marcas del dueño), todas llevadas a `nowMs`. */
export function mergePreferenceStats(
  list: readonly PreferenceStats[],
  nowMs: number,
  halfLifeDays = DEFAULT_PREFERENCE_HALF_LIFE_DAYS,
): PreferenceStats {
  const acc: Record<PreferenceFeatureKey, PreferenceFeatureStat> = {};
  let signalCount = 0;
  for (const raw of list) {
    const s = decayPreferenceStats(raw, nowMs);
    signalCount += s.signalCount;
    for (const [k, v] of Object.entries(s.features)) {
      const cur = acc[k];
      acc[k] =
        cur === undefined
          ? v
          : {
              pos: cur.pos + v.pos,
              neg: cur.neg + v.neg,
              accepts: cur.accepts + v.accepts,
              total: cur.total + v.total,
              lastMs: Math.max(cur.lastMs, v.lastMs),
            };
    }
  }
  return { computedAtMs: nowMs, halfLifeDays, signalCount, features: acc };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Lee estadísticas que vuelven de la base como `unknown` (`jsonb`). Tolerante:
 * lo que no tiene forma se descarta en vez de romper el refill.
 */
export function parsePreferenceStats(raw: unknown): PreferenceStats | null {
  if (!isObj(raw)) return null;
  const { computedAtMs, halfLifeDays, signalCount, features } = raw;
  if (!finite(computedAtMs) || !finite(halfLifeDays) || halfLifeDays <= 0) return null;
  const out: Record<PreferenceFeatureKey, PreferenceFeatureStat> = {};
  if (isObj(features)) {
    for (const [k, v] of Object.entries(features)) {
      if (!isObj(v)) continue;
      const { pos, neg, accepts, total, lastMs } = v;
      if (
        !finite(pos) ||
        !finite(neg) ||
        !finite(accepts) ||
        !finite(total) ||
        !finite(lastMs)
      ) {
        continue;
      }
      out[k] = { pos, neg, accepts, total, lastMs };
    }
  }
  return {
    computedAtMs,
    halfLifeDays,
    signalCount: finite(signalCount) ? signalCount : 0,
    features: out,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Puntajes
// ───────────────────────────────────────────────────────────────────────────

export interface PreferenceSettings {
  /** `false` = la marca no pondera con preferencias (multiplicador 1). */
  readonly enabled: boolean;
  readonly exploration: number;
  readonly halfLifeDays: number;
  readonly minEvidence: number;
  readonly ownerWeight: number;
  readonly strength: number;
}

export const DEFAULT_PREFERENCE_SETTINGS: PreferenceSettings = {
  enabled: true,
  exploration: DEFAULT_PREFERENCE_EXPLORATION,
  halfLifeDays: DEFAULT_PREFERENCE_HALF_LIFE_DAYS,
  minEvidence: DEFAULT_PREFERENCE_MIN_EVIDENCE,
  ownerWeight: DEFAULT_PREFERENCE_OWNER_WEIGHT,
  strength: DEFAULT_PREFERENCE_STRENGTH,
};

export const clampPreferenceExploration = (v: number): number =>
  Math.min(
    PREFERENCE_EXPLORATION_RANGE.max,
    Math.max(PREFERENCE_EXPLORATION_RANGE.min, v),
  );

/** Beta(1,1): `2·(pos+1)/(pos+neg+2) − 1`, o 0 bajo la evidencia mínima. */
export function preferenceBetaScore(
  pos: number,
  neg: number,
  minEvidence = DEFAULT_PREFERENCE_MIN_EVIDENCE,
): number {
  const evidence = pos + neg;
  if (evidence < minEvidence) return 0;
  return (2 * (pos + 1)) / (evidence + 2) - 1;
}

export interface PreferenceLevelView {
  readonly score: number;
  /** `pos + neg` decaídos: cuánto pesa hoy lo que se sabe. */
  readonly evidence: number;
  readonly accepts: number;
  readonly total: number;
}

export interface LearnedPreferenceFeature {
  readonly feature: PreferenceFeatureKey;
  readonly family: PreferenceFeatureFamily;
  readonly value: string;
  readonly aspect: PreferenceAspect | null;
  /** El puntaje que se usa: marca con el dueño como prior. En [-1, 1]. */
  readonly score: number;
  readonly brand: PreferenceLevelView | null;
  readonly owner: PreferenceLevelView | null;
}

export interface LearnedPreferences {
  readonly settings: PreferenceSettings;
  readonly features: ReadonlyMap<PreferenceFeatureKey, LearnedPreferenceFeature>;
}

function level(
  stat: PreferenceFeatureStat | undefined,
  minEvidence: number,
): PreferenceLevelView | null {
  if (stat === undefined) return null;
  return {
    score: preferenceBetaScore(stat.pos, stat.neg, minEvidence),
    evidence: stat.pos + stat.neg,
    accepts: stat.accepts,
    total: stat.total,
  };
}

/**
 * Marca con el dueño como prior: Beta con `min(ownerWeight, evidencia del
 * dueño)` pseudo-decisiones repartidas según el puntaje del dueño. Sin
 * evidencia suficiente entre las dos, 0.
 */
export function combinedPreferenceScore(
  brand: PreferenceFeatureStat | undefined,
  ownerScore: number,
  ownerEvidence: number,
  settings: Pick<PreferenceSettings, "minEvidence" | "ownerWeight">,
): number {
  const pos = brand?.pos ?? 0;
  const neg = brand?.neg ?? 0;
  if (pos + neg + ownerEvidence < settings.minEvidence) return 0;
  // El dueño no puede aportar más pseudo-decisiones que las que tomó, y bajo
  // la evidencia mínima no aporta: sin él, el prior es Beta(1,1) a secas.
  const k =
    ownerEvidence >= settings.minEvidence
      ? Math.min(settings.ownerWeight, ownerEvidence)
      : 0;
  const alpha = 1 + (k * (1 + ownerScore)) / 2;
  const beta = 1 + (k * (1 - ownerScore)) / 2;
  const mean = (pos + alpha) / (pos + neg + alpha + beta);
  return 2 * mean - 1;
}

export interface BuildPreferencesInput {
  /** Las estadísticas de la marca, o `null` si nunca decidió nada. */
  readonly brand: PreferenceStats | null;
  /** Las del dueño **sin** esta marca (para no contarla dos veces). */
  readonly owner: PreferenceStats | null;
  readonly settings?: Partial<PreferenceSettings> | undefined;
  readonly nowMs: number;
}

/** Arma las preferencias que usan {@link scoreCandidate} y la pantalla. */
export function buildPreferences(input: BuildPreferencesInput): LearnedPreferences {
  const settings: PreferenceSettings = {
    ...DEFAULT_PREFERENCE_SETTINGS,
    ...definedOnly(input.settings ?? {}),
  };
  const brand =
    input.brand === null ? null : decayPreferenceStats(input.brand, input.nowMs);
  const owner =
    input.owner === null ? null : decayPreferenceStats(input.owner, input.nowMs);
  const keys = new Set<PreferenceFeatureKey>([
    ...Object.keys(brand?.features ?? {}),
    ...Object.keys(owner?.features ?? {}),
  ]);
  const features = new Map<PreferenceFeatureKey, LearnedPreferenceFeature>();
  for (const feature of keys) {
    const parsed = parsePreferenceFeature(feature);
    if (parsed === null) continue;
    const b = brand?.features[feature];
    const o = parsed.ownerLevel ? owner?.features[feature] : undefined;
    const ownerView = level(o, settings.minEvidence);
    const score = combinedPreferenceScore(
      b,
      ownerView?.score ?? 0,
      ownerView?.evidence ?? 0,
      settings,
    );
    features.set(feature, {
      feature,
      family: parsed.family,
      value: parsed.value,
      aspect: parsed.aspect,
      score,
      brand: level(b, settings.minEvidence),
      owner: ownerView,
    });
  }
  return { settings, features };
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null),
  ) as Partial<T>;
}

export interface PreferenceCandidateScore {
  /** Por cuánto multiplicar el peso base del candidato. 1 = neutro. */
  readonly multiplier: number;
  /**
   * El multiplicador esperado contando la exploración: con probabilidad
   * `exploration` no se aplica. Útil para mostrar «cuánto más probable».
   */
  readonly expectedMultiplier: number;
  /** Qué rasgos movieron el número, de mayor a menor efecto. */
  readonly contributions: readonly { feature: PreferenceFeatureKey; score: number }[];
}

/**
 * Puntúa un candidato por sus rasgos. `features` sale de `extractPreferenceFeatures`.
 * Con las preferencias apagadas, o sin nada aprendido, es 1.
 */
export function scoreCandidate(
  features: readonly PreferenceFeatureKey[],
  prefs: LearnedPreferences,
  options: { readonly exploration?: number | undefined } = {},
): PreferenceCandidateScore {
  const exploration = clampPreferenceExploration(
    options.exploration ?? prefs.settings.exploration,
  );
  if (!prefs.settings.enabled) {
    return { multiplier: 1, expectedMultiplier: 1, contributions: [] };
  }
  const contributions: { feature: PreferenceFeatureKey; score: number }[] = [];
  let sum = 0;
  for (const f of new Set(features)) {
    const learned = prefs.features.get(f);
    if (learned === undefined || learned.score === 0) continue;
    sum += learned.score;
    contributions.push({ feature: f, score: learned.score });
  }
  contributions.sort(
    (a, b) => Math.abs(b.score) - Math.abs(a.score) || a.feature.localeCompare(b.feature),
  );
  const multiplier = Math.min(
    PREFERENCE_MULTIPLIER_BOUNDS.max,
    Math.max(PREFERENCE_MULTIPLIER_BOUNDS.min, 2 ** (prefs.settings.strength * sum)),
  );
  return {
    multiplier,
    expectedMultiplier: (1 - exploration) * multiplier + exploration,
    contributions,
  };
}

export interface PreferencePickInput<T> {
  readonly candidates: readonly T[];
  readonly featuresOf: (candidate: T) => readonly PreferenceFeatureKey[];
  /** El peso que el candidato ya tenía (content mix, ángulos). Default 1. */
  readonly baseWeightOf?: ((candidate: T) => number) | undefined;
  readonly prefs: LearnedPreferences;
  readonly rng: Rng;
  /** Por defecto, la de las preferencias. */
  readonly exploration?: number | undefined;
}

export interface PreferencePickResult<T> {
  readonly picked: T;
  /** `true` = esta vez se ignoraron las preferencias. */
  readonly explored: boolean;
}

/**
 * Elige un candidato: con probabilidad `exploration`, sólo con su peso base;
 * si no, con el peso base por {@link scoreCandidate}. Usa el puerto `Rng`, así
 * que es determinista con una semilla fija. Lanza con la lista vacía (igual
 * que `Rng.weightedPick`).
 */
export function pickWithExploration<T>(
  input: PreferencePickInput<T>,
): PreferencePickResult<T> {
  if (input.candidates.length === 0)
    throw new Error("pickWithExploration sin candidatos");
  const exploration = clampPreferenceExploration(
    input.exploration ?? input.prefs.settings.exploration,
  );
  const base = (c: T): number => Math.max(0, input.baseWeightOf?.(c) ?? 1);
  const explored = !input.prefs.settings.enabled || input.rng.next() < exploration;
  const items = input.candidates.map((c) => ({
    value: c,
    weight: explored
      ? base(c)
      : base(c) * scoreCandidate(input.featuresOf(c), input.prefs).multiplier,
  }));
  return { picked: input.rng.weightedPick(items), explored };
}

// ───────────────────────────────────────────────────────────────────────────
// Lo que se muestra
// ───────────────────────────────────────────────────────────────────────────

export interface PreferenceInsight {
  readonly feature: PreferenceFeatureKey;
  readonly family: PreferenceFeatureFamily;
  readonly value: string;
  readonly aspect: PreferenceAspect | null;
  readonly direction: "likes" | "avoids";
  readonly score: number;
  /** Las cuentas crudas de la marca si las tiene; si no, las del dueño. */
  readonly accepts: number;
  readonly total: number;
  readonly evidence: number;
  /** De dónde sale el puntaje. */
  readonly source: "brand" | "owner" | "both";
}

/**
 * Lo aprendido, ordenado por fuerza (|puntaje|) y con su evidencia. Las frases
 * las arma la web con estos campos: son plantillas, no un LLM.
 */
export function describeLearnedPreferences(
  prefs: LearnedPreferences,
  options: {
    readonly limit?: number | undefined;
    readonly minAbsScore?: number | undefined;
  } = {},
): PreferenceInsight[] {
  const min = options.minAbsScore ?? 0.05;
  const out: PreferenceInsight[] = [];
  for (const f of prefs.features.values()) {
    if (Math.abs(f.score) < min) continue;
    const brandHas = f.brand !== null && f.brand.evidence >= prefs.settings.minEvidence;
    const ownerHas = f.owner !== null && f.owner.score !== 0;
    const counts = f.brand ?? f.owner;
    out.push({
      feature: f.feature,
      family: f.family,
      value: f.value,
      aspect: f.aspect,
      direction: f.score > 0 ? "likes" : "avoids",
      score: round3(f.score),
      accepts: counts?.accepts ?? 0,
      total: counts?.total ?? 0,
      evidence: round3((f.brand?.evidence ?? 0) + (f.owner?.evidence ?? 0)),
      source: brandHas && ownerHas ? "both" : brandHas ? "brand" : "owner",
    });
  }
  out.sort(
    (a, b) => Math.abs(b.score) - Math.abs(a.score) || a.feature.localeCompare(b.feature),
  );
  return options.limit === undefined ? out : out.slice(0, options.limit);
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

// ───────────────────────────────────────────────────────────────────────────
// Cargar (para el refill, el decisor y el planificador de reels)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Lo que la base guarda de una marca y de su dueño. Estructural: lo implementa
 * `preferenceSnapshotStore` de `@fastgram/db` sin que `core` lo importe.
 */
export interface PreferenceSnapshot {
  readonly brand: {
    readonly enabled: boolean;
    /** `null` = hereda la del dueño. */
    readonly exploration: number | null;
    readonly halfLifeDays: number | null;
    readonly stats: unknown;
  } | null;
  readonly owner: {
    readonly exploration: number;
    readonly halfLifeDays: number;
    /** companyId → estadísticas que esa marca aporta al dueño. */
    readonly brandStats: Readonly<Record<string, unknown>>;
  } | null;
}

export interface PreferenceSnapshotStore {
  load(companyId: string): Promise<PreferenceSnapshot>;
}

/** La configuración efectiva: la de la marca, o la del dueño, o el default. */
export function effectivePreferenceSettings(
  snapshot: PreferenceSnapshot,
): PreferenceSettings {
  return {
    ...DEFAULT_PREFERENCE_SETTINGS,
    enabled: snapshot.brand?.enabled ?? true,
    exploration: clampPreferenceExploration(
      snapshot.brand?.exploration ??
        snapshot.owner?.exploration ??
        DEFAULT_PREFERENCE_EXPLORATION,
    ),
    halfLifeDays:
      snapshot.brand?.halfLifeDays ??
      snapshot.owner?.halfLifeDays ??
      DEFAULT_PREFERENCE_HALF_LIFE_DAYS,
  };
}

/** Las estadísticas del dueño, sumando sus marcas; `exclude` saca una. */
export function ownerPreferenceStats(
  snapshot: PreferenceSnapshot,
  nowMs: number,
  exclude?: string,
): PreferenceStats | null {
  if (snapshot.owner === null) return null;
  const list: PreferenceStats[] = [];
  for (const [companyId, raw] of Object.entries(snapshot.owner.brandStats)) {
    if (companyId === exclude) continue;
    const parsed = parsePreferenceStats(raw);
    if (parsed !== null) list.push(parsed);
  }
  return list.length === 0
    ? null
    : mergePreferenceStats(list, nowMs, snapshot.owner.halfLifeDays);
}

/** Las preferencias de una marca desde un snapshot ya leído. */
export function preferencesFromSnapshot(
  companyId: string,
  snapshot: PreferenceSnapshot,
  nowMs: number,
): LearnedPreferences {
  return buildPreferences({
    brand: parsePreferenceStats(snapshot.brand?.stats ?? null),
    owner: ownerPreferenceStats(snapshot, nowMs, companyId),
    settings: effectivePreferenceSettings(snapshot),
    nowMs,
  });
}

/**
 * **La entrada de la segunda tanda** (`PU-S9-015`): las preferencias de una
 * marca, listas para {@link scoreCandidate} / {@link pickWithExploration}.
 *
 * ```ts
 * const prefs = await loadPreferences(preferenceSnapshotStore(tx), companyId, {
 *   nowMs: clock.nowMs(),
 * });
 * const { multiplier } = scoreCandidate(extractPreferenceFeatures(subject), prefs);
 * ```
 *
 * Nunca lanza por datos raros (una fila ilegible = sin preferencias); sí
 * propaga un error de la base, para que quien llama decida si seguir sin ellas.
 */
export async function loadPreferences(
  store: PreferenceSnapshotStore,
  companyId: string,
  options: { readonly nowMs: number },
): Promise<LearnedPreferences> {
  return preferencesFromSnapshot(companyId, await store.load(companyId), options.nowMs);
}
