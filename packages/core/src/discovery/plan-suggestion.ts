/**
 * Plan de una sugerencia de la discovery queue — PRD `AI-002`, `FR-055`.
 *
 * `AI-002` fija las seis decisiones y **su orden**:
 *
 *   (a) remix vs original      → `remixPercentage`
 *   (b) tipo de contenido      → los cuatro pesos
 *   (c) ángulo                 → `angleWeights`
 *   (d) influencer             → **tirada independiente** con `influencerChance`
 *   (e) fuente de media        → `ownMediaPercentage`
 *   (f) preset de caption      → `textStyleWeights`
 *
 * **El orden es parte del contrato**, no una casualidad de escritura. Con un
 * `Rng` sembrado, dos corridas con el mismo estado tienen que dar la misma
 * sugerencia: es lo que permite reproducir un caso raro que reportó un
 * usuario. Reordenar las tiradas cambia todas las salidas de un mismo seed.
 *
 * **Lo que este archivo NO decide**, y es deliberado: *cuál* tendencia se
 * remixa y *cuál* personaje se usa. El PRD lo saca de acá explícitamente:
 * «Los pesos de `FR-055` deciden **cuánto** remix, no **qué** remixar. La
 * elección del item concreto es `DP-005` / `JV-6`, que ordena los candidatos
 * por encaje con la marca en vez de filtrar sólo por nicho». Elegir con un
 * peso aquí sería sustituir un juicio semántico por un dado, que es
 * exactamente lo que `EXT-008` existe para evitar. Por eso el plan devuelve
 * **candidatos**, no un elegido.
 */
import type { Rng } from "@fastgram/ports";
import { DomainError } from "../errors.js";
import type { BlitzContentType } from "../content/content.js";
import { preferenceFeatureKey } from "../preferences/features.js";
import {
  clampPreferenceExploration,
  scoreCandidate,
  type LearnedPreferences,
} from "../preferences/model.js";
import {
  GENDER_FILTER_TO_INFLUENCER,
  type BlitzPreferences,
  type TextStylePreset,
} from "./blitz-preferences.js";

/** Formatos que admiten influencer. `green-screen` **nunca** (`FR-055` regla 5). */
export const INFLUENCER_CAPABLE_TYPES = [
  "slideshow",
  "wall-of-text",
  "video-hook",
] as const;

export interface EligibleInfluencer {
  readonly id: string;
  readonly isActive: boolean;
  readonly isTrained: boolean;
  /**
   * Vocabulario de `Influencer.gender`: `male` / `female` / otro. `null` desde
   * `0020`: con fotos de referencia los rasgos son opcionales.
   */
  readonly gender?: string | null | undefined;
}

export type InfluencerSkipReason =
  /** El formato salió `green-screen`. */
  | "green_screen"
  /** La tirada independiente no salió. Es lo normal, no un fallo. */
  | "roll_missed"
  /** No hay ninguno activo, entrenado y compatible con el filtro. */
  | "no_eligible_influencer";

export type InfluencerDecision =
  | { readonly decision: "none"; readonly reason: InfluencerSkipReason }
  /** `DP-005` / `JV-6` elige **cuál** de estos. Ver la cabecera. */
  | { readonly decision: "use"; readonly candidates: readonly string[] };

export interface SuggestionPlan {
  /** `true` si toca remix. *Qué* se remixa lo decide `DP-005`. */
  readonly isRemix: boolean;
  readonly contentType: BlitzContentType;
  /** `null` si el workspace no tiene ángulos activos. */
  readonly angleId: string | null;
  readonly influencer: InfluencerDecision;
  readonly useOwnMedia: boolean;
  readonly mentionBusiness: boolean;
  /** `null` cuando `textStyleWeights` está vacío (mix desactivado). */
  readonly textStylePresetId: TextStylePreset | null;
}

