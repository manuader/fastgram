/**
 * El worker de los formatos con voz y del character swap — sprint 8
 * (agente L), `P4-FORMAT-002`, `P4-INFL-011`.
 *
 * Llega por la cola `ai-studio-generation` con `{companyId, speakingRunId}`
 * (el montaje despacha por payload: trampa 63). La corrida está en
 * `~/.fastgram/speaking-runs/<marca>/<id>.json` (`core`, `speaking-run.ts`).
 *
 * ```
 *   con voz:  voz (TTS) ─► storage ─► avatar (retrato + voz) ─► Media Bank ─► pieza
 *   swap:                             swap (retrato + video)  ─► Media Bank ─► pieza
 * ```
 *
 * ## Nunca se reenvía un pedido aceptado
 *
 * Igual que `../genai/handler.ts`: el `request_id` y la URL de estado de cada
 * pedido se escriben **antes** de hacer polling, y una reentrega retoma. Un
 * rechazo seguro (4xx con respuesta) libera la reserva de ese paso; un fallo
 * ambiguo (timeout, red, 5xx) la deja cobrada.
 *
 * ## Las entradas van como data URI
 *
 * Nuestro storage local no es público y fal documenta que acepta data URIs.
 * El retrato, la voz y el video de origen se leen de storage y se mandan en
 * el cuerpo, con topes para no llenar la memoria.
 *
 * ## La duración real de la voz
 *
 * Con la voz en mano se mide (ffprobe, si está; si no, lo que diga el
 * proveedor). Si pasa el tope del modelo de video, la corrida termina
 * `voice_too_long` con la voz cobrada y el video liberado: mandarla igual es
 * pagar un rechazo. Si el avatar va a costar más de lo reservado, se amplía
 * la reserva **antes** de enviarlo (y si no entra en el tope, no se envía).
 */
