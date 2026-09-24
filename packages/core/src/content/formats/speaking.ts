/**
 * Formatos con voz — sprint 8 (agente L), `P4-FORMAT-002`, `P4-INFL-011`,
 * `AI-010`.
 *
 * Lógica pura: el largo del guion, la guía de palabras de `AI-010`, el pedido
 * al modelo de texto para escribir el guion y la pieza que se arma al final.
 *
 * ## El largo del guion
 *
 * `AI-010` da el único número: para 5 s, *«Target 10-15 words»* → 2 a 3
 * palabras por segundo. La guía (`scriptGuidance`) usa eso y el mensaje
 * literal (*«0 words may be too short for 5s - Target 10-15 words»*); es una
 * advertencia, no un bloqueo, como en el PRD.
 *
 * Lo que **sí** bloquea es el límite del modelo: OmniHuman acepta hasta 60 s
 * de audio a 720p (30 s a 1080p). Un guion que a 2,5 palabras por segundo
 * (el medio del rango) pasa ese tope se rechaza antes de pagar la voz. Si
 * igual la voz sale más larga, el worker lo mide y corta ahí, cobrando sólo
 * la voz.
 *
 * ## El costo
 *
 * Voz: caracteres × precio de lista. Avatar: segundos de audio × precio. Los
 * segundos se estiman a **2 palabras por segundo** (el extremo lento del
 * rango): el estimado alimenta el tope mensual y contar de más es lo seguro.
 * Cuando la voz existe, el worker reserva con la duración real.
 */
import type { LlmMessage, UntrustedBlock } from "@fastgram/ports";

import {
  composeBlitzBuildPayload,
  SUGGESTION_BUILD_PLAN_VERSION,
  BLITZ_VIDEO_CANVAS,
  type BlitzBuildPayload,
} from "../../discovery/blitz-build.js";
import type { SpeakingGenerativeFormat, SpeakingLayout } from "./catalog.js";
import { flatten } from "./plan.js";

/** Duraciones que se ofrecen, en segundos. 60 = el tope de OmniHuman a 720p. */
export const SPEAKING_DURATIONS = [5, 10, 15, 20, 30, 45, 60] as const;

/** `AI-010`: 5 s → 10-15 palabras. */
export const SPEAKING_WORDS_PER_SECOND_MIN = 2;
export const SPEAKING_WORDS_PER_SECOND_MAX = 3;
/** El medio del rango: para el tope duro contra el límite del modelo. */
const WORDS_PER_SECOND_MID = 2.5;

/** Tope del tema que el usuario da para que el modelo escriba el guion. */
export const SPEAKING_TOPIC_MAX_CHARS = 300;
/** Tope del caption que va encima del video. Decisión nuestra. */
export const SPEAKING_CAPTION_MAX_CHARS = 120;