export interface SuggestionContext {
  readonly activeAngleIds: readonly string[];
  readonly influencers: readonly EligibleInfluencer[];
  /**
   * Los formatos que el Media Bank puede construir hoy (`formatsWithMedia`).
   * Ausente = los cuatro. Un formato fuera de la lista pesa 0 en la tirada (b):
   * `FR-050` lo llama *"tipo válido pero no producible ahora"*, y planificarlo
   * igual dejaría en la cola una pieza que no se puede construir.
   */
  readonly availableFormats?: readonly BlitzContentType[] | undefined;
}

/**
 * Una tirada porcentual.
 *
 * `rng.next()` vive en `[0, 1)`, así que `next() * 100 < p` sale **siempre**
 * con `p = 100` y **nunca** con `p = 0`. Los dos bordes son criterios de
 * aceptación de `FR-055` (regla 2 y criterio 4), y con `<=` en vez de `<` el
 * de 0 se rompería: `0 <= 0` es verdadero y un `influencerChance` de 0
 * produciría influencers.
 */
function roll(rng: Rng, percentage: number): boolean {
  return rng.next() * 100 < percentage;
}

/**
 * Filtra los influencers elegibles — `FR-055` reglas 3, 4 y 5.
 *
 * El filtro de género «excluye el género opuesto **para valores conocidos**;
 * otros valores siguen siendo elegibles». Es decir: un influencer con
 * `gender: "non-binary"` o sin género **no se descarta nunca**. Implementarlo
 * como "descarta todo lo que no coincide" deja fuera a esos personajes de
 * cualquier workspace que use el filtro, sin que nadie pueda explicárselo.
 */
export function eligibleInfluencers(
  influencers: readonly EligibleInfluencer[],
  contentType: BlitzContentType,
  genderFilter: BlitzPreferences["genderFilter"],
): readonly string[] {
  if (!(INFLUENCER_CAPABLE_TYPES as readonly string[]).includes(contentType)) {
    return [];
  }
  const excluded =
    genderFilter === null
      ? null
      : genderFilter === "man"
        ? GENDER_FILTER_TO_INFLUENCER.woman
        : GENDER_FILTER_TO_INFLUENCER.man;

  return influencers
    .filter((i) => i.isActive && i.isTrained)
    .filter((i) => excluded === null || i.gender !== excluded)
    .map((i) => i.id);
}

export function planSuggestion(
  rng: Rng,
  preferences: BlitzPreferences,
  context: SuggestionContext,
): SuggestionPlan {
  // (a) remix vs original
  const isRemix = roll(rng, preferences.remixPercentage);

  // (b) tipo de contenido — sólo entre los que tienen media
  const available = context.availableFormats;
  const mix = [
    { value: "slideshow" as const, weight: preferences.slideshowWeight },
    { value: "wall-of-text" as const, weight: preferences.wallOfTextWeight },
    { value: "green-screen" as const, weight: preferences.greenScreenWeight },
    { value: "video-hook" as const, weight: preferences.videoHookWeight },
  ].map((item) =>
    available === undefined || available.includes(item.value)
      ? item
      : { ...item, weight: 0 },
  );
  if (mix.every((item) => item.weight <= 0)) {
    // No es un bug del workspace sino un Media Bank que no alcanza para
    // ningún formato del mix. Grita en vez de repartir: planificar otro
    // formato que el usuario puso en 0 sería ignorar su mix.
    throw new DomainError(
      "invalid_state",
      "No content type in the mix has media available in the Media Bank.",
      { availableFormats: available ?? [] },
    );
  }
  const contentType = rng.weightedPick<BlitzContentType>(mix);

  // (c) ángulo
  const angleId = pickAngle(rng, preferences, context.activeAngleIds);

  // (d) influencer — tirada INDEPENDIENTE, no una cuota sobre el lote
  const influencer = decideInfluencer(rng, preferences, contentType, context);

  // (e) fuente de media
  const useOwnMedia = roll(rng, preferences.ownMediaPercentage);

  // (f) preset de caption
  const textStylePresetId = pickTextStyle(rng, preferences);

  return {
    isRemix,
    contentType,
    angleId,
    influencer,
    useOwnMedia,
    mentionBusiness: roll(rng, preferences.mentionBusinessPercentage),
    textStylePresetId,
  };
}

