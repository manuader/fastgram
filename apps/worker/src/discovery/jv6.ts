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
 * `judgment_records` (`DATA-033`) con el hash del estado, no el estado. Desde
 * el sprint 9 lo arma `judgment/judgment-source.ts`.
 *
 * ## Sprint 9 (O): el decisor de assets
 *
 * Si `judgment.assets` resuelve a un SystemOne, el meme, el fondo y el
 * personaje los elige el decisor por candidato (`core/assets/decision`) sobre
 * el pool **entero** del rol, no el `choice` entre los 5 que matchean por
 * palabras. Con un LLM, JV-6 igual que antes.
 */
import {
  JV6_DECISION_POINT,
  JV6_MAX_CANDIDATES,
  describeRelevanceText,
  jv6Question,
  jv6State,
  mediaRefOf,
  mediaRelevanceText,
  rankByRelevance,
  rebindInfluencer,
  relevantCandidates,
  resolveJudgedChoice,
  rolePool,
  withJudgedMedia,
  type AssetCandidate,
  type BlitzPlanningContext,
  type CopyBrandProfile,
  type DecisionBrand,
  type Jv6Candidate,
  type Jv6Subject,
  type PlannedBlitzSuggestion,
  type PlanningMedia,
} from "@fastgram/core";
import type { Database } from "@fastgram/db";
import type { ChoiceAnswer, Judgment, Rng } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { createAssetJudge, type AssetJudge } from "../judgment/asset-decider.js";
import type { LibrarySource } from "../judgment/library-source.js";
import { judgmentSourceFor } from "../judgment/judgment-source.js";
import type { LlmSource } from "../llm/registry-llm.js";

type Jv6SubjectRef = {
  readonly companyId: string;
  readonly subjectType: string;
  readonly subjectId?: string;
};

/**
 * El juicio para un sujeto, o `null` si no hay modelo.
 *
 * Sprint 9 (O): `assets` es el decisor por candidato (`judgment.assets`), que
 * sólo existe cuando esa tarea resuelve a un motor SystemOne (Laya, Jev). Con
 * un LLM queda `JV-6` de siempre: un `choice` con el LLM es mucho más barato
 * que N juicios con un modelo local de 7B (ver el reporte de O). Opcional para
 * que un doble de test siga siendo una función pelada.
 */
export interface Jv6JudgmentProvider {
  (subject: Jv6SubjectRef): Promise<Judgment | null>;
  readonly assets?: (subject: Jv6SubjectRef) => Promise<AssetJudge | null>;
}

/** Plazo duro por juicio. Es un extra: el relleno y el prompt no lo esperan más. */
export const JV6_TIMEOUT_MS = 15_000;