export function countWords(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

export interface ScriptTarget {
  readonly min: number;
  readonly max: number;
}

export function scriptTarget(durationSeconds: number): ScriptTarget {
  return {
    min: Math.round(durationSeconds * SPEAKING_WORDS_PER_SECOND_MIN),
    max: Math.round(durationSeconds * SPEAKING_WORDS_PER_SECOND_MAX),
  };
}

export interface ScriptGuidance {
  readonly words: number;
  readonly target: ScriptTarget;
  readonly level: "ok" | "short" | "long";
  /** En inglés, para la UI. `null` si está en el rango. */
  readonly message: string | null;
}

/** La guía en vivo de `AI-010`, con su mensaje literal para «corto». */
export function scriptGuidance(script: string, durationSeconds: number): ScriptGuidance {
  const words = countWords(script);
  const target = scriptTarget(durationSeconds);
  const range = `Target ${String(target.min)}-${String(target.max)} words`;
  const d = `${String(durationSeconds)}s`;
  if (words < target.min) {
    return {
      words,
      target,
      level: "short",
      message: `${String(words)} words may be too short for ${d} - ${range}`,
    };
  }
  if (words > target.max) {
    return {
      words,
      target,
      level: "long",
      message: `${String(words)} words may be too long for ${d} - ${range}`,
    };
  }
  return { words, target, level: "ok", message: null };
}

/** Cuántas palabras entran en el tope de audio del modelo. */
export function maxScriptWords(maxAudioSeconds: number): number {
  return Math.floor(maxAudioSeconds * WORDS_PER_SECOND_MID);
}

/** Segundos de voz para **estimar**: el extremo lento, sin pasar el tope. */
export function estimatedSpeechSeconds(words: number, maxAudioSeconds: number): number {
  return Math.min(
    maxAudioSeconds,
    Math.max(1, Math.ceil(words / SPEAKING_WORDS_PER_SECOND_MIN)),
  );
}

export type ScriptCheck =
  | { readonly ok: true; readonly script: string; readonly words: number }
  | { readonly ok: false; readonly message: string };

/** El guion contra los topes del modelo de voz y del avatar. */
export function checkSpeakingScript(
  raw: string,
  limits: { readonly maxChars: number; readonly maxAudioSeconds: number },
): ScriptCheck {
  const script = raw.replace(/[ \t]+/g, " ").trim();
  if (script === "") return { ok: false, message: "Write the script, or generate one." };
  if (script.length > limits.maxChars) {
    return {
      ok: false,
      message: `Keep the script under ${String(limits.maxChars)} characters.`,
    };
  }
  const words = countWords(script);
  const max = maxScriptWords(limits.maxAudioSeconds);
  if (words > max) {
    return {
      ok: false,
      message: `That script runs past the ${String(limits.maxAudioSeconds)} s the video model accepts. Keep it under ${String(max)} words.`,
    };
  }
  return { ok: true, script, words };
}

/* ------------------------------------------------------------------------ *
 * Escribir el guion con el modelo de texto
 * ------------------------------------------------------------------------ */

export interface ScriptBrandBrief {
  readonly productOffering?: string | null;
  readonly coreIdentity?: string | null;
  readonly audience?: string | null;
}

export interface ScriptPromptInput {
  readonly format: Pick<SpeakingGenerativeFormat, "label" | "scriptStyle">;
  readonly durationSeconds: number;
  /** El nombre del idioma («English»). */
  readonly language: string;
  readonly topic?: string | undefined;
  readonly brand?: ScriptBrandBrief | null | undefined;
}

export interface ScriptPrompt {
  readonly messages: readonly LlmMessage[];
  readonly untrusted: readonly UntrustedBlock[];
  readonly target: ScriptTarget;
}

/**
 * Los mensajes para pedir un guion. El perfil de la marca sale de su web
 * (texto de terceros): va como bloque no confiable, nunca en el mensaje.
 */
export function speakingScriptPrompt(input: ScriptPromptInput): ScriptPrompt {
  const target = scriptTarget(input.durationSeconds);
  const topic = flatten(input.topic ?? "").slice(0, SPEAKING_TOPIC_MAX_CHARS);
  const untrusted: UntrustedBlock[] = [];
  const brand = input.brand;
  if (brand !== null && brand !== undefined) {
    const lines = [
      ["What the brand offers", brand.productOffering],
      ["Who the brand is", brand.coreIdentity],
      ["Audience", brand.audience],
    ]
      .filter((pair): pair is [string, string] => typeof pair[1] === "string")
      .map(([k, v]) => `${k}: ${flatten(v).slice(0, 400)}`)
      .filter((line) => !line.endsWith(": "));
    if (lines.length > 0) {
      untrusted.push({ label: "brand_profile", content: lines.join("\n") });
    }
  }
  const messages: LlmMessage[] = [
    {
      role: "system",
      content: [
        "You write scripts that one person says out loud in a short vertical social video.",
        "Output ONLY the words to be spoken: no title, no quotes, no stage directions, no emojis, no hashtags, no speaker labels.",
        `Write in ${input.language}.`,
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Format: ${input.format.label}. ${input.format.scriptStyle}`,
        `Length: about ${String(input.durationSeconds)} seconds spoken, so ${String(target.min)} to ${String(target.max)} words.`,
        topic === "" ? "Topic: the brand's main offer." : `Topic: ${topic}`,
      ].join("\n"),
    },
  ];
  return { messages, untrusted, target };
}

/**
 * La salida del modelo → un guion que se puede leer en voz alta: una línea,
 * sin comillas envolventes, sin etiquetas («Script:») ni acotaciones entre
 * corchetes, y cortado en `maxWords` (en el último punto si queda cerca).
 */
export function cleanGeneratedScript(raw: string, maxWords: number): string {
  let text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/^\s*(script|voiceover|narrator)\s*:\s*/i, "")
    .replace(/[#*_`]/g, "");
  text = flatten(text)
    .replace(/^["“'”]+|["“'”]+$/g, "")
    .trim();
  const words = text.split(/\s+/).filter((w) => w !== "");
  if (words.length <= maxWords) return words.join(" ");
  const cut = words.slice(0, maxWords).join(" ");
  const end = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
  );
  return end > cut.length * 0.6 ? cut.slice(0, end + 1) : cut;
}

/** El caption por defecto: la primera frase del guion, acotada. */
export function captionFromScript(script: string): string {
  const flat = flatten(script);
  const first = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  if (first.length <= SPEAKING_CAPTION_MAX_CHARS) return first;
  const cut = first.slice(0, SPEAKING_CAPTION_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > 60 ? cut.slice(0, space) : cut).trim()}…`;
}

/* ------------------------------------------------------------------------ *
 * La pieza
 * ------------------------------------------------------------------------ */

export interface SpeakingPieceInput {
  readonly layout: SpeakingLayout;
  /** El video del avatar, ya en el Media Bank. */
  readonly avatar: { readonly mediaId: string; readonly url: string };
  /** El video tuyo, en los layouts que lo piden. */
  readonly demo: { readonly mediaId: string; readonly url: string } | null;
  /** La voz en nuestro storage: entra como el bloque `audio`. */
  readonly voiceUrl: string;
  /** `""` = sin caption (el render no dibuja una caja vacía). */
  readonly caption: string;
  readonly textStylePresetId?: string | null | undefined;
}

/** El avatar en la esquina: 40 % del ancho, 9:16, abajo a la derecha. */
export const CORNER_AVATAR = (() => {
  const { width, height } = BLITZ_VIDEO_CANVAS;
  const w = Math.round(width * 0.4);
  const h = Math.round((w * 16) / 9);
  const margin = Math.round(width * 0.045);
  return { x: width - w - margin, y: height - h - Math.round(height * 0.08), w, h };
})();

/**
 * El payload de build: `wall-of-text` (`full`) o `video-hook` (los dos con
 * demo), con la voz como `audio`. Devuelve `null` si el layout pide un demo y
 * no hay.
 */
export function speakingBuildPayload(
  input: SpeakingPieceInput,
): BlitzBuildPayload | null {
  const audio = { audioId: "speaking-voice", url: input.voiceUrl };
  const texts = [input.caption];
  const options = { textStylePresetId: input.textStylePresetId };
  if (input.layout === "full") {
    return composeBlitzBuildPayload(
      {
        version: SUGGESTION_BUILD_PLAN_VERSION,
        media: { format: "wall-of-text", video: input.avatar },
        texts,
        audio,
      },
      options,
    );
  }
  if (input.demo === null) return null;
  if (input.layout === "hook-demo") {
    return composeBlitzBuildPayload(
      {
        version: SUGGESTION_BUILD_PLAN_VERSION,
        media: { format: "video-hook", hookVideo: input.avatar, demoVideo: input.demo },
        texts,
        audio,
      },
      options,
    );
  }
  // `corner-over-demo`: el render dibuja `demo_video` **encima** de
  // `hook_video`, así que el demo va como «hook» a lienzo completo y el avatar
  // como «demo» en la esquina.
  const base = composeBlitzBuildPayload(
    {
      version: SUGGESTION_BUILD_PLAN_VERSION,
      media: { format: "video-hook", hookVideo: input.demo, demoVideo: input.avatar },
      texts,
      audio,
    },
    options,
  );
  if (!("hook_video" in base)) return base;
  const { width, height } = BLITZ_VIDEO_CANVAS;
  return {
    ...base,
    hook_video: { ...base.hook_video, drawX: 0, drawY: 0, drawW: width, drawH: height },
    demo_video: {
      ...base.demo_video,
      drawX: CORNER_AVATAR.x,
      drawY: CORNER_AVATAR.y,
      drawW: CORNER_AVATAR.w,
      drawH: CORNER_AVATAR.h,
    },
  };
}

/** El character swap: el video resultante con el caption encima, sin audio nuevo. */
export function swapBuildPayload(input: {
  readonly video: { readonly mediaId: string; readonly url: string };
  readonly caption: string;
  readonly textStylePresetId?: string | null | undefined;
}): BlitzBuildPayload {
  return composeBlitzBuildPayload(
    {
      version: SUGGESTION_BUILD_PLAN_VERSION,
      media: { format: "wall-of-text", video: input.video },
      texts: [input.caption],
    },
    { textStylePresetId: input.textStylePresetId },
  );
}
