/**
 * Catálogo verificado de fal para los formatos con voz — sprint 8 (agente L),
 * `P4-FORMAT-002`, `P4-INFL-011`.
 *
 * Cada entrada salió el 2026-09-24 de la página de API del modelo
 * (`https://fal.ai/models/<endpoint-id>/api`), de su `llms.txt` y de su
 * OpenAPI (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=…`).
 * Campos, valores permitidos, topes y **precio** son los de esas páginas;
 * `docsUrl` apunta a cada una. Lo que no está ahí no se manda.
 *
 * - **ElevenLabs Eleven v3** (`fal-ai/elevenlabs/tts/eleven-v3`): «$0.1 per
 *   1000 characters». Entrada `text` (requerido, `maxLength: 5000` en su
 *   OpenAPI), `voice` (default `"Rachel"`; las demás son los ejemplos que
 *   lista la página), `language_code` (ISO 639-1). Salida `audio: File`.
 * - **OmniHuman v1.5** (`fal-ai/bytedance/omnihuman/v1.5`): «$0.16 per
 *   seconds». Entrada `image_url`, `audio_url` (requeridos), `prompt`,
 *   `resolution` ∈ `720p`/`1080p`: «Audio must be under 30s long for 1080p
 *   generation and under 60s long for 720p generation»; «720p generation is
 *   faster and higher in quality». Salida `video: File` y `duration`
 *   («Duration of audio input/video output as used for billing»).
 * - **Wan 2.2 14B Animate Replace** (`fal-ai/wan/v2.2-14b/animate/replace`):
 *   «billed based on the number of frames, at a rate of 16 frames per "video
 *   second"»: 480p $0.04, 580p $0.06, 720p $0.08 por video second; «Total
 *   frames = video duration × fps». Entrada `video_url`, `image_url`
 *   (requeridos), `resolution` (default `480p`). Salida `video: File`.
 *
 * Todas aceptan un **data URI base64** como archivo de entrada («You can pass
 * a Base64 data URI as a file input», sección Files de cada página).
 *
 * - **MiniMax Speech-02 HD / Turbo** (`fal-ai/minimax/speech-02-hd`,
 *   `…/speech-02-turbo`): «$0.1 per 1000 characters» (HD) y «$0.06 per 1000
 *   character» (Turbo). Entrada `text` (máx. 5000), `voice_setting.voice_id`
 *   (default `Wise_Woman`), `language_boost` (nombres de idioma: `English`,
 *   `Spanish`…), `output_format` ∈ `url`/`hex` (default `hex`: se pide `url`).
 *   Salida `audio: File` y `duration_ms`. Están porque la biblioteca de
 *   modelos (agente K) deja elegir voces de MiniMax.
 *
 * sync-lipsync, LatentSync y Kling lipsync **no están**: el pipeline de
 * FastGram no los necesita (OmniHuman hace el lip-sync desde el retrato).
 *
 * ## Las voces son sugerencias
 *
 * Ninguno de los modelos de voz tiene un endpoint que liste voces: el campo
 * es texto libre y la página da ejemplos. `voices` son esos ejemplos (para
 * elegir en la UI); el adaptador acepta cualquier id con forma de id.
 */
import type {
  CharacterSwapModelSpec,
  SpeechModelSpec,
  TalkingAvatarModelSpec,
} from "@fastgram/ports";

import { roundUsd } from "./http.js";

const MODELS = "https://fal.ai/models";

export const FAL_ELEVEN_V3 = "fal-ai/elevenlabs/tts/eleven-v3";
export const FAL_OMNIHUMAN_V15 = "fal-ai/bytedance/omnihuman/v1.5";
export const FAL_WAN_ANIMATE_REPLACE = "fal-ai/wan/v2.2-14b/animate/replace";

export interface FalSpeechEntry {
  readonly spec: SpeechModelSpec;
  body(r: {
    text: string;
    voice?: string | undefined;
    languageCode?: string | undefined;
  }): Record<string, unknown>;
  price(chars: number): { readonly usd: number; readonly basis: string };
}

