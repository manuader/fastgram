/**
 * Formatos con voz y character swap — sprint 8 (agente L), `P4-FORMAT-002`,
 * `P4-INFL-011`, `AI-010`.
 *
 *   GET  /ai-studio/speaking/options                 modelos, voces, biblioteca, tope
 *   POST /ai-studio/speaking/{format}/script         el modelo de texto escribe el guion
 *   POST /ai-studio/speaking/{format}/estimate       costo de voz + video
 *   POST /ai-studio/speaking/{format}/runs           reservar y encolar (202)
 *   POST /ai-studio/swap/estimate                    costo del character swap
 *   POST /ai-studio/swap/runs                        reservar y encolar (202)
 *   GET  /ai-studio/speaking-runs                    corridas de la marca
 *   GET  /ai-studio/speaking-runs/{id}               una corrida
 *
 * Mismas reglas que AI Studio (`genai.ts`): el costo es **estimado** (precio
 * de lista de fal), pasar el tope responde 402 con `details.reason =
 * "budget_exceeded"`, y ninguna respuesta lleva una key ni una URL del
 * proveedor.
 *
 * El retrato sale de un modelo de la biblioteca (`characterModelId`, contrato
 * `GET /character-models` del agente K) o de una imagen del Media Bank
 * (`portraitMediaId`): uno de los dos, no ambos. La voz: la del modelo de la
 * biblioteca si la tiene; si no, la elegida (`voiceId`).
 */
import { z } from "zod";

import {
  budgetSummarySchema,
  costEstimateSchema,
  generationMediaSchema,
} from "./genai.js";
import { modelProviderSchema } from "./models.js";

export const SPEAKING_SCRIPT_MAX_CHARS = 5000;
export const SPEAKING_TOPIC_MAX_CHARS = 300;
export const SPEAKING_CAPTION_MAX_CHARS = 120;

const listPriceSchema = z
  .object({ summary: z.string(), sourceUrl: z.string() })
  .nullable();

export const speechModelSpecSchema = z.object({
  id: z.string(),
  label: z.string(),
  maxChars: z.number().int().positive(),
  voices: z.array(z.string()),
  defaultVoice: z.string(),
  languageCode: z.boolean(),
  docsUrl: z.string(),
  listPrice: listPriceSchema,
});
export type SpeechModelSpec = z.infer<typeof speechModelSpecSchema>;

export const avatarModelSpecSchema = z.object({
  id: z.string(),
  label: z.string(),
  resolutions: z.array(
    z.object({ id: z.string(), maxAudioSeconds: z.number().positive() }),
  ),
  promptSupported: z.boolean(),
  docsUrl: z.string(),
  listPrice: listPriceSchema,
});
export type AvatarModelSpec = z.infer<typeof avatarModelSpecSchema>;

export const swapModelSpecSchema = z.object({
  id: z.string(),
  label: z.string(),
  resolutions: z.array(z.string()),
  docsUrl: z.string(),
  listPrice: listPriceSchema,
});
export type SwapModelSpec = z.infer<typeof swapModelSpecSchema>;

const taskOptions = <T extends z.ZodTypeAny>(spec: T) =>
  z.object({
    /** La tarea está completa en Settings → Models (con key propia o de fal). */
    configured: z.boolean(),
    provider: modelProviderSchema.nullable(),
    defaultModel: z.string().nullable(),
    models: z.array(spec),
  });

/** Un modelo de la biblioteca, tal como lo necesita esta pantalla. */
export const speakingCharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  portraitUrl: z.string(),
  status: z.enum(["ready", "training", "failed"]),
  voice: z
    .object({ provider: z.string(), model: z.string(), voiceId: z.string() })
    .nullable(),
});
export type SpeakingCharacter = z.infer<typeof speakingCharacterSchema>;

export const speakingFormatInfoSchema = z.object({
  id: z.string(),
  layout: z.enum(["full", "hook-demo", "corner-over-demo"]),
  portraitHint: z.string().nullable(),
  demoHint: z.string().nullable(),
  preferredDurationSeconds: z.number().int().positive(),
});
export type SpeakingFormatInfo = z.infer<typeof speakingFormatInfoSchema>;

export const speakingOptionsSchema = z.object({
  speech: taskOptions(speechModelSpecSchema),
  avatar: taskOptions(avatarModelSpecSchema),
  swap: taskOptions(swapModelSpecSchema),
  /**
   * Los modelos de la biblioteca (`GET /character-models`). `null` = la
   * biblioteca no respondió (la pantalla ofrece el Media Bank).
   */
  characters: z.array(speakingCharacterSchema).nullable(),
  formats: z.array(speakingFormatInfoSchema),
  durations: z.array(z.number().int().positive()),
  /** `AI-010`: 5 s → 10-15 palabras. */
  wordsPerSecond: z.object({ min: z.number(), max: z.number() }),
  swapMaxSourceSeconds: z.number().positive(),
  /** El modelo de texto está configurado (para «Generate script»). */
  scriptWriter: z.boolean(),
  budget: budgetSummarySchema,
});
export type SpeakingOptions = z.infer<typeof speakingOptionsSchema>;