import { canonicalObjectUrl, type FalVoiceClient } from "@fastgram/adapters";
import { BYTES_PER_MB, contentBuildPayloadSchema } from "@fastgram/contracts";
import {
  CONTENT_BUILD_QUEUE,
  budgetSummary,
  fitsBudget,
  findSpeakingFormat,
  generationErrorFromPort,
  isTerminalSpeakingStage,
  mediaCategoriesFor,
  parseSpeakingRunRecord,
  parseSpendLedger,
  pollDelayMs,
  releaseSpend,
  resolveVoiceConfig,
  settleSpend,
  speakingBuildPayload,
  speakingSpendIds,
  swapBuildPayload,
  type ContentBuildJob,
  type ProviderRequestRef,
  type ResolvedVoiceConfig,
  type SecretEnv,
  type SpeakingInputMedia,
  type SpeakingRunErrorCode,
  type SpeakingRunJob,
  type SpeakingRunRecord,
  type SpendLedger,
} from "@fastgram/core";
import {
  brandKitStore,
  contentRepository,
  mediaRepository,
  withCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";
import {
  isPortError,
  PortError,
  type GenJobHandle,
  type GenSubmission,
  type JobContext,
  type ModelRegistry,
  type Queue,
  type Storage,
  type VoiceJobState,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { Semaphore } from "../genai/semaphore.js";

/** Lo que hace falta de `JsonFileCollection` / `JsonFileDocument`. */
export interface SpeakingRunStore {
  get(scope: string, id: string): Promise<unknown>;
  update<T>(
    scope: string,
    id: string,
    fn: (current: unknown) => { next?: unknown; result: T },
  ): Promise<T>;
}
export interface SpeakingLedgerStore {
  update<T>(fn: (current: unknown) => { next?: unknown; result: T }): Promise<T>;
}

/** El cliente de fal de los tres puertos de voz. */
export type VoiceClient = Pick<
  FalVoiceClient,
  | "provider"
  | "speechModels"
  | "avatarModels"
  | "swapModels"
  | "estimateAvatar"
  | "generateSpeech"
  | "generateAvatar"
  | "generateSwap"
  | "pollVoice"
>;

export interface SpeakingHandlerDeps {
  readonly db: Database;
  readonly storage: Storage;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly queue: Queue;
  readonly registry: ModelRegistry;
  readonly secrets: SecretEnv;
  readonly runs: SpeakingRunStore;
  readonly ledger: SpeakingLedgerStore;
  readonly clientFor: (config: ResolvedVoiceConfig) => VoiceClient;
  readonly semaphoreFor: (provider: string) => Semaphore;
  /** Baja una salida del proveedor (https, con tope). */
  readonly download: (url: string) => Promise<{ body: Uint8Array; contentType: string }>;
  /** La duración de un audio, o `null` si no se puede medir (sin ffprobe). */
  readonly probeSeconds?: (body: Uint8Array, ext: string) => Promise<number | null>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly pollBudgetMs?: number;
  readonly submitRateLimitRetries?: number;
}

/** 25 min: por debajo de los 30 de `expireInSeconds` con que encola la API. */
const DEFAULT_POLL_BUDGET_MS = 25 * 60_000;
const DEFAULT_SUBMIT_RETRIES = 6;
const MAX_POLL_ERRORS = 8;
/** Topes de lo que se manda como data URI. Decisión nuestra, no de fal. */
const MAX_PORTRAIT_BYTES = 15 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_VIDEO_BYTES = 60 * 1024 * 1024;

const DEFINITE_REJECTIONS = new Set([
  "bad_request",
  "unauthorized",
  "forbidden",
  "quota_exceeded",
  "not_found",
  "conflict",
]);

const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};
const VIDEO_EXTENSIONS: Readonly<Record<string, string>> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

class RetryLater extends Error {
  override readonly name = "RetryLater";
}

/** Una corrida que termina acá, con su código. */
class Stop extends Error {
  override readonly name = "Stop";
  constructor(
    readonly code: SpeakingRunErrorCode,
    message: string,
    readonly stage: "failed" | "nsfw" = "failed",
  ) {
    super(message);
  }
}

function portFailure(error: unknown): Stop {
  if (isPortError(error)) {
    const code = generationErrorFromPort(error.code);
    return new Stop(
      code === "budget_exceeded" ? "budget_exceeded" : (code as SpeakingRunErrorCode),
      error.message,
    );
  }
  return new Stop("provider_unavailable", "The generation provider failed.");
}

function contentTypeOf(raw: string | undefined): string {
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function toDataUri(body: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(body).toString("base64")}`;
}

export function createSpeakingRunHandler(
  deps: SpeakingHandlerDeps,
): (ctx: JobContext<unknown>, job: SpeakingRunJob) => Promise<void> {
  const now = deps.now ?? (() => new Date());
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const random = deps.random ?? Math.random;
  const pollBudgetMs = deps.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;
  const submitRetries = deps.submitRateLimitRetries ?? DEFAULT_SUBMIT_RETRIES;
  const log = deps.logger;

  const inCompany = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>) =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  async function save(
    run: SpeakingRunRecord,
    change: (current: SpeakingRunRecord) => SpeakingRunRecord,
  ): Promise<SpeakingRunRecord> {
    return deps.runs.update(run.companyId, run.id, (raw) => {
      const current = parseSpeakingRunRecord(raw) ?? run;
      const next = { ...change(current), updatedAt: now().toISOString() };
      return { next, result: next };
    });
  }

  /** Cobra o libera una entrada del libro. Un libro ilegible no tumba el job. */
  async function spend(
    run: SpeakingRunRecord,
    key: string,
    how: "settle" | "release",
  ): Promise<void> {
    try {
      await deps.ledger.update((raw) => {
        const ledger = parseSpendLedger(raw);
        if (ledger === null) return { result: null };
        const next =
          how === "settle"
            ? settleSpend(ledger, run.spendMonth, key)
            : releaseSpend(ledger, run.spendMonth, key);
        return next === null ? { result: null } : { next, result: null };
      });
    } catch (error) {
      log.error(
        { runId: run.id, key, how, code: isPortError(error) ? error.code : "internal" },
        "no se pudo actualizar el gasto",
      );
    }
  }

  /**
   * Cambia el monto de una entrada **reservada**. `force` = el proveedor ya lo
   * cobró (se anota aunque pase el tope); sin `force`, crecer por encima del
   * tope devuelve `false` y no escribe.
   */
  async function resize(
    run: SpeakingRunRecord,
    key: string,
    usd: number,
    force: boolean,
  ): Promise<boolean> {
    return deps.ledger.update<boolean>((raw) => {
      const ledger: SpendLedger | null = parseSpendLedger(raw);
      if (ledger === null) return { result: true };
      const month = ledger.months[run.spendMonth];
      const entry = month?.[key];
      if (month === undefined || entry === undefined || entry.state !== "reserved") {
        return { result: true };
      }
      if (usd <= entry.usd && !force) return { result: true };
      if (!force) {
        // Lo que queda del mes **sin** esta entrada tiene que cubrir el monto nuevo.
        const summary = budgetSummary(ledger, run.spendMonth, deps.secrets);
        if (
          !fitsBudget({ ...summary, reservedUsd: summary.reservedUsd - entry.usd }, usd)
        ) {
          return { result: false };
        }
      }
      return {
        next: {
          ...ledger,
          months: {
            ...ledger.months,
            [run.spendMonth]: { ...month, [key]: { ...entry, usd } },
          },
        },
        result: true,
      };
    });
  }

  async function close(
    run: SpeakingRunRecord,
    stop: Stop,
    spends: { voice?: "settle" | "release"; video?: "settle" | "release" },
  ): Promise<void> {
    const keys = speakingSpendIds(run.id);
    await save(run, (cur) => ({
      ...cur,
      stage: stop.stage,
      error: { code: stop.code, message: stop.message },
    }));
    if (spends.voice !== undefined) await spend(run, keys.voice, spends.voice);
    if (spends.video !== undefined) await spend(run, keys.video, spends.video);
    log.info(
      { runId: run.id, companyId: run.companyId, code: stop.code },
      "formato con voz cerrado sin pieza",
    );
  }

  async function submit(
    run: SpeakingRunRecord,
    send: () => Promise<GenSubmission>,
  ): Promise<GenSubmission> {
    let attempt = 0;
    for (;;) {
      try {
        return await send();
      } catch (error) {
        if (
          isPortError(error) &&
          error.code === "rate_limited" &&
          attempt < submitRetries
        ) {
          const wait =
            (error.retryAfterSeconds ?? 0) * 1000 || pollDelayMs(attempt + 1, random());
          attempt += 1;
          log.warn({ runId: run.id, attempt, wait }, "tope de concurrencia de fal");
          await sleep(wait);
          continue;
        }
        throw error;
      }
    }
  }

  async function pollUntilTerminal(
    client: VoiceClient,
    handle: GenJobHandle,
  ): Promise<VoiceJobState> {
    const deadline = now().getTime() + pollBudgetMs;
    let attempt = 0;
    let errors = 0;
    for (;;) {
      await sleep(pollDelayMs(attempt, random()));
      attempt += 1;
      let state: VoiceJobState;
      try {
        state = await client.pollVoice(handle);
        errors = 0;
      } catch (error) {
        const retryable = isPortError(error) ? error.isRetryable : true;
        if (!retryable) throw error;
        errors += 1;
        if (errors >= MAX_POLL_ERRORS) throw new RetryLater("too many polling errors");
        continue;
      }
      if (state.status === "queued" || state.status === "in_progress") {
        if (now().getTime() > deadline) throw new RetryLater("poll budget exhausted");
        continue;
      }
      return state;
    }
  }

  /** La clave de storage de una media nuestra: la guardada o la de su URL. */
  async function keyOf(media: SpeakingInputMedia): Promise<string> {
    if (media.storageKey !== null) return media.storageKey;
    const probe = await canonicalObjectUrl(deps.storage, "__fastgram_probe__");
    const base = probe.slice(0, probe.length - "__fastgram_probe__".length);
    if (!media.url.startsWith(base)) {
      throw new Stop("input_missing", "The portrait isn't in FastGram's storage.");
    }
    return decodeURIComponent(media.url.slice(base.length));
  }

  async function readStored(
    key: string,
    max: number,
    what: string,
  ): Promise<{ body: Uint8Array; contentType: string }> {
    const head = await deps.storage.head(key);
    if (head === null) throw new Stop("input_missing", `The ${what} is missing.`);
    if (head.sizeBytes > max) {
      throw new Stop("bad_request", `The ${what} is too large to send.`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of await deps.storage.get(key)) {
      size += chunk.byteLength;
      if (size > max) throw new Stop("bad_request", `The ${what} is too large to send.`);
      chunks.push(chunk);
    }
    const body = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.byteLength;
    }
    return { body, contentType: head.contentType };
  }

  /** Envía (si no se envió) y espera un paso. Devuelve la salida o cierra. */
  async function runStep(
    run: SpeakingRunRecord,
    client: VoiceClient,
    step: "voiceStep" | "videoStep",
    send: () => Promise<GenSubmission>,
    lastAttempt: boolean,
  ): Promise<{ run: SpeakingRunRecord; state: VoiceJobState }> {
    let current = run;
    let handle: GenJobHandle | null = null;
    const stored = current[step].request;
    if (stored !== null) {
      handle = {
        requestId: stored.requestId,
        statusUrl: stored.statusUrl,
        ...(stored.responseUrl === null ? {} : { responseUrl: stored.responseUrl }),
      };
    }
    if (handle === null) {
      let submission: GenSubmission;
      try {
        submission = await submit(current, send);
      } catch (error) {
        const stop = portFailure(error);
        const definite = isPortError(error) && DEFINITE_REJECTIONS.has(error.code);
        throw Object.assign(stop, { definite });
      }
      if (submission.kind === "rejected") {
        throw Object.assign(new Stop("nsfw_rejected", submission.message, "nsfw"), {
          definite: true,
        });
      }
      const h = submission.handle;
      handle = h;
      const ref: ProviderRequestRef = {
        requestId: h.requestId,
        statusUrl: h.statusUrl,
        responseUrl: h.responseUrl ?? null,
      };
      current = await save(current, (cur) => ({
        ...cur,
        [step]: { ...cur[step], request: ref },
      }));
      log.info(
        { runId: run.id, step, requestId: h.requestId },
        "formato con voz: pedido aceptado por fal",
      );
    }
    let state: VoiceJobState;
    try {
      state = await pollUntilTerminal(client, handle);
    } catch (error) {
      if (error instanceof RetryLater && !lastAttempt) throw error;
      const stop =
        error instanceof RetryLater
          ? new Stop("timeout", "fal did not finish in time.")
          : portFailure(error);
      // Aceptado y sin saber cómo terminó: puede haberse cobrado.
      throw Object.assign(stop, { definite: false });
    }
    if (state.status === "failed" || state.status === "canceled") {
      throw Object.assign(
        new Stop("generation_failed", state.message ?? "Generation failed"),
        { definite: true },
      );
    }
    if (state.status === "nsfw") {
      throw Object.assign(
        new Stop(
          "nsfw_rejected",
          state.message ?? "fal's content filter rejected it",
          "nsfw",
        ),
        { definite: true },
      );
    }
    if (state.output === undefined) {
      throw Object.assign(
        new Stop("provider_contract_violation", "No result from fal."),
        {
          definite: false,
        },
      );
    }
    return { run: current, state };
  }

  async function voiceStage(
    run: SpeakingRunRecord,
    client: VoiceClient,
    lastAttempt: boolean,
  ): Promise<SpeakingRunRecord> {
    if (run.voiceStep.url !== null) return run;
    const voice = run.voice;
    const script = run.script;
    if (voice === null || script === null) {
      throw Object.assign(new Stop("bad_request", "The run has no script."), {
        definite: true,
      });
    }
    let current = await save(run, (cur) => ({ ...cur, stage: "voice" }));
    const out = await runStep(
      current,
      client,
      "voiceStep",
      () =>
        client.generateSpeech({
          model: voice.model,
          text: script,
          voice: voice.voiceId,
          ...(run.languageCode === null ? {} : { languageCode: run.languageCode }),
        }),
      lastAttempt,
    );
    current = out.run;
    const output = out.state.output as { url: string; contentType?: string };
    let media: { body: Uint8Array; contentType: string };
    try {
      media = await deps.download(output.url);
    } catch {
      if (!lastAttempt) throw new RetryLater("voice download failed, retry");
      throw Object.assign(
        new Stop("download_failed", "The voice could not be copied to storage."),
        { definite: false },
      );
    }
    const contentType = contentTypeOf(media.contentType || output.contentType);
    const ext = AUDIO_EXTENSIONS[contentType];
    if (ext === undefined) {
      throw Object.assign(
        new Stop(
          "provider_contract_violation",
          "fal returned something that isn't audio.",
        ),
        { definite: false },
      );
    }
    const key = `media/${run.companyId}/speaking/${run.id}-voice.${ext}`;
    const stored = await deps.storage.put({ key, body: media.body, contentType });
    const url = await canonicalObjectUrl(deps.storage, stored.key);
    let seconds: number | null = null;
    if (deps.probeSeconds !== undefined) {
      seconds = await deps.probeSeconds(media.body, ext).catch(() => null);
    }
    seconds ??= out.state.mediaSeconds ?? null;
    await spend(current, speakingSpendIds(run.id).voice, "settle");
    current = await save(current, (cur) => ({
      ...cur,
      stage: "video",
      voiceStep: { ...cur.voiceStep, storageKey: stored.key, url, seconds },
    }));
    log.info({ runId: run.id, seconds }, "formato con voz: voz lista");
    return current;
  }

  async function storeVideo(
    run: SpeakingRunRecord,
    output: { url: string; contentType?: string },
  ): Promise<string> {
    const media = await deps.download(output.url);
    const contentType = contentTypeOf(media.contentType || output.contentType);
    const ext = VIDEO_EXTENSIONS[contentType];
    if (ext === undefined) {
      throw new PortError(
        "provider_contract_violation",
        "fal returned something that isn't a video",
        { source: "worker/speaking", cause: contentType },
      );
    }
    const key = `media/${run.companyId}/speaking/${run.id}-video.${ext}`;
    const stored = await deps.storage.put({ key, body: media.body, contentType });
    const row = {
      mediaType: "video" as const,
      filename: `${run.formatId}-${run.id.slice(0, 8)}.${ext}`,
      r2Url: await canonicalObjectUrl(deps.storage, stored.key),
      storageKey: stored.key,
      sizeMb: stored.sizeBytes / BYTES_PER_MB,
      videoDurationSec:
        run.voiceStep.seconds !== null
          ? Math.round(run.voiceStep.seconds)
          : run.durationSeconds === null
            ? null
            : Math.round(run.durationSeconds),
      categories: mediaCategoriesFor("video"),
    };
    return inCompany(run.companyId, async (tx) => {
      const scope = { companyId: run.companyId };
      await brandKitStore.lockCompanyBrandKit(tx, scope);
      await brandKitStore.insertBrandKitMedia(tx, scope, [row]);
      const page = await mediaRepository.list(tx, scope, {
        limit: 1,
        includeDeleted: true,
        filter: { storageKey: { in: [stored.key] } },
      });
      const id = page.items[0]?.mediaId;
      if (id === undefined) {
        throw new PortError(
          "provider_contract_violation",
          "the video row was not created",
          {
            source: "worker/speaking",
          },
        );
      }
      return id;
    });
  }

  async function videoStage(
    run: SpeakingRunRecord,
    client: VoiceClient,
    lastAttempt: boolean,
  ): Promise<SpeakingRunRecord> {
    if (run.videoStep.mediaId !== null) return run;
    const keys = speakingSpendIds(run.id);
    let current = await save(run, (cur) => ({ ...cur, stage: "video" }));

    let send: () => Promise<GenSubmission>;
    if (current.kind === "speaking") {
      const seconds = current.voiceStep.seconds;
      const spec = client.avatarModels().find((m) => m.id === current.videoModel);
      const res = spec?.resolutions.find((r) => r.id === current.resolution);
      if (spec === undefined || res === undefined) {
        throw Object.assign(
          new Stop("not_configured", "The talking-avatar model is no longer available."),
          { definite: true },
        );
      }
      if (seconds !== null && seconds > res.maxAudioSeconds) {
        throw Object.assign(
          new Stop(
            "voice_too_long",
            `The voice runs ${seconds.toFixed(1)} s and the video model takes up to ${String(res.maxAudioSeconds)} s at ${res.id}. Shorten the script.`,
          ),
          { definite: true },
        );
      }
      if (current.videoStep.request === null && seconds !== null) {
        // Con la duración real, la reserva del avatar se ajusta antes de enviar.
        const actual = await client.estimateAvatar({
          model: spec.id,
          imageUrl: "",
          audioUrl: "",
          resolution: res.id,
          audioSeconds: seconds,
        });
        if (!(await resize(current, keys.video, actual.usd, false))) {
          throw Object.assign(
            new Stop(
              "budget_exceeded",
              "The voice came out longer than estimated and the video no longer fits this month's AI budget.",
            ),
            { definite: true },
          );
        }
      }
      const audioSeconds = seconds ?? current.durationSeconds ?? res.maxAudioSeconds;
      send = async () => {
        const portrait = await readStored(
          await keyOf(current.portrait),
          MAX_PORTRAIT_BYTES,
          "portrait",
        );
        const voiceKey = current.voiceStep.storageKey;
        if (voiceKey === null) throw new Stop("input_missing", "The voice is missing.");
        const audio = await readStored(voiceKey, MAX_AUDIO_BYTES, "voice");
        return client.generateAvatar({
          model: spec.id,
          imageUrl: toDataUri(portrait.body, portrait.contentType),
          audioUrl: toDataUri(audio.body, audio.contentType),
          resolution: res.id,
          audioSeconds: Math.min(audioSeconds, res.maxAudioSeconds),
          ...(current.avatarPrompt === null ? {} : { prompt: current.avatarPrompt }),
        });
      };
    } else {
      const source = current.sourceVideo;
      if (source === null) {
        throw Object.assign(new Stop("input_missing", "The source video is missing."), {
          definite: true,
        });
      }
      send = async () => {
        const portrait = await readStored(
          await keyOf(current.portrait),
          MAX_PORTRAIT_BYTES,
          "portrait",
        );
        const video = await readStored(
          await keyOf(source),
          MAX_SOURCE_VIDEO_BYTES,
          "source video",
        );
        return client.generateSwap({
          model: current.videoModel,
          imageUrl: toDataUri(portrait.body, portrait.contentType),
          videoUrl: toDataUri(video.body, video.contentType),
          resolution: current.resolution,
          videoSeconds: source.durationSeconds,
        });
      };
    }

    const out = await runStep(current, client, "videoStep", send, lastAttempt);
    current = out.run;
    let mediaId: string;
    try {
      mediaId = await storeVideo(current, out.state.output as { url: string });
    } catch (error) {
      if (!lastAttempt) throw new RetryLater("video download failed, retry");
      log.error(
        { runId: run.id, code: isPortError(error) ? error.code : "internal" },
        "formato con voz: descarga fallida",
      );
      throw Object.assign(
        new Stop("download_failed", "The video could not be copied to storage."),
        { definite: false },
      );
    }
    // Lo cobrado de verdad, si fal lo dice (OmniHuman: `duration`).
    const billed = out.state.billedSeconds;
    if (current.kind === "speaking" && billed !== undefined) {
      const actual = await client
        .estimateAvatar({
          model: current.videoModel,
          imageUrl: "",
          audioUrl: "",
          resolution: current.resolution,
          audioSeconds: Math.min(billed, 60),
        })
        .catch(() => null);
      if (actual !== null) await resize(current, keys.video, actual.usd, true);
    }
    await spend(current, keys.video, "settle");
    current = await save(current, (cur) => ({
      ...cur,
      stage: "building",
      videoStep: {
        ...cur.videoStep,
        mediaId,
        billedSeconds: billed ?? null,
      },
    }));
    log.info({ runId: run.id, mediaId }, "formato con voz: video listo");
    return current;
  }

  async function pieceStage(run: SpeakingRunRecord): Promise<void> {
    if (run.contentId !== null) return;
    const contentId = await inCompany(run.companyId, async (tx) => {
      const scope = { companyId: run.companyId };
      const existing = await contentRepository.findById(tx, scope, run.id);
      if (existing !== null) return existing.id;
      const ids = [run.videoStep.mediaId, run.demo?.mediaId].filter(
        (x): x is string => typeof x === "string",
      );
      const rows = (
        await mediaRepository.list(tx, scope, {
          limit: ids.length,
          filter: { mediaId: { in: ids } },
        })
      ).items;
      const video = rows.find((m) => m.mediaId === run.videoStep.mediaId);
      if (video === undefined) {
        throw new Stop(
          "input_missing",
          "The generated video was deleted before the piece was built.",
        );
      }
      const videoRef = { mediaId: video.mediaId, url: video.r2Url };
      let payload;
      if (run.kind === "swap") {
        payload = swapBuildPayload({ video: videoRef, caption: run.caption });
      } else {
        const format = findSpeakingFormat(run.formatId);
        const demoRow =
          run.demo === null ? null : rows.find((m) => m.mediaId === run.demo?.mediaId);
        if (format === undefined || run.voiceStep.url === null) {
          throw new Stop("content_failed", "The piece could not be assembled.");
        }
        if (format.layout !== "full" && demoRow === undefined) {
          throw new Stop(
            "input_missing",
            "The demo video was deleted before the piece was built.",
          );
        }
        payload = speakingBuildPayload({
          layout: format.layout,
          avatar: videoRef,
          demo:
            demoRow === undefined || demoRow === null
              ? null
              : { mediaId: demoRow.mediaId, url: demoRow.r2Url },
          voiceUrl: run.voiceStep.url,
          caption: run.caption,
        });
      }
      if (payload === null) {
        throw new Stop("content_failed", "The piece could not be assembled.");
      }
      const parsed = contentBuildPayloadSchema.parse(payload);
      const contentType = "hook_video" in parsed ? "video-hook" : "wall-of-text";
      const row = await contentRepository.create(tx, scope, {
        id: run.id,
        type: contentType,
        status: "BUILDING",
        generatedText: run.script ?? run.caption,
        buildPayload: parsed,
      });
      const job: ContentBuildJob = {
        companyId: run.companyId,
        contentId: row.id,
        contentType,
        revision: row.revision,
        reason: "create",
      };
      // ADR-005: la pieza y su build en la misma transacción.
      await deps.queue.enqueue<ContentBuildJob>({
        queue: CONTENT_BUILD_QUEUE,
        payload: job,
        options: {
          transaction: tx,
          singletonKey: `${CONTENT_BUILD_QUEUE}:${row.id}:${String(row.revision)}`,
          retryLimit: 2,
          retryBackoff: true,
        },
      });
      return row.id;
    });
    await save(run, (cur) => ({ ...cur, contentId }));
    log.info({ runId: run.id, contentId }, "formato con voz: pieza encolada");
  }

  return async function handle(ctx, job): Promise<void> {
    const base = { jobId: ctx.jobId, companyId: job.companyId, runId: job.speakingRunId };
    const lastAttempt = ctx.attempt >= ctx.maxAttempts;
    const run = parseSpeakingRunRecord(
      await deps.runs.get(job.companyId, job.speakingRunId),
    );
    if (run === null || run.companyId !== job.companyId) {
      log.warn(base, "corrida con voz inexistente: nada que hacer");
      return;
    }
    if (isTerminalSpeakingStage(run.stage) || run.error !== null) {
      log.info({ ...base, stage: run.stage }, "corrida con voz ya cerrada");
      return;
    }
    if (run.stage === "building") {
      try {
        await pieceStage(run);
      } catch (error) {
        await failPiece(run, error);
      }
      return;
    }

    const snapshot = await deps.registry.read();
    const voiceConfig =
      run.kind === "speaking"
        ? resolveVoiceConfig("speech", snapshot, deps.secrets)
        : null;
    const videoConfig = resolveVoiceConfig(
      run.kind === "speaking" ? "avatar" : "swap",
      snapshot,
      deps.secrets,
    );
    const missing =
      videoConfig === null || (run.kind === "speaking" && voiceConfig === null);
    if (missing) {
      await close(
        run,
        new Stop("not_configured", "fal is no longer set up in Settings → Models."),
        {
          voice:
            run.voiceStep.request === null && run.voiceStep.url === null
              ? "release"
              : "settle",
          video: run.videoStep.request === null ? "release" : "settle",
        },
      );
      return;
    }

    let client: VoiceClient;
    try {
      client = deps.clientFor(voiceConfig ?? videoConfig);
    } catch (error) {
      await close(run, portFailure(error), {
        voice: run.voiceStep.request === null ? "release" : "settle",
        video: run.videoStep.request === null ? "release" : "settle",
      });
      return;
    }

    let current = run;
    try {
      await deps.semaphoreFor("fal").run(async () => {
        if (current.kind === "speaking") {
          current = await voiceStage(current, client, lastAttempt);
        }
        current = await videoStage(current, client, lastAttempt);
      });
    } catch (error) {
      if (error instanceof RetryLater) {
        log.warn({ ...base, why: error.message }, "formato con voz: se retoma después");
        throw error;
      }
      const stop = error instanceof Stop ? error : portFailure(error);
      const definite = (stop as Stop & { definite?: boolean }).definite ?? false;
      // Qué paso falló: sin voz lista, la voz; si no, el video.
      const latest =
        parseSpeakingRunRecord(await deps.runs.get(current.companyId, current.id)) ??
        current;
      const voiceDone = latest.voiceStep.url !== null;
      const videoSpend: "settle" | "release" =
        latest.videoStep.request === null || definite ? "release" : "settle";
      await close(
        latest,
        stop,
        voiceDone
          ? { video: videoSpend }
          : {
              voice: latest.voiceStep.request === null || definite ? "release" : "settle",
              video: videoSpend,
            },
      );
      return;
    }

    try {
      await pieceStage(current);
    } catch (error) {
      await failPiece(current, error);
    }
  };

  async function failPiece(run: SpeakingRunRecord, error: unknown): Promise<void> {
    const stop =
      error instanceof Stop
        ? error
        : new Stop("content_failed", "The video could not be started.");
    await save(run, (cur) => ({
      ...cur,
      stage: "failed",
      error: { code: stop.code, message: stop.message },
    }));
    log.error(
      { runId: run.id, why: error instanceof Error ? error.message : "unknown" },
      "formato con voz: no se pudo armar la pieza",
    );
  }
}
