/**
 * Estimar y arrancar un formato con voz o un character swap — sprint 8
 * (agente L), `P4-FORMAT-002`, `P4-INFL-011`.
 *
 * Mismo orden que `start.ts` (el de `POST /ai-studio/generations`):
 *
 * 1. Validar el pedido (formato, guion, voz, duración, demo) → `invalid`.
 * 2. Modelos configurados en Settings → Models (`speech` + `avatar`, o
 *    `swap`) → `not_configured`.
 * 3. **Estimar** con los estimadores del adaptador (precio de lista).
 * 4. Reservar en el libro **bajo lock** las dos entradas (`<id>:voice`,
 *    `<id>:video`) o ninguna → `budget_exceeded`.
 * 5. Escribir la corrida y encolar. Si falla, se libera la reserva y se
 *    relanza.
 *
 * `core` no importa adaptadores: todo lo de afuera entra por dependencias
 * estructurales, ya resuelto por quien llama (la API).
 */
import type {
  CharacterSwapModelSpec,
  CharacterSwapRequest,
  GenCostEstimate,
  SpeechModelSpec,
  SpeechRequest,
  TalkingAvatarModelSpec,
  TalkingAvatarRequest,
} from "@fastgram/ports";

import {
  monthKey,
  parseSpendLedger,
  releaseSpend,
  reserveSpend,
  type BudgetSummary,
  type SpendLedger,
} from "../../genai/budget.js";
import type { SecretEnv } from "../../models/config.js";
import { findGenerativeFormat, type SpeakingGenerativeFormat } from "./catalog.js";
import {
  SPEAKING_DURATIONS,
  captionFromScript,
  checkSpeakingScript,
  estimatedSpeechSeconds,
  scriptGuidance,
  SPEAKING_CAPTION_MAX_CHARS,
  type ScriptGuidance,
} from "./speaking.js";
import {
  speakingSpendIds,
  type SpeakingInputMedia,
  type SpeakingRunJob,
  type SpeakingRunRecord,
  type SpeakingRunSource,
} from "./speaking-run.js";

/**
 * Tope del video de origen de un character swap, en segundos. **Decisión
 * nuestra**: la página de Wan Animate no publica un máximo, y el costo crece
 * con cada cuadro (5 s a 60 fps en 720p ya son US$1,50).
 */
export const SWAP_MAX_SOURCE_SECONDS = 30;

interface UpdatableDoc {
  update<T>(fn: (current: unknown) => { next?: unknown; result: T }): Promise<T>;
}
interface Collection {
  create(scope: string, id: string, value: unknown): Promise<void>;
  update<T>(
    scope: string,
    id: string,
    fn: (current: unknown) => { next?: unknown; result: T },
  ): Promise<T>;
}

/** Un modelo de Settings → Models ya resuelto: proveedor, default y catálogo. */
export interface VoiceTaskOptions<Spec> {
  readonly provider: string;
  readonly defaultModel: string;
  readonly models: readonly Spec[];
}

interface CommonDeps {
  readonly now: () => Date;
  readonly newId: () => string;
  readonly env: SecretEnv;
  readonly ledger: UpdatableDoc;
  /** `~/.fastgram/speaking-runs/`. */
  readonly runs: Collection;
  /** `ai-studio-generation` con `speakingRunId`. */
  readonly enqueue: (job: SpeakingRunJob) => Promise<void>;
}

export interface SpeakingRunDeps extends CommonDeps {
  /** `null` = la tarea no está configurada. */
  readonly speechTask: () => Promise<VoiceTaskOptions<SpeechModelSpec> | null>;
  readonly avatarTask: () => Promise<VoiceTaskOptions<TalkingAvatarModelSpec> | null>;
  /** Lanzan `PortError` (quien llama traduce). */
  readonly estimateSpeech: (r: SpeechRequest) => Promise<GenCostEstimate>;
  readonly estimateAvatar: (r: TalkingAvatarRequest) => Promise<GenCostEstimate>;
}

export interface SwapRunDeps extends CommonDeps {
  readonly swapTask: () => Promise<VoiceTaskOptions<CharacterSwapModelSpec> | null>;
  readonly estimateSwap: (r: CharacterSwapRequest) => Promise<GenCostEstimate>;
}