export interface FalAvatarEntry {
  readonly spec: TalkingAvatarModelSpec;
  body(r: {
    imageUrl: string;
    audioUrl: string;
    resolution: string;
    prompt?: string | undefined;
  }): Record<string, unknown>;
  price(seconds: number): { readonly usd: number; readonly basis: string };
}

export interface FalSwapEntry {
  readonly spec: CharacterSwapModelSpec;
  body(r: {
    imageUrl: string;
    videoUrl: string;
    resolution: string;
  }): Record<string, unknown>;
  price(r: { seconds: number; fps: number; resolution: string }): {
    readonly usd: number;
    readonly basis: string;
  };
}

/** Las voces que la página documenta: el default y sus ejemplos. */
const ELEVEN_VOICES = [
  "Rachel",
  "Aria",
  "Roger",
  "Sarah",
  "Laura",
  "Charlie",
  "George",
  "Callum",
  "River",
  "Liam",
  "Charlotte",
  "Alice",
  "Matilda",
  "Will",
  "Jessica",
  "Eric",
  "Chris",
  "Brian",
  "Daniel",
  "Lily",
  "Bill",
];

const ELEVEN_USD_PER_1000_CHARS = 0.1;

const elevenV3: FalSpeechEntry = {
  spec: {
    id: FAL_ELEVEN_V3,
    label: "ElevenLabs Eleven v3",
    maxChars: 5000,
    voices: ELEVEN_VOICES,
    defaultVoice: "Rachel",
    languageCode: true,
    docsUrl: `${MODELS}/${FAL_ELEVEN_V3}/api`,
    listPrice: {
      summary: "$0.10 per 1,000 characters",
      sourceUrl: `${MODELS}/${FAL_ELEVEN_V3}/api`,
    },
  },
  body: (r) => ({
    text: r.text,
    ...(r.voice === undefined ? {} : { voice: r.voice }),
    ...(r.languageCode === undefined ? {} : { language_code: r.languageCode }),
  }),
  price: (chars) => ({
    usd: roundUsd((chars / 1000) * ELEVEN_USD_PER_1000_CHARS),
    basis: `${String(chars)} characters × $0.10 per 1,000 (list price)`,
  }),
};

const OMNIHUMAN_USD_PER_SECOND = 0.16;

const omnihuman: FalAvatarEntry = {
  spec: {
    id: FAL_OMNIHUMAN_V15,
    label: "OmniHuman v1.5",
    // 720p primero: acepta el doble de audio y la página dice que es «faster
    // and higher in quality».
    resolutions: [
      { id: "720p", maxAudioSeconds: 60 },
      { id: "1080p", maxAudioSeconds: 30 },
    ],
    promptSupported: true,
    docsUrl: `${MODELS}/${FAL_OMNIHUMAN_V15}/api`,
    listPrice: {
      summary: "$0.16 per second",
      sourceUrl: `${MODELS}/${FAL_OMNIHUMAN_V15}/api`,
    },
  },
  body: (r) => ({
    image_url: r.imageUrl,
    audio_url: r.audioUrl,
    resolution: r.resolution,
    ...(r.prompt === undefined || r.prompt.trim() === "" ? {} : { prompt: r.prompt }),
  }),
  price: (seconds) => {
    const billed = Math.ceil(seconds);
    return {
      usd: roundUsd(billed * OMNIHUMAN_USD_PER_SECOND),
      basis: `${String(billed)} s × $0.16 per second (list price)`,
    };
  },
};

const WAN_USD_PER_VIDEO_SECOND: Readonly<Record<string, number>> = {
  "480p": 0.04,
  "580p": 0.06,
  "720p": 0.08,
};