function pickAngle(
  rng: Rng,
  preferences: BlitzPreferences,
  activeAngleIds: readonly string[],
): string | null {
  if (activeAngleIds.length === 0) return null;

  const items = activeAngleIds.map((id) => ({
    value: id,
    weight: preferences.angleWeights[id] ?? 0,
  }));
  const total = items.reduce((sum, i) => sum + i.weight, 0);

  // Un mapa que no cubre los activos es un bug de la transacción de reconcile
  // (§9.4). Acá se nota como suma 0, y hay que gritar en vez de repartir a
  // ojo: repartir en silencio esconde el bug de reconcile para siempre.
  if (total <= 0) {
    throw new DomainError(
      "invalid_state",
      "angleWeights doesn't cover any active angle.",
      { activeAngleIds, angleWeights: preferences.angleWeights },
    );
  }
  return rng.weightedPick(items);
}

function decideInfluencer(
  rng: Rng,
  preferences: BlitzPreferences,
  contentType: BlitzContentType,
  context: SuggestionContext,
): InfluencerDecision {
  // `green-screen` es **siempre** contenido regular, así que no hay nada que
  // decidir y la tirada no se hace. La secuencia del Rng sigue siendo
  // determinista —`contentType` sale del mismo flujo unas líneas antes—, pero
  // deja de ser la misma según el formato: es el precio de no gastar una
  // tirada cuyo resultado se iba a tirar, y conviene saberlo si algún día
  // alguien compara dos corridas con formatos distintos.
  if (contentType === "green-screen") {
    return { decision: "none", reason: "green_screen" };
  }

  if (!roll(rng, preferences.influencerChance)) {
    return { decision: "none", reason: "roll_missed" };
  }

  const candidates = eligibleInfluencers(
    context.influencers,
    contentType,
    preferences.genderFilter,
  );

  // `FR-055` regla 3: sin elegible, **se cae a contenido regular**. No es un
  // error: el influencer puede estar entrenándose (15–20 min) y el producto
  // no puede quedarse sin cola mientras tanto.
  if (candidates.length === 0) {
    return { decision: "none", reason: "no_eligible_influencer" };
  }
  return { decision: "use", candidates };
}