export interface SpeakingRunInput {
  readonly companyId: string;
  readonly formatId: string;
  readonly script: string;
  readonly durationSeconds: number;
  /** `null` = sin caption; ausente = la primera frase del guion. */
  readonly caption?: string | null | undefined;
  readonly languageCode?: string | undefined;
  /** La voz: la del modelo de la biblioteca o la elegida en la pantalla. */
  readonly voice: { readonly model: string; readonly voiceId: string };
  readonly portrait: SpeakingInputMedia;
  readonly characterModelId?: string | null | undefined;
  readonly demo?: SpeakingInputMedia | null | undefined;
  /** Default: la primera del modelo (720p en OmniHuman). */
  readonly resolution?: string | undefined;
  readonly source: SpeakingRunSource;
}

export interface SwapRunInput {
  readonly companyId: string;
  readonly portrait: SpeakingInputMedia;
  readonly characterModelId?: string | null | undefined;
  readonly sourceVideo: SpeakingInputMedia & { readonly durationSeconds: number | null };
  readonly caption?: string | null | undefined;
  /** Default: la primera del modelo (480p, la más barata). */
  readonly resolution?: string | undefined;
  readonly source: SpeakingRunSource;
}

export type VoiceRunRejection =
  | {
      readonly ok: false;
      readonly reason: "invalid";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: "not_configured";
      readonly task: "speech" | "avatar" | "swap";
      readonly message: string;
    }
  | { readonly ok: false; readonly reason: "ledger_unreadable"; readonly message: string }
  | {
      readonly ok: false;
      readonly reason: "budget_exceeded";
      readonly estimateUsd: number;
      readonly summary: BudgetSummary;
    };

const invalid = (field: string, message: string): VoiceRunRejection => ({
  ok: false,
  reason: "invalid",
  field,
  message,
});

const notConfigured = (task: "speech" | "avatar" | "swap"): VoiceRunRejection => ({
  ok: false,
  reason: "not_configured",
  task,
  message:
    task === "speech"
      ? "Set up a fal voice model in Settings → Models first."
      : task === "avatar"
        ? "Set up a fal talking-avatar model in Settings → Models first."
        : "Set up a fal character-swap model in Settings → Models first.",
});

export interface VoiceRunEstimate {
  readonly ok: true;
  readonly provider: string;
  readonly speechModel: string | null;
  readonly videoModel: string;
  readonly resolution: string;
  readonly voice: VoiceEstimatePart | null;
  readonly video: VoiceEstimatePart;
  readonly usd: number;
  /** Sólo con voz: la guía de `AI-010`. */
  readonly guidance: ScriptGuidance | null;
  /** Los segundos con que se estimó el video. */
  readonly videoSeconds: number;
}

export interface VoiceEstimatePart {
  readonly model: string;
  readonly estimate: GenCostEstimate;
}

interface PreparedSpeaking {
  readonly format: SpeakingGenerativeFormat;
  readonly speechProvider: string;
  readonly speechSpec: SpeechModelSpec;
  readonly avatarSpec: TalkingAvatarModelSpec;
  readonly resolution: string;
  readonly script: string;
  readonly caption: string;
  readonly speechRequest: SpeechRequest;
  readonly avatarRequest: TalkingAvatarRequest;
  readonly guidance: ScriptGuidance;
}

function cleanCaption(raw: string | null | undefined, script: string | null): string {
  if (raw === null) return "";
  if (raw === undefined) return script === null ? "" : captionFromScript(script);
  return raw.replace(/\s+/g, " ").trim().slice(0, SPEAKING_CAPTION_MAX_CHARS);
}