export function createJv6Judgment(deps: {
  readonly llmSource: LlmSource;
  readonly db: Database;
  readonly appRole: string | undefined;
  readonly logger: BuildLogger;
}): Jv6JudgmentProvider {
  const source = judgmentSourceFor(deps);
  // `llmOnly`: el `choice` de JV-6 nombra opciones opacas (`option_1…`) que
  // remiten a campos del estado; eso lo contesta un LLM, no un System One.
  const provider = async (subject: Jv6SubjectRef) =>
    (await source.resolve("judgment", subject, { llmOnly: true }))?.judgment ?? null;
  return Object.assign(provider, {
    assets: async (subject: Jv6SubjectRef): Promise<AssetJudge | null> => {
      const handle = await source.resolve("judgment.assets", subject);
      if (handle === null || handle.engine !== "systemone") return null;
      return createAssetJudge({
        judgment: handle.judgment,
        subject,
        db: deps.db,
        appRole: deps.appRole,
        logger: deps.logger,
      });
    },
  });
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
 *
 * Sprint 9 (O): con `assets` (decisor por candidato, `judgment.assets` en un
 * SystemOne) el personaje, el meme y el fondo los elige el decisor; sin él,
 * JV-6 como antes.
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
    /** Sprint 9 (O): el decisor de assets, si `judgment.assets` es SystemOne. */
    readonly assets?: AssetJudge | null | undefined;
    /**
     * Sprint 9 (O): lo que ya eligió este job (para no repetir el mismo meme en
     * las cinco piezas de un relleno). Se **agrega** lo que se elige acá.
     */
    readonly recentIds?: Set<string> | undefined;
    /**
     * Sprint 9 (T): la biblioteca global como candidatos del meme y el fondo
     * del green-screen. Ausente = sólo el Media Bank, como antes.
     */
    readonly library?: LibrarySource | null | undefined;
    /**
     * Sprint 9 (T): id de media de la marca → su fuente en el vocabulario de
     * preferencias (`prefMediaSourceOf`), para el gusto del dueño.
     */
    readonly mediaSources?: ReadonlyMap<string, string> | undefined;
  },
): Promise<PlannedBlitzSuggestion> {
  if (args.assets !== null && args.assets !== undefined) {
    return applyAssetDecisions(planned, { ...args, assets: args.assets });
  }
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
      const library =
        args.library === null || args.library === undefined
          ? []
          : await args.library.candidates({
              format: "green-screen",
              role: role === "video" ? "meme" : "background",
              idea: out.topic,
            });
      const pool =
        library.length === 0
          ? relevantCandidates(
              args.context.bank,
              "green-screen",
              out.influencerId,
              role,
              out.topic,
              JV6_MAX_CANDIDATES,
            ).map((m) => ({ id: m.id, text: mediaRelevanceText(m), media: m }))
          : jv6PoolWithLibrary(args, out, role, library);
      if (pool.length < 2) continue;
      const chosen = await judgeBest(
        args.judgment,
        role === "video" ? "meme" : "background",
        {
          ...common,
          candidates: pool.map((c) => ({
            id: c.id,
            description: describeRelevanceText(c.text),
          })),
        },
        args.logger,
      );
      const picked = pool.find((c) => c.id === chosen);
      if (picked === undefined) continue;
      const media =
        picked.media ?? (await args.library?.materialize(picked.id)) ?? undefined;
      if (media === undefined) continue;
      const fromLibrary = picked.media === undefined ? " (from the global library)" : "";
      out = withJudgedMedia(
        out,
        role,
        mediaRefOf(media),
        role === "video"
          ? `Meme: picked by AI as the best fit for the topic among ${String(pool.length)} matching clips${fromLibrary}.`
          : `Background: picked by AI as the best fit for the topic among ${String(pool.length)} matching images${fromLibrary}.`,
      );
    }
  }
  return out;
}

/** Un candidato de `JV-6`: de la marca (`media`) o de la biblioteca (sin `media`). */
interface Jv6PoolEntry {
  readonly id: string;
  readonly text: ReturnType<typeof mediaRelevanceText>;
  readonly media?: PlanningMedia;
}

/**
 * Sprint 9 (T): el pool de `JV-6` con la biblioteca global. El mismo criterio
 * que `relevantCandidates` —sólo lo que comparte algo con el tema, del más al
 * menos relevante, hasta `JV6_MAX_CANDIDATES`— sobre marca y biblioteca
 * juntas. Sin candidatos de la biblioteca no se llama: el pool es el de antes.
 */
function jv6PoolWithLibrary(
  args: { readonly context: BlitzPlanningContext },
  planned: PlannedBlitzSuggestion,
  role: "video" | "image",
  library: readonly AssetCandidate[],
): Jv6PoolEntry[] {
  const brand: Jv6PoolEntry[] = rolePool(
    args.context.bank,
    "green-screen",
    planned.influencerId,
    role,
  ).map((m) => ({ id: m.id, text: mediaRelevanceText(m), media: m }));
  const lib: Jv6PoolEntry[] = library.map((c) => ({
    id: c.id,
    text: c.relevance ?? { title: c.description, tags: c.tags ?? [] },
  }));
  return rankByRelevance(planned.topic, [...brand, ...lib], (e) => e.text)
    .filter((r) => r.score > 0)
    .slice(0, JV6_MAX_CANDIDATES)
    .map((r) => r.item);
}

/** La marca, filtrada a lo que el decisor necesita (§9.15.3.5). */
export function decisionBrand(
  brandName: string,
  profile: CopyBrandProfile,
): DecisionBrand {
  return {
    name: brandName,
    identity: profile.coreIdentity,
    tone: profile.toneOfVoice,
    audience: profile.targetAudience,
  };
}

