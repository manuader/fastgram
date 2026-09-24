/**
 * Elegir el mejor candidato para un tema — `JV-6` (`P4-JV-003`, `DP-005`,
 * PRD §25) adaptado a uso personal (sprint 7, «memes desde un prompt»).
 *
 * ## El problema
 *
 * Hasta acá el clip de meme, el fondo y el influencer se elegían **al azar**
 * (`selectMedia`, `planBlitzSuggestion`) aunque el usuario hubiera escrito
 * «un meme sobre los lunes» y el Media Bank tuviera un clip etiquetado
 * `situation: "hates mondays"` (etiquetas de `PU-MEME-003`).
 *
 * ## Las dos mitades, y por qué la segunda es opcional
 *
 * 1. **Ranking determinístico** (acá, puro): cada candidato tiene texto que lo
 *    describe —las etiquetas del clip, su título, el nombre del influencer, la
 *    referencia guardada— y se puntúa por cuántas palabras del tema aparecen,
 *    con más peso para lo que el modelo de visión vio (emoción, situación,
 *    tags) que para el título. Es barato, reproducible y alcanza cuando hay un
 *    solo candidato claro.
 * 2. **Juicio acotado** (`Judgment.choice`, `DP-005`): entre los N mejores
 *    del ranking, un LLM de texto elige uno. La salida es **tipada**: una de
 *    las opciones `option_1…option_N` que declaramos, nunca texto libre. Si no
 *    hay modelo, si no responde o si responde con poca confianza, gana el
 *    ranking ({@link resolveJudgedChoice}). Un juicio caído nunca deja al
 *    usuario sin pieza.
 *
 * ## Qué es dato
 *
 * Todo texto de los candidatos es de terceros (títulos de YouTube, etiquetas
 * que escribió un modelo mirando cuadros de un video, captions guardadas) y el
 * tema lo escribió el usuario. Por eso **nada** de eso va en `instructions` ni
 * en `criteria` de la pregunta: van en el `state`, limpio y truncado
 * (`cleanStateText`), y el adaptador los mete en el bloque `untrusted` del
 * puerto `Llm`. La pregunta sólo nombra opciones opacas.
 *
 * ## Lo que no hace
 *
 * No entiende sinónimos ni idiomas cruzados («lunes» no matchea «monday»).
 * Para eso está el juicio; el ranking es el piso, no el techo.
 */
import type { ChoiceAnswer, ChoiceQuestion, JudgmentState } from "@fastgram/ports";

import { cleanStateText } from "../judgment/preflight.js";

/* ------------------------------------------------------------------------ *
 * Palabras
 * ------------------------------------------------------------------------ */

/**
 * Palabras que no dicen de qué trata un tema: artículos y preposiciones en
 * inglés y castellano (los dos idiomas del dueño), y **las del formato**
 * («meme», «green screen», «video»): un pedido de green-screen siempre las
 * trae y no distinguen un clip de otro.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // en
  "the",
  "and",
  "for",
  "with",
  "about",
  "that",
  "this",
  "your",
  "you",
  "are",
  "was",
  "from",
  "into",
  "when",
  "what",
  "make",
  "some",
  "our",
  "my",
  // es
  "los",
  "las",
  "una",
  "uno",
  "unos",
  "unas",
  "del",
  "con",
  "que",
  "por",
  "para",
  "sobre",
  "mis",
  "tus",
  "sus",
  "hace",
  "hacer",
  "haceme",
  "como",
  "cuando",
  "este",
  "esta",
  "esto",
  "nuestro",
  "nuestra",
  // formato
  "meme",
  "memes",
  "green",
  "screen",
  "greenscreen",
  "pantalla",
  "verde",
  "video",
  "videos",
  "clip",
  "clips",
  "reel",
  "tiktok",
]);

/**
 * Raíz tosca: sin tildes, minúscula, cinco letras como mucho y sin plural
 * final. «surprised» y «surprise» dan `surpr`; «lunes» da `lun`. Es a
 * propósito tosca: el objetivo es no perder un match obvio, no la lingüística.
 */
function stem(word: string): string {
  if (word.length > 5) return word.slice(0, 5);
  return word.replace(/(es|s)$/u, "");
}