async function prepareSpeaking(
  deps: SpeakingRunDeps,
  input: SpeakingRunInput,
): Promise<PreparedSpeaking | VoiceRunRejection> {
  const format = findGenerativeFormat(input.formatId);
  if (format === undefined) return invalid("formatId", "That format doesn't exist.");
  if (format.status !== "speaking") {
    return invalid("formatId", "That format isn't made with a voice.");
  }
  const speech = await deps.speechTask();
  if (speech === null) return notConfigured("speech");
  const avatar = await deps.avatarTask();
  if (avatar === null) return notConfigured("avatar");

  const speechSpec = speech.models.find((m) => m.id === input.voice.model);
  if (speechSpec === undefined) {
    return invalid(
      "voice",
      "That voice uses a model FastGram can't call. Pick a voice from the list.",
    );
  }
  // Las voces del catálogo son ejemplos documentados, no una lista cerrada
  // (ninguno de los modelos tiene un endpoint que las liste).
  if (!/^[A-Za-z0-9][A-Za-z0-9_ -]{0,63}$/.test(input.voice.voiceId)) {
    return invalid("voice", "That doesn't look like a voice id.");
  }
  const avatarSpec =
    avatar.models.find((m) => m.id === avatar.defaultModel) ?? avatar.models[0];
  if (avatarSpec === undefined) return notConfigured("avatar");
  const resolution = input.resolution ?? avatarSpec.resolutions[0]?.id;
  const res = avatarSpec.resolutions.find((r) => r.id === resolution);
  if (res === undefined) {
    return invalid(
      "resolution",
      `Pick a resolution: ${avatarSpec.resolutions.map((r) => r.id).join(", ")}.`,
    );
  }
  if (
    !(SPEAKING_DURATIONS as readonly number[]).includes(input.durationSeconds) ||
    input.durationSeconds > res.maxAudioSeconds
  ) {
    return invalid(
      "durationSeconds",
      `Pick a duration up to ${String(res.maxAudioSeconds)} seconds at ${res.id}.`,
    );
  }
  const checked = checkSpeakingScript(input.script, {
    maxChars: speechSpec.maxChars,
    maxAudioSeconds: res.maxAudioSeconds,
  });
  if (!checked.ok) return invalid("script", checked.message);
  if (format.layout !== "full" && (input.demo === null || input.demo === undefined)) {
    return invalid(
      "demoMediaId",
      format.demoHint ?? "Pick the video that plays with the speaker.",
    );
  }
  const languageCode = input.languageCode?.trim().toLowerCase();
  if (languageCode !== undefined && !/^[a-z]{2}$/.test(languageCode)) {
    return invalid("languageCode", "Use a two-letter language code (ISO 639-1).");
  }
  const seconds = estimatedSpeechSeconds(checked.words, res.maxAudioSeconds);
  const speechRequest: SpeechRequest = {
    model: speechSpec.id,
    text: checked.script,
    voice: input.voice.voiceId,
    ...(languageCode === undefined ? {} : { languageCode }),
  };
  const avatarRequest: TalkingAvatarRequest = {
    model: avatarSpec.id,
    // Para estimar alcanzan el modelo, la resolución y los segundos: las URLs
    // las pone el worker con la voz ya generada.
    imageUrl: "",
    audioUrl: "",
    resolution: res.id,
    audioSeconds: seconds,
    prompt: format.avatarPrompt,
  };
  return {
    format,
    speechProvider: speech.provider,
    speechSpec,
    avatarSpec,
    resolution: res.id,
    script: checked.script,
    caption: cleanCaption(input.caption, checked.script),
    speechRequest,
    avatarRequest,
    guidance: scriptGuidance(checked.script, input.durationSeconds),
  };
}

export async function estimateSpeakingRun(
  deps: SpeakingRunDeps,
  input: SpeakingRunInput,
): Promise<VoiceRunEstimate | VoiceRunRejection> {
  const p = await prepareSpeaking(deps, input);
  if (!("format" in p)) return p;
  const voice = await deps.estimateSpeech(p.speechRequest);
  const video = await deps.estimateAvatar(p.avatarRequest);
  return {
    ok: true,
    provider: p.speechProvider,
    speechModel: p.speechSpec.id,
    videoModel: p.avatarSpec.id,
    resolution: p.resolution,
    voice: { model: p.speechSpec.id, estimate: voice },
    video: { model: p.avatarSpec.id, estimate: video },
    usd: roundUsd(voice.usd + video.usd),
    guidance: p.guidance,
    videoSeconds: p.avatarRequest.audioSeconds,
  };
}

interface PreparedSwap {
  readonly provider: string;
  readonly spec: CharacterSwapModelSpec;
  readonly resolution: string;
  readonly durationSeconds: number;
  readonly caption: string;
  readonly request: CharacterSwapRequest;
}

