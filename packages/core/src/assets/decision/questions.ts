/**
 * Las preguntas del decisor de assets y su estado — sprint 9 (O), D-18.
 *
 * ## Cómo están escritas (la guía de TypeSafe para System One)
 *
 * - **Una dimensión por pregunta.** «¿encaja con la idea?» y «¿encaja con la
 *   marca?» son dos preguntas, no una: si se mezclan, un 3 no dice cuál de las
 *   dos falló, y la ponderación (`weights.ts`) deja de poder separarlas.
 * - **Instrucciones completas y criterios completos.** Cada nivel de un
 *   `score` dice qué significa entero —Laya exige todos los niveles
 *   descriptos— y un `noul` dice qué es `true` **y** qué es `false`.
 * - **El estado es chico y es dato** (§9.15.3.4/5): la idea, la marca
 *   filtrada, el formato y **un** candidato. Las instrucciones nombran campos
 *   del estado (`idea`, `brand`, `candidate`) pero no llevan texto del
 *   usuario ni de terceros.
 * - En inglés, como el resto de los juicios. El estado puede venir en
 *   castellano: Laya rutea al checkpoint multilingüe por el idioma del estado.
 *
 * Cuatro niveles por `score`: con dos no hay graduación y con más de cuatro
 * los medios se vuelven indistinguibles para un modelo chico (y para quien
 * los escribió).
 */
import type { JudgmentState, NoulQuestion, ScoreQuestion } from "@fastgram/ports";

import { cleanStateText } from "../../judgment/preflight.js";
import type { AssetRole, DecisionFormat } from "./formats.js";
import type { AssetCandidate, DecisionBrand } from "./types.js";

/** El punto de decisión: el mismo de `JV-6` (selección de media, `DP-005`). */
export const ASSET_DECISION_POINT = "DP-005" as const;

/** Las dimensiones que se ponderan. La seguridad es un umbral duro, no un peso. */
export const ASSET_DIMENSIONS = ["ideaFit", "brandFit", "punchline"] as const;
export type AssetDimension = (typeof ASSET_DIMENSIONS)[number];

/**
 * Versión de las preguntas. Cambiar un texto cambia lo que miden: las filas
 * viejas de `asset_decisions` se comparan sólo con las de su versión.
 */
export const ASSET_QUESTIONS_VERSION = "s9.1";

export const IDEA_FIT_QUESTION: ScoreQuestion<"ideaFit"> = {
  id: "ideaFit",
  kind: "score",
  instructions:
    "How well does the candidate asset express the post idea? Judge only the match between `candidate` and `idea`, ignoring the brand.",
  levels: [
    "Unrelated: the candidate has nothing to do with the idea.",
    "Weak: it shares a word or a vague theme with the idea, but would not make a viewer think of it.",
    "Good: it clearly illustrates the idea or the feeling behind it.",
    "Perfect: it captures exactly the situation or emotion of the idea; a viewer would get the idea from this asset alone.",
  ],
};

export const BRAND_FIT_QUESTION: ScoreQuestion<"brandFit"> = {
  id: "brandFit",
  kind: "score",
  instructions:
    "How well does the candidate asset suit the brand described in `brand` (its identity, tone of voice and audience)? Judge only the brand match, not the idea.",
  levels: [
    "Off-brand: it clashes with the brand's tone or would confuse its audience.",
    "Neutral: nothing wrong with it for this brand, nothing specific to it either.",
    "On-brand: its tone and style match how this brand talks to its audience.",
    "Signature: it feels like something this brand would be known for.",
  ],
};

export const PUNCHLINE_QUESTION: ScoreQuestion<"punchline"> = {
  id: "punchline",
  kind: "score",
  instructions:
    "As a reaction meme for the idea, how clear and strong is the candidate clip's punchline? Judge whether the reaction reads instantly, without sound or context.",
  levels: [
    "No punchline: there is no readable reaction or joke in the clip.",
    "Muddy: there is a reaction, but it takes effort or context to get it.",
    "Clear: the reaction reads right away and lands.",
    "Strong: an instantly recognizable, very expressive reaction that makes the joke by itself.",
  ],
};

/**
 * La seguridad de marca: **dos** `noul` sobre la sola descripción, con un
 * umbral cada uno (`weights.ts`). Es lo que mejor separó en Laya.
 *
 * Se midieron cuatro redacciones contra descripciones inocuas y dañinas en
 * inglés y castellano (sprint 9, ver el reporte de O). Lo que salió:
 *
 * - «¿Es seguro para la marca?» con criterios largos no separaba nada (un
 *   tiroteo 0,42, un oficinista 0,33).
 * - «¿Es NSFW?» ({@link NSFW_QUESTION}) separa en inglés (tiroteo 0,90,
 *   cocaína 0,93, topless 0,84) pero en castellano da falsos positivos altos
 *   (un oficinista cansado un lunes: 0,82).
 * - «¿Muestra violencia, desnudez, drogas u odio?» ({@link HARM_QUESTION})
 *   casi no da falsos positivos en ninguno de los dos idiomas (inocuos ≤ 0,11)
 *   y agarra la violencia (0,52–0,80), pero se le escapan sexo, drogas y odio.
 *
 * Juntas, con umbrales distintos (harm ≥ 0,5 **o** nsfw ≥ 0,9), no hubo
 * falsos positivos en la muestra y se agarraron 5 de 13 casos dañinos.
 * **No es un guardrail completo**: ver el reporte.
 *
 * Con la idea y la marca en el estado separaban peor: por eso van en su propio
 * estado ({@link assetSafetyState}), que es además lo que pide §9.15.3.5.
 */
