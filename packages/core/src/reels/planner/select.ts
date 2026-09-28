/**
 * Qué reels arma la semana — ángulo, plantilla, animaciones y subtítulos
 * (sprint 9, U, `PU-S9-014`).
 *
 * La plantilla, la animación del gancho y el estilo de subtítulos se eligen
 * con las preferencias aprendidas del dueño (Q, `D-22`): peso base uniforme
 * entre lo **posible** con los assets que hay, multiplicado por
 * `scoreCandidate`, con la exploración de la marca (`pickWithExploration`).
 * Con preferencias vacías o apagadas es un sorteo uniforme con el `Rng`, así
 * que un `Rng` fijo da siempre el mismo plan.
 *
 * El ángulo sale de los pesos de Blitz (`angleWeights`) como en el refill,
 * sin repetir el anterior si hay otro.
 */
import type { Rng } from "@fastgram/ports";
import {
  extractPreferenceFeatures,
  type PreferenceFeatureKey,
} from "../../preferences/features.js";
import { pickWithExploration, type LearnedPreferences } from "../../preferences/model.js";
import {
  REEL_TEMPLATES,
  type ReelCaptionStyle,
  type ReelMotion,
  type ReelTemplate,
} from "../plan.js";
import type { ReelTextAnimation } from "../types.js";
import { reelDaysForWeek } from "./week.js";

export interface ReelPlanningAngle {
  readonly id: string;
  readonly title: string;
  /** Peso de Blitz (`angleWeights`); ≤ 0 = no se elige. */
  readonly weight: number;
}

/** Lo que hay para armar reels: define qué plantillas son posibles. */
export interface ReelAssetAvailability {
  /** Clips de croma o con alfa (memes) en la marca o la biblioteca. */
  readonly clips: number;
  /** Fondos (imagen o video). */
  readonly backgrounds: number;
}

/** Las plantillas posibles: sin clip no hay reacción; sin dos fondos no hay antes/después. */
export function feasibleReelTemplates(a: ReelAssetAvailability): ReelTemplate[] {
  return REEL_TEMPLATES.filter((t) =>
    t === "hook-reaction-punchline"
      ? a.clips > 0
      : t === "before-after"
        ? a.backgrounds >= 2
        : true,
  );
}

/** Las animaciones de gancho que se miraron en frames para cada plantilla. */
export const REEL_HOOK_ANIMATIONS: Readonly<Record<ReelTemplate, readonly ReelTextAnimation[]>> =
  {
    "hook-reaction-punchline": ["kinetic-bounce", "pop", "zoom-blur", "wipe-reveal"],
    "list-beats": ["zoom-blur", "kinetic-bounce", "fade-up", "word-by-word"],
    "before-after": ["fade-up", "typewriter", "pop", "slide-left"],
  };

export const REEL_CAPTION_CHOICES: readonly ReelCaptionStyle[] = [
  "bold-pop",
  "clean",
  "karaoke",
];

export interface PlannedReelSlot {
  readonly ord: number;
  /** Día local de la marca (`YYYY-MM-DD`). */
  readonly day: string;
  readonly angle: ReelPlanningAngle | null;
  readonly template: ReelTemplate;
  readonly motion: ReelMotion;
  /** `true` = alguna elección de este reel ignoró las preferencias (exploración). */
  readonly explored: boolean;
}

export interface PlanReelWeekInput {
  readonly quota: number;
  readonly weekStart: string;
  readonly today: string;
  readonly angles: readonly ReelPlanningAngle[];
  readonly availability: ReelAssetAvailability;
  readonly prefs: LearnedPreferences;
  readonly rng: Rng;
  /** Por defecto, la de las preferencias de la marca. */
  readonly exploration?: number | undefined;
  /** `ord` desde el que numerar (un re-plan conserva los ítems ya sugeridos). */
  readonly startOrd?: number | undefined;
  /** Los días ya ocupados por ítems que se conservan: no se vuelven a llenar. */
  readonly keptDays?: readonly string[] | undefined;
}

const reelFeatures = (reel: {
  template?: string;
  animations?: readonly string[];
  captionStyle?: string;
}): PreferenceFeatureKey[] =>
  extractPreferenceFeatures({ format: "reel", reel: { ...reel } });

function pickAngle(
  angles: readonly ReelPlanningAngle[],
  previous: string | null,
  rng: Rng,
): ReelPlanningAngle | null {
  const live = angles.filter((a) => a.weight > 0);
  if (live.length === 0) return null;
  const pool = live.length > 1 ? live.filter((a) => a.id !== previous) : live;
  return rng.weightedPick(pool.map((a) => ({ value: a, weight: a.weight })));
}

/**
 * Los reels de la semana, sin copy ni assets (eso lo completan el modelo
 * `text` y el decisor). Vacío si el cupo es 0.
 */
export function planReelWeek(input: PlanReelWeekInput): PlannedReelSlot[] {
  const days = [...reelDaysForWeek(input.quota, input.weekStart, input.today)];
  // Un re-plan: los días de los ítems conservados ya están cubiertos.
  for (const kept of input.keptDays ?? []) {
    const i = days.indexOf(kept);
    if (i >= 0) days.splice(i, 1);
  }
  const templates = feasibleReelTemplates(input.availability);
  const out: PlannedReelSlot[] = [];
  let previousAngle: string | null = null;
  const exploration = input.exploration;
  days.forEach((day, i) => {
    const angle = pickAngle(input.angles, previousAngle, input.rng);
    previousAngle = angle?.id ?? previousAngle;
    const tpl = pickWithExploration({
      candidates: templates.length > 0 ? templates : (["list-beats"] as ReelTemplate[]),
      featuresOf: (t) => reelFeatures({ template: t }),
      prefs: input.prefs,
      rng: input.rng,
      exploration,
    });
    const hook = pickWithExploration({
      candidates: REEL_HOOK_ANIMATIONS[tpl.picked],
      featuresOf: (a) => reelFeatures({ animations: [a] }),
      prefs: input.prefs,
      rng: input.rng,
      exploration,
    });
    const caps = pickWithExploration({
      candidates: REEL_CAPTION_CHOICES,
      featuresOf: (c) => reelFeatures({ captionStyle: c }),
      prefs: input.prefs,
      rng: input.rng,
      exploration,
    });
    out.push({
      ord: (input.startOrd ?? 0) + i,
      day,
      angle,
      template: tpl.picked,
      motion: { hook: hook.picked, captions: caps.picked },
      explored: tpl.explored || hook.explored || caps.explored,
    });
  });
  return out;
}

/** Los rasgos de preferencia de un reel ya armado (para las señales al aceptar/descartar). */
export function reelPreferenceFeatures(input: {
  readonly template: ReelTemplate;
  readonly animations: readonly string[];
  readonly captionStyle: ReelCaptionStyle | null;
  readonly clip: "chroma" | "alpha" | "opaque" | "none";
  readonly durationSec: number;
  readonly angleId?: string | null;
}): PreferenceFeatureKey[] {
  return extractPreferenceFeatures({
    format: "reel",
    angleId: input.angleId ?? null,
    durationSec: input.durationSec,
    reel: {
      template: input.template,
      animations: input.animations,
      captionStyle: input.captionStyle ?? "none",
      clip: input.clip,
    },
  });
}