function pickTextStyle(rng: Rng, preferences: BlitzPreferences): TextStylePreset | null {
  const entries = Object.entries(preferences.textStyleWeights).filter(([, w]) => w > 0);
  // `{}` desactiva el mix: el motor usa su estilo por defecto.
  if (entries.length === 0) return null;
  return rng.weightedPick(
    entries.map(([preset, weight]) => ({ value: preset as TextStylePreset, weight })),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Sprint 9 (T, `PU-S9-015`): las preferencias aprendidas sobre el mix
// ───────────────────────────────────────────────────────────────────────────

/**
 * Los pesos del mix, en el orden de la tirada (b). Mismo orden que `mix` en
 * {@link planSuggestion}: el de la base (`blitz_preferences`, con el auto-tune
 * ya aplicado por `metrics-sync`).
 */
const MIX_WEIGHT_KEYS = [
  ["slideshow", "slideshowWeight"],
  ["wall-of-text", "wallOfTextWeight"],
  ["green-screen", "greenScreenWeight"],
  ["video-hook", "videoHookWeight"],
] as const satisfies readonly (readonly [BlitzContentType, keyof BlitzPreferences])[];

export interface LearnedMixBias {
  /** Las preferencias con las que planificar esta sugerencia. */
  readonly preferences: BlitzPreferences;
  /**
   * `false` = nada aprendido toca el formato ni el ángulo (o las preferencias
   * están apagadas): **no se tiró el dado**, y el plan es exactamente el de
   * antes con el mismo `Rng`.
   */
  readonly applied: boolean;
  /** `true` = salió la tirada de exploración: el mix tal cual, sin sesgo. */
  readonly explored: boolean;
  /** formato → multiplicador (1 = neutro). Para el log y los tests. */
  readonly formatMultipliers: Readonly<Partial<Record<BlitzContentType, number>>>;
}

/**
 * El formato y el ángulo de una sugerencia nueva, sesgados por lo que el dueño
 * aceptó y descartó (`D-22`). Se llama **antes** de cada `planBlitzSuggestion`.
 *
 * ## Por qué así
 *
 * - **Multiplicativo sobre el mix de siempre**: el peso de cada formato (el de
 *   la estrategia, con el auto-tune) por `scoreCandidate([format=…])`; el de
 *   cada ángulo por `scoreCandidate([angle=…])`. Un formato en 0 sigue en 0
 *   (`AI-012`: el dueño lo apagó, las preferencias no lo reviven), y el orden
 *   de las seis tiradas de `AI-002` no cambia.
 * - **Sin nada aprendido, ni una tirada de más**: si ningún multiplicador se
 *   mueve de 1, devuelve las mismas preferencias sin tocar el `Rng`. Es lo que
 *   hace que una marca sin señales tenga exactamente el plan de antes con la
 *   misma semilla (lo fija `discovery/selection.test.ts`).
 * - **Exploración**: con probabilidad `settings.exploration` (15 % por
 *   defecto, la de la marca o la del dueño) se planifica con el mix sin sesgo.
 *   Una tirada por sugerencia, **antes** de las de `AI-002`.
 *
 * El influencer y la media no se sesgan acá: el influencer lo elige `JV-6` o
 * el decisor, y la media el decisor (`assets/decision/preferences.ts`).
 */
export function biasMixByPreferences(
  rng: Rng,
  preferences: BlitzPreferences,
  prefs: LearnedPreferences | null,
): LearnedMixBias {
  const unchanged: LearnedMixBias = {
    preferences,
    applied: false,
    explored: false,
    formatMultipliers: {},
  };
  if (prefs === null || !prefs.settings.enabled || prefs.features.size === 0) {
    return unchanged;
  }
  const multiplierOf = (family: "format" | "angle", value: string): number => {
    const key = preferenceFeatureKey(family, value);
    return key === null ? 1 : scoreCandidate([key], prefs).multiplier;
  };

  const formatMultipliers: Partial<Record<BlitzContentType, number>> = {};
  let moved = false;
  for (const [format, key] of MIX_WEIGHT_KEYS) {
    const m = (preferences[key] as number) > 0 ? multiplierOf("format", format) : 1;
    formatMultipliers[format] = m;
    if (m !== 1) moved = true;
  }
  const angleMultipliers = new Map<string, number>();
  for (const [id, weight] of Object.entries(preferences.angleWeights)) {
    const m = weight > 0 ? multiplierOf("angle", id) : 1;
    angleMultipliers.set(id, m);
    if (m !== 1) moved = true;
  }
  if (!moved) return unchanged;

  const exploration = clampPreferenceExploration(prefs.settings.exploration);
  if (rng.next() < exploration) {
    return { preferences, applied: true, explored: true, formatMultipliers };
  }

  const biased: { -readonly [K in keyof BlitzPreferences]: BlitzPreferences[K] } = {
    ...preferences,
  };
  for (const [format, key] of MIX_WEIGHT_KEYS) {
    biased[key] = (preferences[key] as number) * (formatMultipliers[format] ?? 1);
  }
  biased.angleWeights = Object.fromEntries(
    Object.entries(preferences.angleWeights).map(([id, w]) => [
      id,
      w * (angleMultipliers.get(id) ?? 1),
    ]),
  );
  return { preferences: biased, applied: true, explored: false, formatMultipliers };
}