export const HARM_QUESTION: NoulQuestion<"harm"> = {
  id: "harm",
  kind: "noul",
  instructions:
    "Does the candidate show violence, blood, weapons, nudity, sexual content, drugs, or hate symbols?",
  criteria: {
    true: "Yes, it shows violence, nudity, sex, drugs or hate.",
    false: "No, it is harmless everyday content.",
  },
};

export const NSFW_QUESTION: NoulQuestion<"nsfw"> = {
  id: "nsfw",
  kind: "noul",
  instructions: "Is this content not safe for work?",
  criteria: {
    true: "NSFW: violence, nudity, sex, drugs, hate or gore.",
    false: "Safe for work.",
  },
};

/** Las dos, en un solo pedido (mismo estado). */
export const SAFETY_QUESTIONS = [HARM_QUESTION, NSFW_QUESTION] as const;
export type SafetyDimension = (typeof SAFETY_QUESTIONS)[number]["id"];

export type AssetFitQuestion =
  typeof IDEA_FIT_QUESTION | typeof BRAND_FIT_QUESTION | typeof PUNCHLINE_QUESTION;

/**
 * Qué se pregunta por un candidato de un rol (sobre {@link assetState}). El
 * remate sólo en memes: a un fondo o a una pista no se le pide un chiste. La
 * seguridad va aparte ({@link SAFETY_QUESTIONS} sobre {@link assetSafetyState}).
 */
export function assetQuestions(role: AssetRole): readonly AssetFitQuestion[] {
  return role === "meme"
    ? [IDEA_FIT_QUESTION, BRAND_FIT_QUESTION, PUNCHLINE_QUESTION]
    : [IDEA_FIT_QUESTION, BRAND_FIT_QUESTION];
}

export const ASSET_STATE_LIMITS = {
  idea: 500,
  field: 300,
  description: 400,
  tag: 40,
  tags: 12,
} as const;

/** Qué es cada clase de asset, en palabras, para el estado. */
const KIND_TEXT: Readonly<Record<AssetCandidate["kind"], string>> = {
  meme_clip: "green-screen reaction meme clip",
  background_image: "background image",
  background_video: "background video",
  image: "image",
  video_clip: "video clip",
  audio: "music track",
  character: "on-screen character",
};

/**
 * El estado de **un** candidato: `{idea, brand, format, candidate}`, limpio y
 * truncado. Sin id: el id es nuestro.
 */
export function assetState(input: {
  readonly idea: string | null | undefined;
  readonly brand: DecisionBrand;
  readonly format: DecisionFormat;
  readonly role: AssetRole;
  readonly candidate: AssetCandidate;
}): JudgmentState {
  const field = (v: string | null | undefined): string =>
    cleanStateText(v, ASSET_STATE_LIMITS.field);
  const c = input.candidate;
  const tags = (c.tags ?? [])
    .map((t) => cleanStateText(t, ASSET_STATE_LIMITS.tag))
    .filter((t) => t !== "")
    .slice(0, ASSET_STATE_LIMITS.tags);
  const brand: Record<string, string> = {
    name: field(input.brand.name),
    identity: field(input.brand.identity),
    tone: field(input.brand.tone),
    audience: field(input.brand.audience),
  };
  const styleRules = field(input.brand.styleRules);
  if (styleRules !== "") brand["styleRules"] = styleRules;
  const candidate: Record<string, string | number | readonly string[]> = {
    kind: KIND_TEXT[c.kind],
    description: cleanStateText(c.description, ASSET_STATE_LIMITS.description),
  };
  if (tags.length > 0) candidate["tags"] = tags;
  if (typeof c.durationSec === "number" && Number.isFinite(c.durationSec)) {
    candidate["durationSec"] = Math.round(c.durationSec);
  }
  return {
    idea: cleanStateText(input.idea, ASSET_STATE_LIMITS.idea),
    brand,
    format: `${input.format} (${input.role})`,
    candidate,
  };
}

/**
 * El estado de la pregunta de seguridad: **sólo** la descripción del
 * candidato (ver {@link HARM_QUESTION}: con más contexto, Laya separaba peor).
 */
export function assetSafetyState(candidate: AssetCandidate): JudgmentState {
  return {
    candidate: cleanStateText(candidate.description, ASSET_STATE_LIMITS.description),
  };
}
