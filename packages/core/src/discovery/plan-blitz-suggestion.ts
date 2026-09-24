/**
 * Una sugerencia **construible** — `AI-002` (a)–(f) más la media concreta.
 *
 * `planSuggestion` hace las seis tiradas de `AI-002` y devuelve candidatos;
 * esto las cierra en algo que `POST /blitz` puede convertir en un
 * `buildPayload` sin volver a decidir nada:
 *
 *  1. **Formatos sin media no compiten** (`formatsWithMedia`): pesan 0 en la
 *     tirada (b). `FR-050`: *"tipo válido pero no producible ahora"*. Los que
 *     quedaron afuera con peso > 0 van a la explicación.
 *  2. **Influencer**: la tirada independiente y el fallback a regular son de
 *     `planSuggestion`. Acá se agrega un fallback más: si ningún candidato
 *     tiene media en sus sets (`FR-083`) para el formato, la pieza es
 *     regular. Una pieza «con influencer» sin el influencer en la media sería
 *     un chip que miente.
 *
 *     **Varios candidatos con media** (`PU-LATER-004`): se elige uno **al
 *     azar**, con el `Rng` y la explicación lo dice. El PRD pone esa elección
 *     en `DP-005`/`JV-6` (ordenar por encaje con la marca) y hasta ahora la
 *     pieza salía sin personaje «hasta que exista». Ese juicio no está
 *     construido, y sin elegir, dos personajes entrenados apagaban
 *     `influencerChance` del todo. Cuando `JV-6` exista, reemplaza a esta
 *     tirada. Con un solo candidato no se tira nada: los seeds de antes
 *     siguen dando lo mismo.
 *  3. **La media** (`selectMedia`), con el `Rng` **después** de las seis
 *     tiradas: agregarla no cambia ninguna de las anteriores para un seed.
 */
import type { Rng } from "@fastgram/ports";
import type { BlitzContentType } from "../content/content.js";
import {
  formatsWithMedia,
  influencerCoversFormat,
  rankMedia,
  selectMedia,
  withRoleMedia,
  type JudgeableRole,
  type MediaBank,
  type MediaRef,
  type MediaSelection,
} from "./blitz-media.js";
import { topMatches } from "./relevance.js";
import type { BlitzPreferences } from "./blitz-preferences.js";
import {
  planSuggestion,
  type EligibleInfluencer,
  type SuggestionPlan,
} from "./plan-suggestion.js";
import { DomainError } from "../errors.js";
import {
  explainSuggestion,
  type PromptFailureReason,
  type PromptNarrative,
  type SuggestionNarrative,
} from "./refill-job.js";

export interface BlitzPlanningContext {
  readonly activeAngleIds: readonly string[];
  readonly influencers: readonly EligibleInfluencer[];
  readonly bank: MediaBank;
  /** Para la explicación: ids → títulos y nombres. */
  readonly angleTitles: ReadonlyMap<string, string>;
  readonly influencerNames: ReadonlyMap<string, string>;
}

export interface PlannedBlitzSuggestion {
  readonly plan: SuggestionPlan;
  /** El influencer que **sí** se usa: único candidato y con media. */
  readonly influencerId: string | null;
  readonly media: MediaSelection;
  /** La parte determinista de `aiExplanation` (`explainSuggestion`). */
  readonly derivedExplanation: string;
  /**
   * Sprint 7 (`JV-6`): el tema con el que se eligió la media — el prompt del
   * usuario o, en el refill, el título del ángulo. `null` = sin tema (azar).
   */
  readonly topic: string | null;
  /**
   * Sprint 7 (`JV-6`): los personajes con media entre los que se sorteó el
   * influencer. Vacío salvo con dos o más: es lo que el juicio puede
   * re-elegir con {@link rebindInfluencer}.
   */
  readonly influencerCandidates: readonly string[];
  /** Con qué se armó la explicación, para rearmarla si `JV-6` cambia algo. */
  readonly narrative: SuggestionNarrative;
}

const MIX: readonly [BlitzContentType, keyof BlitzPreferences][] = [
  ["slideshow", "slideshowWeight"],
  ["wall-of-text", "wallOfTextWeight"],
  ["green-screen", "greenScreenWeight"],
  ["video-hook", "videoHookWeight"],
];

/**
 * Lanza `DomainError("invalid_state")` si ningún formato del mix tiene media
 * (viene de `planSuggestion`), o si los pesos de ángulo no cubren a ninguno
 * activo. Las dos son estado del workspace y no mejoran reintentando.
 */