/** Las raíces de un texto, sin repetir y sin stopwords. */
export function topicStems(text: string | null | undefined): readonly string[] {
  if (text === null || text === undefined) return [];
  const words = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const out: string[] = [];
  for (const w of words) {
    const s = stem(w);
    if (s.length >= 2 && !out.includes(s)) out.push(s);
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------------ */

/**
 * Lo que describe a un candidato, por campo. Los pesos premian lo que se vio
 * en el clip (etiquetas del modelo de visión) sobre lo que alguien tituló.
 */
export interface RelevanceText {
  /** Etiquetas cortas (`ClipTags.tags`, hashtags). Peso 3. */
  readonly tags?: readonly string[] | undefined;
  /** La emoción dominante (`ClipTags.emotion`). Peso 3. */
  readonly emotion?: string | null | undefined;
  /** Qué pasa (`ClipTags.situation`). Peso 2. */
  readonly situation?: string | null | undefined;
  /** Título, nombre de archivo, caption. Peso 1. */
  readonly title?: string | null | undefined;
}

export const RELEVANCE_WEIGHTS = { tags: 3, emotion: 3, situation: 2, title: 1 } as const;

/**
 * Cuánto le corresponde un candidato al tema: por cada raíz del tema, el peso
 * del campo más fuerte que la contiene. `0` = nada en común.
 */
export function relevanceScore(topic: readonly string[], text: RelevanceText): number {
  if (topic.length === 0) return 0;
  const fields: [ReadonlySet<string>, number][] = [
    [new Set(topicStems((text.tags ?? []).join(" "))), RELEVANCE_WEIGHTS.tags],
    [new Set(topicStems(text.emotion)), RELEVANCE_WEIGHTS.emotion],
    [new Set(topicStems(text.situation)), RELEVANCE_WEIGHTS.situation],
    [new Set(topicStems(text.title)), RELEVANCE_WEIGHTS.title],
  ];
  let score = 0;
  for (const s of topic) {
    let best = 0;
    for (const [stems, weight] of fields) {
      if (stems.has(s) && weight > best) best = weight;
    }
    score += best;
  }
  return score;
}

export interface Ranked<T> {
  readonly item: T;
  readonly score: number;
}

/**
 * Los candidatos de mayor a menor relevancia. **Estable**: a igual puntaje
 * conserva el orden de entrada, así que sin tema (o sin nada en común) la
 * lista sale igual que entró y quien sortea después consume el `Rng` igual
 * que antes de este módulo.
 */
export function rankByRelevance<T>(
  topic: string | null | undefined,
  items: readonly T[],
  describe: (item: T) => RelevanceText,
): readonly Ranked<T>[] {
  const stems = topicStems(topic);
  return items
    .map((item, index) => ({ item, index, score: relevanceScore(stems, describe(item)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item, score }) => ({ item, score }));
}

/** Los que empatan con el mejor puntaje **positivo**. Vacío si nadie matchea. */
export function topMatches<T>(ranked: readonly Ranked<T>[]): readonly T[] {
  const best = ranked[0]?.score ?? 0;
  if (best <= 0) return [];
  return ranked.filter((r) => r.score === best).map((r) => r.item);
}

/* ------------------------------------------------------------------------ *
 * Juicio acotado — `JV-6`, `DP-005`
 * ------------------------------------------------------------------------ */

/** El punto de decisión de `JV-6` (PRD §25.1). */
export const JV6_DECISION_POINT = "DP-005" as const;

/** Cuántos candidatos llegan al juicio. Más es ruido y tokens; el ranking ya filtró. */
export const JV6_MAX_CANDIDATES = 5;

/**
 * Por debajo de esta confianza manda el ranking. `JV-6` no tiene umbral en el
 * PRD; 0,4 es nuestra elección (decisión que el PRD no cubre): con cinco
 * opciones, el azar da 0,2, y el doble ya es una preferencia.
 */
export const JV6_MIN_CONFIDENCE = 0.4;

/** Qué se elige. Cambia sólo la frase de la pregunta. */
export type Jv6Subject = "meme" | "background" | "influencer" | "reference";

const SUBJECT_TEXT: Readonly<Record<Jv6Subject, string>> = {
  meme: "Which green-screen meme clip in the state's candidates fits the topic best as a reaction for this brand's post?",
  background:
    "Which background in the state's candidates fits the topic best for this brand's post?",
  influencer:
    "Which influencer in the state's candidates fits this brand and the topic best to front the post?",
  reference:
    "Which saved reference post in the state's candidates is the best one to remix for this brand and the topic?",
};

/** Un candidato del juicio: el id es nuestro y nunca viaja al modelo. */
export interface Jv6Candidate {
  readonly id: string;
  /** Lo que lo describe. Texto de terceros: va al `state`, limpio. */
  readonly description: string;
}

export const JV6_STATE_LIMITS = { topic: 500, field: 300, description: 400 } as const;

/** `option_1…option_N`: opacas a propósito, ver la cabecera. */
export function jv6Option(index: number): string {
  return `option_${String(index + 1)}`;
}

/** La pregunta. Sin texto de terceros: sólo opciones opacas. */
export function jv6Question(
  subject: Jv6Subject,
  count: number,
): ChoiceQuestion<"bestFit", string> {
  if (!Number.isInteger(count) || count < 2) {
    throw new Error(
      `jv6Question necesita al menos 2 candidatos, llegaron ${String(count)}`,
    );
  }
  const criteria: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) {
    const option = jv6Option(i);
    criteria[option] =
      `The candidate whose "option" field is ${option} in the state is the best fit.`;
  }
  return {
    id: "bestFit",
    kind: "choice",
    instructions: SUBJECT_TEXT[subject],
    criteria,
  };
}

/** El estado: tema, marca y candidatos, limpios y truncados. */
export function jv6State(input: {
  readonly topic: string | null | undefined;
  readonly brand: {
    readonly name?: string | null | undefined;
    readonly coreIdentity?: string | null | undefined;
    readonly targetAudience?: string | null | undefined;
    readonly toneOfVoice?: string | null | undefined;
  };
  readonly candidates: readonly Jv6Candidate[];
}): JudgmentState {
  const field = (v: string | null | undefined): string =>
    cleanStateText(v, JV6_STATE_LIMITS.field);
  return {
    topic: cleanStateText(input.topic, JV6_STATE_LIMITS.topic),
    brand: {
      name: field(input.brand.name),
      coreIdentity: field(input.brand.coreIdentity),
      targetAudience: field(input.brand.targetAudience),
      toneOfVoice: field(input.brand.toneOfVoice),
    },
    candidates: input.candidates.map((c, i) => ({
      option: jv6Option(i),
      description: cleanStateText(c.description, JV6_STATE_LIMITS.description),
    })),
  };
}

/**
 * El id elegido, o `null` si manda el ranking: sin respuesta, confianza baja o
 * una opción que no declaramos (el adaptador ya lo impide; esto es el
 * cinturón).
 */
export function resolveJudgedChoice(
  answer: ChoiceAnswer | null,
  candidates: readonly Jv6Candidate[],
  minConfidence: number = JV6_MIN_CONFIDENCE,
): string | null {
  if (answer === null) return null;
  if (!(answer.confidence >= minConfidence)) return null;
  const match = /^option_(\d+)$/u.exec(answer.value);
  if (match === null) return null;
  const index = Number(match[1]) - 1;
  return candidates[index]?.id ?? null;
}

/** Una línea para describir un candidato a partir de su texto de relevancia. */
export function describeRelevanceText(text: RelevanceText): string {
  const parts: string[] = [];
  if (text.title !== undefined && text.title !== null && text.title.trim() !== "") {
    parts.push(`title: ${text.title.trim()}`);
  }
  if (text.emotion !== undefined && text.emotion !== null && text.emotion !== "") {
    parts.push(`emotion: ${text.emotion}`);
  }
  if (text.situation !== undefined && text.situation !== null && text.situation !== "") {
    parts.push(`situation: ${text.situation}`);
  }
  if (text.tags !== undefined && text.tags.length > 0) {
    parts.push(`tags: ${text.tags.join(", ")}`);
  }
  return parts.length === 0 ? "no description" : parts.join("; ");
}
