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
  /** Vocabulario de `Influencer.gender`: `male` / `female` / otro. */
  readonly gender?: string | undefined;
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

  // (b) tipo de contenido
  const contentType = rng.weightedPick<BlitzContentType>([
    { value: "slideshow", weight: preferences.slideshowWeight },
    { value: "wall-of-text", weight: preferences.wallOfTextWeight },
    { value: "green-screen", weight: preferences.greenScreenWeight },
    { value: "video-hook", weight: preferences.videoHookWeight },
  ]);

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