export function planBlitzSuggestion(
  rng: Rng,
  preferences: BlitzPreferences,
  context: BlitzPlanningContext,
  /** `PU-BLITZ-003`: sólo lo pasa {@link planPromptSuggestion}. */
  prompt?: PromptNarrative,
): PlannedBlitzSuggestion {
  const available = formatsWithMedia(context.bank);
  const skippedFormats = MIX.filter(
    ([format, key]) => (preferences[key] as number) > 0 && !available.includes(format),
  ).map(([format]) => format);

  const plan = planSuggestion(rng, preferences, {
    activeAngleIds: context.activeAngleIds,
    influencers: context.influencers,
    availableFormats: available,
  });

  let influencerId: string | null = null;
  let influencerWithoutMedia: string | undefined;
  let pickedAmong = 0;
  let candidatesWithoutMedia = 0;
  if (plan.influencer.decision === "use") {
    const candidates = plan.influencer.candidates;
    const withMedia = candidates.filter((id) =>
      influencerCoversFormat(context.bank, id, plan.contentType),
    );
    if (withMedia.length === 1) {
      influencerId = withMedia[0] as string;
    } else if (withMedia.length > 1) {
      // Ver la cabecera (2): al azar hasta que exista `JV-6`.
      influencerId = withMedia[rng.nextInt(0, withMedia.length)] as string;
      pickedAmong = withMedia.length;
    } else if (candidates.length === 1) {
      const only = candidates[0] as string;
      influencerWithoutMedia = context.influencerNames.get(only) ?? "Your influencer";
    } else {
      candidatesWithoutMedia = candidates.length;
    }
  }

  const angleTitle =
    plan.angleId === null ? undefined : context.angleTitles.get(plan.angleId);
  // Sprint 7 (`JV-6`): el tema elige la media. El del usuario manda; sin
  // prompt, el ángulo que salió.
  const topic = prompt?.topic ?? angleTitle ?? null;
  const media = selectMedia(rng, context.bank, plan.contentType, influencerId, topic);
  if (media === null) {
    // `formatsWithMedia` y `influencerCoversFormat` ya lo garantizaron. Llegar
    // acá es que las dos funciones divergieron.
    throw new Error(`selectMedia no encontró media para ${plan.contentType}`);
  }

  const narrative: SuggestionNarrative = {
    angleTitle,
    influencerName:
      influencerId === null ? undefined : context.influencerNames.get(influencerId),
    candidatesWithoutMedia,
    influencerWithoutMedia,
    pickedAmong,
    skippedFormats,
    prompt,
    mediaLines: topicMediaLines(context.bank, media, topic),
  };
  return {
    plan,
    influencerId,
    media,
    derivedExplanation: explainSuggestion(plan, narrative),
    topic,
    influencerCandidates:
      pickedAmong > 1
        ? plan.influencer.decision === "use"
          ? plan.influencer.candidates.filter((id) =>
              influencerCoversFormat(context.bank, id, plan.contentType),
            )
          : []
        : [],
    narrative,
  };
}

/**
 * La línea de la explicación cuando el tema eligió el meme de un
 * green-screen: sólo si el clip elegido está entre los que matchean.
 */
function topicMediaLines(
  bank: MediaBank,
  media: MediaSelection,
  topic: string | null,
): readonly string[] {
  if (media.format !== "green-screen" || topic === null) return [];
  const clip = bank.media.find((m) => m.id === media.video.mediaId);
  if (clip === undefined) return [];
  const pool = bank.media.filter(
    (m) => m.mediaType === "video" && m.categories.includes("green-screen-video"),
  );
  const matches = topMatches(rankMedia(topic, pool));
  return matches.some((m) => m.id === clip.id)
    ? ["Meme: picked from your Media Bank because its labels match the topic."]
    : [];
}

/**
 * `JV-6`: el juicio eligió **otro** personaje entre
 * {@link PlannedBlitzSuggestion.influencerCandidates}. La media se vuelve a
 * elegir de **sus** sets (con el mismo tema) y la explicación lo dice.
 * Consume el `Rng` otra vez: sólo pasa con juicio, que ya no es reproducible
 * por seed.
 */
export function rebindInfluencer(
  rng: Rng,
  context: BlitzPlanningContext,
  planned: PlannedBlitzSuggestion,
  influencerId: string,
): PlannedBlitzSuggestion {
  if (!planned.influencerCandidates.includes(influencerId)) return planned;
  const media = selectMedia(
    rng,
    context.bank,
    planned.plan.contentType,
    influencerId,
    planned.topic,
  );
  if (media === null) return planned;
  const narrative: SuggestionNarrative = {
    ...planned.narrative,
    influencerName: context.influencerNames.get(influencerId),
    influencerJudged: true,
  };
  return {
    ...planned,
    influencerId,
    media,
    narrative,
    derivedExplanation: explainSuggestion(planned.plan, narrative),
  };
}

/**
 * `JV-6` o la búsqueda automática cambiaron el asset de un rol (el meme o el
 * fondo). `line` reemplaza a las líneas de media de la explicación.
 */
export function withJudgedMedia(
  planned: PlannedBlitzSuggestion,
  role: JudgeableRole,
  media: MediaRef,
  line: string,
): PlannedBlitzSuggestion {
  const narrative: SuggestionNarrative = {
    ...planned.narrative,
    mediaLines: [
      ...(planned.narrative.mediaLines ?? []).filter(
        (l) => !l.startsWith(roleLabel(role)),
      ),
      line,
    ],
  };
  return {
    ...planned,
    media: withRoleMedia(planned.media, role, media),
    narrative,
    derivedExplanation: explainSuggestion(planned.plan, narrative),
  };
}