/** Un asset del Media Bank como candidato del decisor. */
export function mediaCandidate(
  m: PlanningMedia,
  kind: AssetCandidate["kind"],
  /** Sprint 9 (T): su fuente para las preferencias (`prefMediaSourceOf`). */
  mediaSource?: string | null,
): AssetCandidate {
  const relevance = mediaRelevanceText(m);
  return {
    id: m.id,
    kind,
    source: "brand",
    description: describeRelevanceText(relevance),
    tags: m.tags?.tags ?? [],
    relevance,
    ...(mediaSource === undefined || mediaSource === null ? {} : { mediaSource }),
  };
}

/**
 * El decisor por candidato sobre la sugerencia: personaje (si hay dos o más),
 * y en green-screen el meme y el fondo **entre todo el pool del rol** (el
 * filtro y la shortlist son del decisor). Sin tema no decide nada: sin idea no
 * hay «encaje con la idea» que medir.
 */
async function applyAssetDecisions(
  planned: PlannedBlitzSuggestion,
  args: {
    readonly rng: Rng;
    readonly context: BlitzPlanningContext;
    readonly brandName: string;
    readonly profile: CopyBrandProfile;
    readonly influencerProfiles?: ReadonlyMap<string, string> | undefined;
    readonly assets: AssetJudge;
    readonly recentIds?: Set<string> | undefined;
    readonly library?: LibrarySource | null | undefined;
    readonly mediaSources?: ReadonlyMap<string, string> | undefined;
  },
): Promise<PlannedBlitzSuggestion> {
  const idea = planned.topic;
  if (idea === null || idea.trim() === "") return planned;
  const brand = decisionBrand(args.brandName, args.profile);
  let out = planned;

  if (out.influencerCandidates.length >= 2) {
    const decision = await args.assets.decide({
      idea,
      brand,
      format: out.media.format,
      role: "character",
      candidates: out.influencerCandidates.map((id) => {
        const person = args.context.influencers.find((i) => i.id === id);
        const name = args.context.influencerNames.get(id) ?? "Unnamed character";
        return {
          id,
          kind: "character",
          source: "brand",
          description: describeInfluencerCandidate(
            name,
            person?.gender,
            args.influencerProfiles?.get(id),
          ),
        } satisfies AssetCandidate;
      }),
    });
    if (decision.chosenId !== null && decision.chosenId !== out.influencerId) {
      out = rebindInfluencer(args.rng, args.context, out, decision.chosenId);
    }
  }

  if (out.media.format === "green-screen") {
    for (const role of ["video", "image"] as const) {
      const pool = rolePool(args.context.bank, "green-screen", out.influencerId, role);
      const decisionRole = role === "video" ? "meme" : "background";
      // Sprint 9 (T): la biblioteca global compite con la marca en el mismo pool.
      const library =
        args.library === null || args.library === undefined
          ? []
          : await args.library.candidates({
              format: "green-screen",
              role: decisionRole,
              idea,
            });
      if (pool.length + library.length < 2) continue;
      const decision = await args.assets.decide({
        idea,
        brand,
        format: "green-screen",
        role: decisionRole,
        candidates: [
          ...pool.map((m) =>
            mediaCandidate(
              m,
              role === "video"
                ? "meme_clip"
                : m.mediaType === "video"
                  ? "background_video"
                  : "background_image",
              args.mediaSources?.get(m.id),
            ),
          ),
          ...library,
        ],
        recentIds: args.recentIds,
      });
      const chosen = decision.chosenId;
      if (chosen === null) continue;
      const fromLibrary = library.some((c) => c.id === chosen);
      const media = fromLibrary
        ? await args.library?.materialize(chosen)
        : pool.find((m) => m.id === chosen);
      if (media === undefined || media === null) continue;
      args.recentIds?.add(chosen);
      args.recentIds?.add(media.id);
      const what = role === "video" ? "Meme" : "Background";
      out = withJudgedMedia(
        out,
        role,
        mediaRefOf(media),
        `${what}: ${decision.reason.replace(/^Picked/u, "picked")}` +
          (fromLibrary ? " From the global library." : ""),
      );
    }
  }
  return out;
}
