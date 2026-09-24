/**
 * `JV-6` en el worker — elegir el mejor candidato (meme, fondo, influencer,
 * referencia de remix) con un juicio acotado (`DP-005`). Sprint 7.
 *
 * El ranking determinístico y la forma de la pregunta son de `core`
 * (`discovery/relevance.ts`); acá sólo se habla con el puerto `Judgment` y se
 * aplica lo que decide al plan.
 *
 * ## Nunca bloquea
 *
 * Sin modelo, con el proveedor caído, pasado el timeout o con poca confianza,
 * `judgeBest` devuelve `null` y el plan se queda con lo que eligió el
 * ranking. Un juicio que no llega no puede dejar al usuario sin pieza (es el
 * mismo criterio de §25.3 para los juicios que no son del piloto).
 *
 * ## De dónde sale el modelo
 *
 * La tarea `judgment` del registro (hereda la de `text`), resuelta en cada
 * job y envuelta en `RecordingJudgment`: cada juicio deja su fila en
 * `judgment_records` (`DATA-033`) con el hash del estado, no el estado.
 */
import { LlmJudgmentAdapter, RecordingJudgment } from "@fastgram/adapters";
import {
  JV6_DECISION_POINT,
  JV6_MAX_CANDIDATES,
  describeRelevanceText,
  jv6Question,
  jv6State,
  mediaRefOf,
  mediaRelevanceText,
  rebindInfluencer,
  relevantCandidates,
  resolveJudgedChoice,
  withJudgedMedia,
  type BlitzPlanningContext,
  type CopyBrandProfile,
  type Jv6Candidate,
  type Jv6Subject,
  type PlannedBlitzSuggestion,
} from "@fastgram/core";
import { createJudgmentSink, type Database } from "@fastgram/db";
import type { ChoiceAnswer, Judgment, Rng } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { LlmSource } from "../llm/registry-llm.js";

/** El juicio para un sujeto, o `null` si no hay modelo. */
export type Jv6JudgmentProvider = (subject: {
  readonly companyId: string;
  readonly subjectType: string;
  readonly subjectId?: string;
}) => Promise<Judgment | null>;

/** Plazo duro por juicio. Es un extra: el relleno y el prompt no lo esperan más. */
export const JV6_TIMEOUT_MS = 15_000;

export function createJv6Judgment(deps: {
  readonly llmSource: LlmSource;
  readonly db: Database;
  readonly appRole: string | undefined;
  readonly logger: BuildLogger;
}): Jv6JudgmentProvider {
  const sink = createJudgmentSink(
    deps.db,
    deps.appRole === undefined ? {} : { role: deps.appRole },
  );
  return async (subject) => {
    const found = await deps.llmSource.current("judgment");
    if (found === null) return null;
    return new RecordingJudgment(
      new LlmJudgmentAdapter(found.llm, { model: found.config.model }),
      sink,
      subject,
      {
        onError: (error) => {
          deps.logger.warn(
            {
              ...subject,
              reason: error instanceof Error ? error.message : String(error),
            },
            "no se pudo guardar el juicio en judgment_records (la decisión sigue)",
          );
        },
      },
    );
  };
}

class HardTimeout extends Error {
  override readonly name = "HardTimeout";
}

/**
 * El id del mejor candidato según el juicio, o `null` = manda el ranking.
 * Con menos de dos candidatos no pregunta nada.
 */