async function prepareSwap(
  deps: SwapRunDeps,
  input: SwapRunInput,
): Promise<PreparedSwap | VoiceRunRejection> {
  const swap = await deps.swapTask();
  if (swap === null) return notConfigured("swap");
  const spec = swap.models.find((m) => m.id === swap.defaultModel) ?? swap.models[0];
  if (spec === undefined) return notConfigured("swap");
  const resolution = input.resolution ?? spec.resolutions[0];
  if (resolution === undefined || !spec.resolutions.includes(resolution)) {
    return invalid("resolution", `Pick a resolution: ${spec.resolutions.join(", ")}.`);
  }
  const d = input.sourceVideo.durationSeconds;
  if (d === null || !Number.isFinite(d) || d <= 0) {
    return invalid(
      "sourceMediaId",
      "We don't know how long that video is, so we can't price it. Pick another one.",
    );
  }
  if (d > SWAP_MAX_SOURCE_SECONDS) {
    return invalid(
      "sourceMediaId",
      `Pick a video of ${String(SWAP_MAX_SOURCE_SECONDS)} seconds or less.`,
    );
  }
  return {
    provider: swap.provider,
    spec,
    resolution,
    durationSeconds: d,
    caption: cleanCaption(input.caption === undefined ? null : input.caption, null),
    request: {
      model: spec.id,
      imageUrl: input.portrait.url,
      videoUrl: input.sourceVideo.url,
      resolution,
      videoSeconds: d,
    },
  };
}