/**
 * `JV-6` eligió qué referencia remixar (la tirada de `remixPercentage` salió).
 * Sólo cambia la explicación: la referencia viaja a la copy aparte.
 */
export function withRemixReference(
  planned: PlannedBlitzSuggestion,
  referenceTitle: string,
): PlannedBlitzSuggestion {
  if (!planned.plan.isRemix) return planned;
  const narrative: SuggestionNarrative = {
    ...planned.narrative,
    remixReferenceTitle: referenceTitle.trim() === "" ? "untitled" : referenceTitle,
  };
  return {
    ...planned,
    narrative,
    derivedExplanation: explainSuggestion(planned.plan, narrative),
  };
}

/** Cómo empieza la línea de cada rol en la explicación. */
export function roleLabel(role: JudgeableRole): string {
  return role === "video" ? "Meme:" : "Background:";
}

// ───────────────────────────────────────────────────────────────────────────
// Crear desde prompt — `EXT-009`, `PU-BLITZ-003`
// ───────────────────────────────────────────────────────────────────────────

/**
 * Un pedido de prompt que no se puede planificar, con el **código estable**
 * que la API devuelve y la web traduce (`PROMPT_FAILURE_REASONS`).
 *
 * Es un error tipado aparte de `DomainError` porque quien lo atrapa —el
 * handler del worker— tiene que distinguir «no hay media para el formato que
 * pediste» (el usuario lo arregla en la Library) de «el workspace está roto»
 * (`invalid_state`), y un `DomainError("invalid_state")` genérico no lo dice.
 */
export class BlitzPromptError extends Error {
  override readonly name = "BlitzPromptError";
  constructor(
    readonly reason: PromptFailureReason,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export interface PromptPlanRequest {
  /** El tema del usuario. Va a la explicación; la copy lo recibe aparte. */
  readonly topic: string;
  /** El formato forzado, o `null` = lo decide el content mix. */
  readonly contentType: BlitzContentType | null;
}

/**
 * Una sugerencia de «crear desde prompt», con **la misma selección** que el
 * refill (`planBlitzSuggestion`): mismas tiradas, misma media del Media Bank,
 * mismo fallback de influencer. Cambian tres cosas:
 *
 *  1. **El formato forzado** se planifica como un mix con ese formato al 100 %.
 *     Si el Media Bank no tiene media para él, `BlitzPromptError`
 *     `no_media_for_format` — **antes** de gastar una llamada al LLM.
 *  2. **Sin ángulo**: el tema del usuario ocupa su lugar. Tirar un ángulo
 *     encima le daría al modelo dos temas que compiten. Se logra con la lista
 *     de ángulos activos vacía, así que `pickAngle` no gasta tirada.
 *  3. **La explicación** dice que salió del prompt.
 *
 * Sin formato forzado y sin media para ningún formato del mix,
 * `BlitzPromptError` `no_media`: mismo criterio que el refill, que no
 * planifica un formato que el usuario puso en 0.
 */
export function planPromptSuggestion(
  rng: Rng,
  preferences: BlitzPreferences,
  context: BlitzPlanningContext,
  request: PromptPlanRequest,
): PlannedBlitzSuggestion {
  const available = formatsWithMedia(context.bank);
  const forced = request.contentType;

  if (forced !== null && !available.includes(forced)) {
    throw new BlitzPromptError(
      "no_media_for_format",
      `Your Media Bank has no media categorized for ${forced}.`,
      { contentType: forced, availableFormats: available },
    );
  }
  const effective: BlitzPreferences =
    forced === null
      ? preferences
      : {
          ...preferences,
          slideshowWeight: forced === "slideshow" ? 100 : 0,
          wallOfTextWeight: forced === "wall-of-text" ? 100 : 0,
          greenScreenWeight: forced === "green-screen" ? 100 : 0,
          videoHookWeight: forced === "video-hook" ? 100 : 0,
        };
  if (
    forced === null &&
    !MIX.some(
      ([format, key]) => (preferences[key] as number) > 0 && available.includes(format),
    )
  ) {
    throw new BlitzPromptError(
      "no_media",
      "No content type in your mix has media in your Media Bank.",
      { availableFormats: available },
    );
  }

  try {
    return planBlitzSuggestion(
      rng,
      effective,
      { ...context, activeAngleIds: [] },
      { topic: request.topic, forcedFormat: forced !== null },
    );
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === "invalid_state") {
      throw new BlitzPromptError("invalid_state", error.message, error.details);
    }
    throw error;
  }
}

// `PU-LATER-004`: el módulo de influencers sale del paquete por acá hasta que
// `src/index.ts` (que no es de este cambio) lo exporte con su propia línea.

// Sprint 7 (memes desde un prompt): los módulos nuevos salen por acá por la
// misma razón — `src/index.ts` es compartido.
export * from "./relevance.js";
export * from "./meme-search.js";
export * from "./copy-language.js";