export async function judgeBest(
  judgment: Judgment | null,
  subject: Jv6Subject,
  input: {
    readonly topic: string | null;
    readonly brandName: string;
    readonly profile: CopyBrandProfile;
    readonly candidates: readonly Jv6Candidate[];
  },
  logger: BuildLogger,
  timeoutMs: number = JV6_TIMEOUT_MS,
): Promise<string | null> {
  if (judgment === null || input.candidates.length < 2) return null;
  const candidates = input.candidates.slice(0, JV6_MAX_CANDIDATES);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HardTimeout());
    }, timeoutMs);
  });
  const call = judgment.choice({
    decisionPoint: JV6_DECISION_POINT,
    state: jv6State({
      topic: input.topic,
      brand: {
        name: input.brandName,
        coreIdentity: input.profile.coreIdentity,
        targetAudience: input.profile.targetAudience,
        toneOfVoice: input.profile.toneOfVoice,
      },
      candidates,
    }),
    question: jv6Question(subject, candidates.length),
    timeoutMs,
  });
  // Puede terminar después del plazo: su rechazo no queda sin manejar.
  call.catch(() => undefined);
  try {
    const { answer } = await Promise.race([call, deadline]);
    return resolveJudgedChoice(answer as ChoiceAnswer, candidates);
  } catch (error: unknown) {
    logger.warn(
      {
        subject,
        reason:
          error instanceof HardTimeout
            ? "timeout"
            : error instanceof Error
              ? error.name
              : "unknown",
      },
      "JV-6 sin respuesta: manda el ranking",
    );
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Cómo se describe un personaje candidato en la pregunta de `JV-6`.
 *
 * Sprint 8 (K, `P4-JV-004`): si el influencer representa un **modelo de la
 * biblioteca** del dueño, su perfil (edad, estilo, notas) va en la
 * descripción. Con varios modelos asignados a una marca, eso es lo que deja
 * al juicio elegir el que mejor encaja con la marca y el ángulo (el tema de
 * la pregunta es el título del ángulo). Sin perfil, lo de antes: nombre y
 * género.
 */
export function describeInfluencerCandidate(
  name: string,
  gender: string | null | undefined,
  profile: string | undefined,
): string {
  const parts = [`name: ${name}`];
  if (gender !== undefined && gender !== null) parts.push(`gender: ${gender}`);
  if (profile !== undefined && profile.trim() !== "") parts.push(profile.trim());
  return parts.join("; ");
}

/**
 * El perfil de un modelo de la biblioteca para {@link describeInfluencerCandidate}.
 * Recortado: la pregunta tiene que seguir siendo acotada (`DP-005`).
 */
export function libraryModelProfile(model: {
  readonly age: number | null;
  readonly style: string | null;
  readonly notes: string | null;
}): string {
  const parts: string[] = [];
  if (model.age !== null) parts.push(`age: ${String(model.age)}`);
  if (model.style !== null && model.style.trim() !== "")
    parts.push(`style: ${model.style.trim().slice(0, 120)}`);
  if (model.notes !== null && model.notes.trim() !== "")
    parts.push(`notes: ${model.notes.trim().replace(/\s+/g, " ").slice(0, 200)}`);
  return parts.join("; ");
}

/**
 * Aplica `JV-6` a una sugerencia planificada: el influencer entre varios con
 * media, y en green-screen el meme y el fondo entre los que matchean el tema.
 * Devuelve el plan tal cual si no hay nada que elegir o el juicio no decide.
 */
export async function applyJv6(
  planned: PlannedBlitzSuggestion,
  args: {
    readonly judgment: Judgment | null;
    readonly rng: Rng;
    readonly context: BlitzPlanningContext;
    readonly brandName: string;
    readonly profile: CopyBrandProfile;
    readonly logger: BuildLogger;
    /**
     * Sprint 8 (K): influencer → perfil de su modelo de la biblioteca
     * (`libraryModelProfile`). Ausente = sólo nombre y género.
     */
    readonly influencerProfiles?: ReadonlyMap<string, string> | undefined;
  },
): Promise<PlannedBlitzSuggestion> {
  if (args.judgment === null) return planned;
  let out = planned;
  const common = {
    topic: planned.topic,
    brandName: args.brandName,
    profile: args.profile,
  };

  if (out.influencerCandidates.length >= 2) {
    const candidates: Jv6Candidate[] = out.influencerCandidates.map((id) => {
      const person = args.context.influencers.find((i) => i.id === id);
      const name = args.context.influencerNames.get(id) ?? "Unnamed character";
      return {
        id,
        description: describeInfluencerCandidate(
          name,
          person?.gender,
          args.influencerProfiles?.get(id),
        ),
      };
    });
    const chosen = await judgeBest(
      args.judgment,
      "influencer",
      { ...common, candidates },
      args.logger,
    );
    if (chosen !== null) out = rebindInfluencer(args.rng, args.context, out, chosen);
  }

  if (out.media.format === "green-screen") {
    for (const role of ["video", "image"] as const) {
      const pool = relevantCandidates(
        args.context.bank,
        "green-screen",
        out.influencerId,
        role,
        out.topic,
        JV6_MAX_CANDIDATES,
      );
      if (pool.length < 2) continue;
      const chosen = await judgeBest(
        args.judgment,
        role === "video" ? "meme" : "background",
        {
          ...common,
          candidates: pool.map((m) => ({
            id: m.id,
            description: describeRelevanceText(mediaRelevanceText(m)),
          })),
        },
        args.logger,
      );
      const media = pool.find((m) => m.id === chosen);
      if (media === undefined) continue;
      out = withJudgedMedia(
        out,
        role,
        mediaRefOf(media),
        role === "video"
          ? `Meme: picked by AI as the best fit for the topic among ${String(pool.length)} matching clips.`
          : `Background: picked by AI as the best fit for the topic among ${String(pool.length)} matching images.`,
      );
    }
  }
  return out;
}