export async function estimateSwapRun(
  deps: SwapRunDeps,
  input: SwapRunInput,
): Promise<VoiceRunEstimate | VoiceRunRejection> {
  const p = await prepareSwap(deps, input);
  if (!("spec" in p)) return p;
  const video = await deps.estimateSwap(p.request);
  return {
    ok: true,
    provider: p.provider,
    speechModel: null,
    videoModel: p.spec.id,
    resolution: p.resolution,
    voice: null,
    video: { model: p.spec.id, estimate: video },
    usd: roundUsd(video.usd),
    guidance: null,
    videoSeconds: p.durationSeconds,
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/* ------------------------------------------------------------------------ *
 * Reservar, escribir, encolar
 * ------------------------------------------------------------------------ */

export interface StartedVoiceRun {
  readonly ok: true;
  readonly run: SpeakingRunRecord;
}

interface Part {
  readonly key: string;
  readonly usd: number;
  readonly model: string;
}

async function reserveParts(
  deps: CommonDeps,
  companyId: string,
  provider: string,
  month: string,
  at: Date,
  parts: readonly Part[],
): Promise<null | { ok: true } | { ok: false; summary: BudgetSummary }> {
  return deps.ledger.update<null | { ok: true } | { ok: false; summary: BudgetSummary }>(
    (raw) => {
      let ledger: SpendLedger | null = parseSpendLedger(raw);
      if (ledger === null) return { result: null };
      // Todas o ninguna: si la segunda no entra, no se escribe nada.
      for (const part of parts) {
        const r = reserveSpend(
          ledger,
          {
            month,
            generationId: part.key,
            usd: part.usd,
            provider,
            model: part.model,
            kind: "video",
            companyId,
            at: at.toISOString(),
          },
          deps.env,
        );
        if (!r.ok) return { result: { ok: false, summary: r.summary } };
        ledger = r.next;
      }
      return { next: ledger, result: { ok: true } };
    },
  );
}

async function releaseParts(
  deps: CommonDeps,
  month: string,
  keys: readonly string[],
): Promise<void> {
  await deps.ledger
    .update((raw) => {
      let ledger = parseSpendLedger(raw);
      if (ledger === null) return { result: null };
      for (const key of keys) ledger = releaseSpend(ledger, month, key) ?? ledger;
      return { next: ledger, result: null };
    })
    .catch(() => undefined);
}

async function writeAndEnqueue(
  deps: CommonDeps,
  run: SpeakingRunRecord,
  keys: readonly string[],
): Promise<StartedVoiceRun> {
  try {
    await deps.runs.create(run.companyId, run.id, run);
    await deps.enqueue({ companyId: run.companyId, speakingRunId: run.id });
  } catch (error) {
    await releaseParts(deps, run.spendMonth, keys);
    // Una corrida escrita y sin job no la procesa nadie: se cierra.
    await deps.runs
      .update(run.companyId, run.id, (raw) =>
        raw === null
          ? { result: null }
          : {
              next: {
                ...run,
                stage: "failed",
                error: {
                  code: "provider_unavailable",
                  message: "The job could not be queued.",
                },
                updatedAt: deps.now().toISOString(),
              },
              result: null,
            },
      )
      .catch(() => undefined);
    throw error;
  }
  return { ok: true, run };
}

const budgetRejection = (usd: number, summary: BudgetSummary): VoiceRunRejection => ({
  ok: false,
  reason: "budget_exceeded",
  estimateUsd: usd,
  summary,
});

const ledgerUnreadable: VoiceRunRejection = {
  ok: false,
  reason: "ledger_unreadable",
  message: "The local spend file (~/.fastgram/spend.json) cannot be read.",
};

export async function startSpeakingRun(
  deps: SpeakingRunDeps,
  input: SpeakingRunInput,
): Promise<StartedVoiceRun | VoiceRunRejection> {
  const p = await prepareSpeaking(deps, input);
  if (!("format" in p)) return p;
  const voiceCost = await deps.estimateSpeech(p.speechRequest);
  const videoCost = await deps.estimateAvatar(p.avatarRequest);
  const at = deps.now();
  const month = monthKey(at);
  const id = deps.newId();
  const keys = speakingSpendIds(id);
  const total = roundUsd(voiceCost.usd + videoCost.usd);
  const reserved = await reserveParts(
    deps,
    input.companyId,
    p.speechProvider,
    month,
    at,
    [
      { key: keys.voice, usd: voiceCost.usd, model: p.speechSpec.id },
      { key: keys.video, usd: videoCost.usd, model: p.avatarSpec.id },
    ],
  );
  if (reserved === null) return ledgerUnreadable;
  if (!reserved.ok) return budgetRejection(total, reserved.summary);

  const now = at.toISOString();
  const run: SpeakingRunRecord = {
    version: 1,
    id,
    companyId: input.companyId,
    kind: "speaking",
    formatId: p.format.id,
    source: input.source,
    characterModelId: input.characterModelId ?? null,
    script: p.script,
    caption: p.caption,
    languageCode: p.speechRequest.languageCode ?? null,
    durationSeconds: input.durationSeconds,
    voice: { model: p.speechSpec.id, voiceId: input.voice.voiceId },
    portrait: input.portrait,
    demo: input.demo ?? null,
    sourceVideo: null,
    videoModel: p.avatarSpec.id,
    resolution: p.resolution,
    avatarPrompt: p.format.avatarPrompt,
    provider: p.speechProvider,
    spendMonth: month,
    estimate: {
      voiceUsd: voiceCost.usd,
      videoUsd: videoCost.usd,
      usd: total,
      basis: `${voiceCost.basis} + ${videoCost.basis}`,
    },
    stage: "queued",
    voiceStep: { request: null, storageKey: null, url: null, seconds: null },
    videoStep: { request: null, mediaId: null, billedSeconds: null },
    contentId: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  return writeAndEnqueue(deps, run, [keys.voice, keys.video]);
}

export async function startSwapRun(
  deps: SwapRunDeps,
  input: SwapRunInput,
): Promise<StartedVoiceRun | VoiceRunRejection> {
  const p = await prepareSwap(deps, input);
  if (!("spec" in p)) return p;
  const cost = await deps.estimateSwap(p.request);
  const at = deps.now();
  const month = monthKey(at);
  const id = deps.newId();
  const keys = speakingSpendIds(id);
  const reserved = await reserveParts(deps, input.companyId, p.provider, month, at, [
    { key: keys.video, usd: cost.usd, model: p.spec.id },
  ]);
  if (reserved === null) return ledgerUnreadable;
  if (!reserved.ok) return budgetRejection(cost.usd, reserved.summary);
  const now = at.toISOString();
  const run: SpeakingRunRecord = {
    version: 1,
    id,
    companyId: input.companyId,
    kind: "swap",
    formatId: "character-swap",
    source: input.source,
    characterModelId: input.characterModelId ?? null,
    script: null,
    caption: p.caption,
    languageCode: null,
    durationSeconds: p.durationSeconds,
    voice: null,
    portrait: input.portrait,
    demo: null,
    sourceVideo: { ...input.sourceVideo, durationSeconds: p.durationSeconds },
    videoModel: p.spec.id,
    resolution: p.resolution,
    avatarPrompt: null,
    provider: p.provider,
    spendMonth: month,
    estimate: { voiceUsd: 0, videoUsd: cost.usd, usd: cost.usd, basis: cost.basis },
    stage: "queued",
    voiceStep: { request: null, storageKey: null, url: null, seconds: null },
    videoStep: { request: null, mediaId: null, billedSeconds: null },
    contentId: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  return writeAndEnqueue(deps, run, [keys.video]);
}