const wanReplace: FalSwapEntry = {
  spec: {
    id: FAL_WAN_ANIMATE_REPLACE,
    label: "Wan 2.2 Animate · Replace",
    resolutions: ["480p", "580p", "720p"],
    docsUrl: `${MODELS}/${FAL_WAN_ANIMATE_REPLACE}/api`,
    listPrice: {
      summary: "$0.04 (480p) to $0.08 (720p) per video second of 16 frames",
      sourceUrl: `${MODELS}/${FAL_WAN_ANIMATE_REPLACE}/api`,
    },
  },
  body: (r) => ({
    video_url: r.videoUrl,
    image_url: r.imageUrl,
    resolution: r.resolution,
  }),
  price: ({ seconds, fps, resolution }) => {
    const rate = WAN_USD_PER_VIDEO_SECOND[resolution] ?? 0.08;
    const frames = Math.ceil(seconds * fps);
    const billed = frames / 16;
    return {
      usd: roundUsd(billed * rate),
      basis: `${String(frames)} frames (${seconds.toFixed(1)} s × ${String(fps)} fps) ÷ 16 × $${rate.toFixed(2)} per video second at ${resolution} (list price)`,
    };
  },
};

/** `language_boost` de MiniMax usa nombres; los códigos que sabemos traducir. */
const MINIMAX_LANGUAGES: Readonly<Record<string, string>> = {
  en: "English",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
  nl: "Dutch",
  ru: "Russian",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  ar: "Arabic",
  tr: "Turkish",
  pl: "Polish",
  hi: "Hindi",
};

const MINIMAX_VOICES = [
  "Wise_Woman",
  "Friendly_Person",
  "Inspirational_girl",
  "Deep_Voice_Man",
  "Calm_Woman",
  "Casual_Guy",
  "Lively_Girl",
  "Patient_Man",
  "Young_Knight",
  "Determined_Man",
  "Lovely_Girl",
  "Decent_Boy",
  "Imposing_Manner",
  "Elegant_Man",
  "Abbess",
  "Sweet_Girl_2",
  "Exuberant_Girl",
];

function minimax(id: string, label: string, usdPer1000: number): FalSpeechEntry {
  const price = `$${usdPer1000.toFixed(2)} per 1,000 characters`;
  return {
    spec: {
      id,
      label,
      maxChars: 5000,
      voices: MINIMAX_VOICES,
      defaultVoice: "Wise_Woman",
      languageCode: true,
      docsUrl: `${MODELS}/${id}/api`,
      listPrice: { summary: price, sourceUrl: `${MODELS}/${id}/api` },
    },
    body: (r) => {
      const language =
        r.languageCode === undefined ? undefined : MINIMAX_LANGUAGES[r.languageCode];
      return {
        text: r.text,
        output_format: "url",
        ...(r.voice === undefined ? {} : { voice_setting: { voice_id: r.voice } }),
        ...(language === undefined ? {} : { language_boost: language }),
      };
    },
    price: (chars) => ({
      usd: roundUsd((chars / 1000) * usdPer1000),
      basis: `${String(chars)} characters × ${price} (list price)`,
    }),
  };
}

export const FAL_MINIMAX_SPEECH_HD = "fal-ai/minimax/speech-02-hd";
export const FAL_MINIMAX_SPEECH_TURBO = "fal-ai/minimax/speech-02-turbo";

export const FAL_SPEECH_MODELS: readonly FalSpeechEntry[] = [
  elevenV3,
  minimax(FAL_MINIMAX_SPEECH_HD, "MiniMax Speech-02 HD", 0.1),
  minimax(FAL_MINIMAX_SPEECH_TURBO, "MiniMax Speech-02 Turbo", 0.06),
];
export const FAL_AVATAR_MODELS: readonly FalAvatarEntry[] = [omnihuman];
export const FAL_SWAP_MODELS: readonly FalSwapEntry[] = [wanReplace];

/** Todos los ids de voz, para «¿este id es de este catálogo?». */
export function falVoiceModelIds(task: "speech" | "avatar" | "swap"): string[] {
  const list =
    task === "speech"
      ? FAL_SPEECH_MODELS
      : task === "avatar"
        ? FAL_AVATAR_MODELS
        : FAL_SWAP_MODELS;
  return list.map((m) => m.spec.id);
}