export const speakingScriptRequestSchema = z
  .object({
    topic: z.string().max(SPEAKING_TOPIC_MAX_CHARS).optional(),
    durationSeconds: z.number().int().positive().max(60),
    /** ISO 639-1. Default `en`. */
    languageCode: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
    /** Default `true`: el perfil de la marca informa el guion. */
    includeBrand: z.boolean().optional(),
  })
  .strict();
export type SpeakingScriptRequest = z.input<typeof speakingScriptRequestSchema>;

export const scriptGuidanceSchema = z.object({
  words: z.number().int().nonnegative(),
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
  level: z.enum(["ok", "short", "long"]),
  /** En inglés. `AI-010`: «0 words may be too short for 5s - Target 10-15 words». */
  message: z.string().nullable(),
});
export type ScriptGuidance = z.infer<typeof scriptGuidanceSchema>;

export const speakingScriptSchema = z.object({
  script: z.string(),
  guidance: scriptGuidanceSchema,
});
export type SpeakingScript = z.infer<typeof speakingScriptSchema>;

const idLike = z.string().trim().min(1).max(128);

export const speakingRunRequestSchema = z
  .object({
    script: z.string().max(SPEAKING_SCRIPT_MAX_CHARS),
    durationSeconds: z.number().int().positive().max(60),
    languageCode: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
    /** `null` = sin caption; ausente = la primera frase del guion. */
    caption: z.string().max(SPEAKING_CAPTION_MAX_CHARS).nullable().optional(),
    characterModelId: idLike.optional(),
    portraitMediaId: z.string().uuid().optional(),
    /** Una voz del modelo de voz. Gana a la del modelo de la biblioteca. */
    voiceId: z.string().trim().min(1).max(64).optional(),
    /** El video que acompaña al avatar (formatos con demo). */
    demoMediaId: z.string().uuid().optional(),
    resolution: z.string().max(16).optional(),
  })
  .strict();
export type SpeakingRunRequest = z.input<typeof speakingRunRequestSchema>;

export const swapRunRequestSchema = z
  .object({
    /** El video del Media Bank al que se le cambia el personaje. */
    sourceMediaId: z.string().uuid(),
    characterModelId: idLike.optional(),
    portraitMediaId: z.string().uuid().optional(),
    caption: z.string().max(SPEAKING_CAPTION_MAX_CHARS).nullable().optional(),
    resolution: z.string().max(16).optional(),
  })
  .strict();
export type SwapRunRequest = z.input<typeof swapRunRequestSchema>;

const estimatePartSchema = z.object({ model: z.string(), estimate: costEstimateSchema });

export const voiceRunEstimateSchema = z.object({
  provider: modelProviderSchema,
  speechModel: z.string().nullable(),
  videoModel: z.string(),
  resolution: z.string(),
  voice: estimatePartSchema.nullable(),
  video: estimatePartSchema,
  usd: z.number().nonnegative(),
  /** Los segundos con que se estimó el video (voz: el extremo lento). */
  videoSeconds: z.number().positive(),
  guidance: scriptGuidanceSchema.nullable(),
  budget: budgetSummarySchema,
  fits: z.boolean(),
});
export type VoiceRunEstimate = z.infer<typeof voiceRunEstimateSchema>;

export const speakingRunStageSchema = z.enum([
  "queued",
  "voice",
  "video",
  "building",
  "ready",
  "failed",
  "nsfw",
]);
export type SpeakingRunStage = z.infer<typeof speakingRunStageSchema>;

export const speakingRunErrorCodeSchema = z.enum([
  "nsfw_rejected",
  "generation_failed",
  "provider_unavailable",
  "quota_exceeded",
  "rate_limited",
  "unauthorized",
  "bad_request",
  "not_found",
  "timeout",
  "provider_contract_violation",
  "not_configured",
  "download_failed",
  "budget_exceeded",
  "voice_too_long",
  "input_missing",
  "content_failed",
  /** El render de la pieza falló. */
  "build_failed",
]);
export type SpeakingRunErrorCode = z.infer<typeof speakingRunErrorCodeSchema>;

export const speakingRunSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["speaking", "swap"]),
  formatId: z.string(),
  stage: speakingRunStageSchema,
  source: z.enum(["studio", "influencer"]),
  characterModelId: z.string().nullable(),
  script: z.string().nullable(),
  caption: z.string(),
  languageCode: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  voice: z.object({ model: z.string(), voiceId: z.string() }).nullable(),
  videoModel: z.string(),
  resolution: z.string(),
  estimate: z.object({
    voiceUsd: z.number(),
    videoUsd: z.number(),
    usd: z.number(),
    basis: z.string(),
  }),
  /** La voz en nuestro storage, para escucharla. */
  voiceUrl: z.string().nullable(),
  /** El video (avatar o swap) ya en el Media Bank. */
  video: generationMediaSchema.nullable(),
  /** La pieza que se abre en el editor. */
  contentId: z.string().uuid().nullable(),
  error: z.object({ code: speakingRunErrorCodeSchema, message: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SpeakingRun = z.infer<typeof speakingRunSchema>;
export const speakingRunListSchema = z.array(speakingRunSchema);

export const speakingRunListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /** Sólo las de un modelo de la biblioteca (pestaña Talking head, `P4-INFL-011`). */
    characterModelId: idLike.optional(),
  })
  .strict();
export type SpeakingRunListQuery = z.infer<typeof speakingRunListQuerySchema>;
