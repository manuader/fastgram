/**
 * Formatos con voz y character swap — sprint 8 (agente L), `P4-FORMAT-002`,
 * `P4-INFL-011`, `AI-010`. Contrato: `packages/contracts/src/resources/speaking.ts`.
 *
 *   GET  /ai-studio/speaking/options
 *   POST /ai-studio/speaking/:format/script
 *   POST /ai-studio/speaking/:format/estimate
 *   POST /ai-studio/speaking/:format/runs            (202)
 *   POST /ai-studio/swap/estimate
 *   POST /ai-studio/swap/runs                        (202)
 *   GET  /ai-studio/speaking-runs
 *   GET  /ai-studio/speaking-runs/:id
 *
 * Lo registra `registerAiStudioRoutes` (`ai-studio.ts`). Los casos de uso son
 * de `core` (`speaking-start.ts`); acá se resuelven las entradas:
 *
 * - **El retrato**: de un modelo de la biblioteca (`characterModelId`, su
 *   `portraitUrl`) o del Media Bank (`portraitMediaId`, una imagen `ready` de
 *   esta marca). Uno de los dos.
 * - **La voz**: la del modelo de la biblioteca si la tiene; `voiceId` la pisa;
 *   si no hay ninguna, la default del modelo de voz de Settings → Models.
 * - **La biblioteca** se lee por su contrato HTTP (`GET /character-models`,
 *   agente K) con `inject`: esta ruta no depende de cómo la guarda K. Un
 *   modelo que no está, o que no está `ready`, es 400 en el campo.
 *
 * ## Decisiones que el PRD no cubre
 *
 * - `:format` y no `:formatId` (trampa 56).
 * - Un modelo de la biblioteca es del dueño y sirve para cualquier marca
 *   (contrato K↔L: «owner-level, ignora la marca activa»). La corrida y la
 *   pieza sí son de la marca activa.
 * - Escribir el guion no cobra: usa el modelo de texto de Settings → Models,
 *   que no pasa por el tope mensual (igual que las captions).
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  speakingCharacterSchema,
  speakingRunListQuerySchema,
  speakingRunRequestSchema,
  speakingScriptRequestSchema,
  swapRunRequestSchema,
  type SpeakingCharacter,
  type SpeakingOptions,
  type SpeakingRun,
  type SpeakingScript,
  type VoiceRunEstimate as VoiceRunEstimateView,
} from "@fastgram/contracts";
import {
  JOB_QUEUES,
  SPEAKING_DURATIONS,
  SPEAKING_WORDS_PER_SECOND_MAX,
  SPEAKING_WORDS_PER_SECOND_MIN,
  SWAP_MAX_SOURCE_SECONDS,
  budgetSummary,
  cleanGeneratedScript,
  estimateSpeakingRun,
  estimateSwapRun,
  findGenerativeFormat,
  findSpeakingFormat,
  fitsBudget,
  maxScriptWords,
  monthKey,
  parseSpeakingRunRecord,
  resolveVoiceConfig,
  scriptGuidance,
  speakingGenerativeFormats,
  speakingRunSingletonKey,
  speakingScriptPrompt,
  startSpeakingRun,
  startSwapRun,
  type SpeakingInputMedia,
  type SpeakingRunDeps,
  type SpeakingRunJob,
  type SpeakingRunRecord,
  type SwapRunDeps,
  type VoiceRunEstimate,
  type VoiceRunRejection,
  type VoiceTask,
} from "@fastgram/core";
import {
  companyProfileRepository,
  contentRepository,
  mediaRepository,
  type Transaction,
} from "@fastgram/db";
import { isPortError } from "@fastgram/ports";

import { ApiRejection } from "../../http/errors.js";
import { data, notFound } from "./shared.js";
import type { ZodApp } from "../../server/types.js";
import {
  ledgerOrFail,
  toBudgetView,
  type GenAiRouteDeps,
  type GenerationFiles,
  type VoiceEstimator,
} from "./genai.js";

/** Igual que AI Studio: dos intentos, y un job vencido a mitad se retoma. */
const RETRY_LIMIT = 1;
const EXPIRE_SECONDS = 30 * 60;
const DEFAULT_LIST_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Presupuesto del modelo de texto para el guion (el proxy web corta a los 10 s). */
const SCRIPT_TIMEOUT_MS = 9_000;

const LANGUAGES: Readonly<Record<string, string>> = {
  en: "English",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
};

const formatParams = z.object({ format: z.string().min(1).max(64) });
const idParams = z.object({ id: z.string().min(1) });

type Run = <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;

interface Ctx {
  readonly companyId: string;
  readonly run: Run;
  readonly headers: Readonly<Record<string, string>>;
}

function providerRejection(error: unknown): ApiRejection {
  if (error instanceof ApiRejection) return error;
  if (isPortError(error)) {
    return error.code === "bad_request"
      ? new ApiRejection(400, "bad_request", error.message, { reason: "bad_request" })
      : new ApiRejection(503, "service_unavailable", error.message, {
          reason: error.code,
        });
  }
  return new ApiRejection(503, "service_unavailable", "fal failed.", {
    reason: "provider_unavailable",
  });
}

function rejectionToApi(r: VoiceRunRejection): ApiRejection {
  switch (r.reason) {
    case "invalid":
      return new ApiRejection(400, "bad_request", r.message, { field: r.field });
    case "not_configured":
      return new ApiRejection(409, "conflict", r.message, {
        reason: "not_configured",
        task: r.task,
      });
    case "ledger_unreadable":
      return new ApiRejection(503, "service_unavailable", r.message);
    case "budget_exceeded":
      return new ApiRejection(
        402,
        "payment_required",
        "This generation would go over this month's AI budget.",
        {
          reason: "budget_exceeded",
          estimateUsd: r.estimateUsd,
          remainingUsd: r.summary.remainingUsd,
          budgetUsd: r.summary.budgetUsd,
        },
      );
  }
}

/** Los headers que identifican al dueño y la marca, para pedirle algo a la propia API. */
function forwardHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["cookie", "authorization", "x-fastgram-workspace"]) {
    const v = headers[name];
    if (typeof v === "string") out[name] = v;
  }
  return out;
}

export function registerSpeakingRoutes(app: ZodApp, deps: GenAiRouteDeps): void {
  const now = (): Date => app.deps.clock.now();
  const runs: GenerationFiles | undefined = deps.speakingRuns;

  function ctxOf(request: {
    readonly auth: { readonly companyId: string };
    readonly tx: Run;
    readonly headers: Record<string, unknown>;
  }): Ctx {
    return {
      companyId: request.auth.companyId,
      run: (fn) => request.tx(fn),
      headers: forwardHeaders(request.headers),
    };
  }

  async function voiceConfig(task: VoiceTask) {
    return resolveVoiceConfig(task, await deps.registry.read(), deps.env);
  }

  function clientFor(config: NonNullable<Awaited<ReturnType<typeof voiceConfig>>>) {
    if (deps.voiceClientFor === undefined) {
      throw new ApiRejection(503, "service_unavailable", "Voice formats aren't wired.");
    }
    try {
      return deps.voiceClientFor(config);
    } catch (error) {
      throw providerRejection(error);
    }
  }

  /** La biblioteca por su contrato; `null` si no respondió. */
  async function characters(ctx: Ctx): Promise<readonly SpeakingCharacter[] | null> {
    if (deps.characters !== undefined) return deps.characters(ctx.headers);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/character-models",
        headers: ctx.headers,
      });
      if (res.statusCode !== 200) return null;
      const parsed = z
        .object({ data: z.array(speakingCharacterSchema.passthrough()) })
        .safeParse(res.json());
      return parsed.success ? parsed.data.data : null;
    } catch {
      return null;
    }
  }

  async function characterById(ctx: Ctx, id: string): Promise<SpeakingCharacter> {
    const list = await characters(ctx);
    const found = list?.find((c) => c.id === id);
    if (found === undefined) {
      throw new ApiRejection(400, "bad_request", "That model isn't in your library.", {
        field: "characterModelId",
      });
    }
    if (found.status !== "ready") {
      throw new ApiRejection(400, "bad_request", "That model isn't ready yet.", {
        field: "characterModelId",
      });
    }
    return found;
  }

  async function mediaOf(
    ctx: Ctx,
    mediaId: string,
    type: "image" | "video",
    field: string,
  ) {
    const found = await ctx.run((tx) =>
      mediaRepository.list(
        tx,
        { companyId: ctx.companyId },
        { limit: 1, filter: { mediaId: { eq: mediaId } } },
      ),
    );
    const media = found.items[0];
    if (media === undefined || media.mediaType !== type || media.status !== "ready") {
      throw new ApiRejection(
        400,
        "bad_request",
        type === "image"
          ? "We couldn't find that image in the Media Bank."
          : "We couldn't find that video in the Media Bank.",
        { field },
      );
    }
    return media;
  }

  /** El retrato: de la biblioteca o del Media Bank, uno de los dos. */
  async function portraitOf(
    ctx: Ctx,
    body: { characterModelId?: string | undefined; portraitMediaId?: string | undefined },
  ): Promise<{ portrait: SpeakingInputMedia; character: SpeakingCharacter | null }> {
    if (body.characterModelId !== undefined && body.portraitMediaId !== undefined) {
      throw new ApiRejection(
        400,
        "bad_request",
        "Pick a model from your library or an image, not both.",
        { field: "portraitMediaId" },
      );
    }
    if (body.characterModelId !== undefined) {
      const character = await characterById(ctx, body.characterModelId);
      return {
        character,
        portrait: { mediaId: null, url: character.portraitUrl, storageKey: null },
      };
    }
    if (body.portraitMediaId !== undefined) {
      const m = await mediaOf(ctx, body.portraitMediaId, "image", "portraitMediaId");
      return {
        character: null,
        portrait: { mediaId: m.mediaId, url: m.r2Url, storageKey: m.storageKey },
      };
    }
    throw new ApiRejection(
      400,
      "bad_request",
      "Pick a model from your library, or a portrait from the Media Bank.",
      { field: "characterModelId" },
    );
  }

  function speakingDeps(): SpeakingRunDeps {
    let client: VoiceEstimator | null = null;
    const ensure = async (): Promise<VoiceEstimator | null> => {
      if (client !== null) return client;
      const config = (await voiceConfig("speech")) ?? (await voiceConfig("avatar"));
      if (config === null) return null;
      client = clientFor(config);
      return client;
    };
    return {
      ...commonDeps(),
      speechTask: async () => {
        const config = await voiceConfig("speech");
        const c = config === null ? null : await ensure();
        if (config === null || c === null) return null;
        return {
          provider: config.provider,
          defaultModel: config.model,
          models: c.speechModels(),
        };
      },
      avatarTask: async () => {
        const config = await voiceConfig("avatar");
        const c = config === null ? null : await ensure();
        if (config === null || c === null) return null;
        return {
          provider: config.provider,
          defaultModel: config.model,
          models: c.avatarModels(),
        };
      },
      estimateSpeech: async (r) => {
        const c = await ensure();
        if (c === null) throw new Error("estimate antes de configurar");
        try {
          return await c.estimateSpeech(r);
        } catch (error) {
          throw providerRejection(error);
        }
      },
      estimateAvatar: async (r) => {
        const c = await ensure();
        if (c === null) throw new Error("estimate antes de configurar");
        try {
          return await c.estimateAvatar(r);
        } catch (error) {
          throw providerRejection(error);
        }
      },
    };
  }

  function swapDeps(): SwapRunDeps {
    let client: VoiceEstimator | null = null;
    return {
      ...commonDeps(),
      swapTask: async () => {
        const config = await voiceConfig("swap");
        if (config === null) return null;
        client = clientFor(config);
        return {
          provider: config.provider,
          defaultModel: config.model,
          models: client.swapModels(),
        };
      },
      estimateSwap: async (r) => {
        if (client === null) throw new Error("estimate antes de swapTask");
        try {
          return await client.estimateSwap(r);
        } catch (error) {
          throw providerRejection(error);
        }
      },
    };
  }

  function commonDeps() {
    return {
      now,
      newId: () => randomUUID(),
      env: deps.env,
      ledger: deps.ledger,
      runs: requireRuns(),
      enqueue: async (job: SpeakingRunJob) => {
        const queue = app.deps.queue;
        if (queue === undefined) throw new Error("sin cola");
        await queue.enqueue<SpeakingRunJob>({
          queue: JOB_QUEUES.aiStudioGeneration,
          payload: job,
          options: {
            singletonKey: speakingRunSingletonKey(job),
            retryLimit: RETRY_LIMIT,
            retryBackoff: true,
            expireInSeconds: EXPIRE_SECONDS,
          },
        });
      },
    };
  }

  function requireRuns(): GenerationFiles {
    if (runs === undefined) {
      throw new ApiRejection(503, "service_unavailable", "Voice formats aren't wired.");
    }
    return runs;
  }

  function speakingFormatOrFail(id: string) {
    const format = findGenerativeFormat(id);
    if (format === undefined) throw notFound("format");
    if (format.status === "blocked") {
      throw new ApiRejection(409, "conflict", format.why, {
        reason: "format_unavailable",
        blockedBy: format.reason,
      });
    }
    const speaking = findSpeakingFormat(id);
    if (speaking === undefined) throw notFound("format");
    return speaking;
  }

  async function profileOf(ctx: Ctx) {
    return ctx.run(
      async (tx) =>
        (
          await companyProfileRepository.list(
            tx,
            { companyId: ctx.companyId },
            { limit: 1 },
          )
        ).items[0],
    );
  }

  async function speakingInput(
    ctx: Ctx,
    formatId: string,
    body: z.infer<typeof speakingRunRequestSchema>,
    source: "studio" | "influencer",
  ) {
    const { portrait, character } = await portraitOf(ctx, body);
    const speech = await voiceConfig("speech");
    // La voz: `voiceId` elegida > la del modelo > la default del modelo de voz.
    let voice: { model: string; voiceId: string } | null = null;
    if (body.voiceId !== undefined && speech !== null) {
      voice = {
        model:
          character?.voice !== null &&
          character?.voice !== undefined &&
          body.voiceId === character.voice.voiceId
            ? character.voice.model
            : speech.model,
        voiceId: body.voiceId,
      };
    } else if (character?.voice !== null && character?.voice !== undefined) {
      voice = { model: character.voice.model, voiceId: character.voice.voiceId };
    } else if (speech !== null) {
      const client = clientFor(speech);
      const spec = client.speechModels().find((m) => m.id === speech.model);
      if (spec !== undefined) voice = { model: spec.id, voiceId: spec.defaultVoice };
    }
    if (voice === null) {
      throw new ApiRejection(
        409,
        "conflict",
        "Set up a fal voice model in Settings → Models first.",
        {
          reason: "not_configured",
          task: "speech",
        },
      );
    }
    const demo =
      body.demoMediaId === undefined
        ? null
        : await mediaOf(ctx, body.demoMediaId, "video", "demoMediaId");
    return {
      companyId: ctx.companyId,
      formatId,
      script: body.script,
      durationSeconds: body.durationSeconds,
      caption: body.caption,
      languageCode: body.languageCode,
      voice,
      portrait,
      characterModelId: character?.id ?? null,
      demo:
        demo === null
          ? null
          : { mediaId: demo.mediaId, url: demo.r2Url, storageKey: demo.storageKey },
      resolution: body.resolution,
      source,
    };
  }

  async function swapInput(ctx: Ctx, body: z.infer<typeof swapRunRequestSchema>) {
    const { portrait, character } = await portraitOf(ctx, body);
    const source = await mediaOf(ctx, body.sourceMediaId, "video", "sourceMediaId");
    return {
      companyId: ctx.companyId,
      portrait,
      characterModelId: character?.id ?? null,
      sourceVideo: {
        mediaId: source.mediaId,
        url: source.r2Url,
        storageKey: source.storageKey,
        durationSeconds: source.videoDurationSec,
      },
      caption: body.caption,
      resolution: body.resolution,
      source: "studio" as const,
    };
  }

  async function estimateView(r: VoiceRunEstimate): Promise<VoiceRunEstimateView> {
    const summary = budgetSummary(
      ledgerOrFail(await deps.ledger.read()),
      monthKey(now()),
      deps.env,
    );
    const part = (p: VoiceRunEstimate["video"]) => ({
      model: p.model,
      estimate: {
        usd: p.estimate.usd,
        source: p.estimate.source,
        basis: p.estimate.basis,
        sourceUrl: p.estimate.sourceUrl ?? null,
      },
    });
    return {
      provider: r.provider as VoiceRunEstimateView["provider"],
      speechModel: r.speechModel,
      videoModel: r.videoModel,
      resolution: r.resolution,
      voice: r.voice === null ? null : part(r.voice),
      video: part(r.video),
      usd: r.usd,
      videoSeconds: r.videoSeconds,
      guidance:
        r.guidance === null
          ? null
          : {
              words: r.guidance.words,
              min: r.guidance.target.min,
              max: r.guidance.target.max,
              level: r.guidance.level,
              message: r.guidance.message,
            },
      budget: toBudgetView(summary),
      fits: fitsBudget(summary, r.usd),
    };
  }

  async function runViews(
    ctx: Ctx,
    records: readonly SpeakingRunRecord[],
  ): Promise<SpeakingRun[]> {
    const out: SpeakingRun[] = [];
    for (const r of records) {
      const found = await ctx.run(async (tx) => ({
        content:
          r.contentId === null
            ? null
            : await contentRepository.findById(
                tx,
                { companyId: ctx.companyId },
                r.contentId,
              ),
        video:
          r.videoStep.mediaId === null
            ? null
            : ((
                await mediaRepository.list(
                  tx,
                  { companyId: ctx.companyId },
                  { limit: 1, filter: { mediaId: { eq: r.videoStep.mediaId } } },
                )
              ).items[0] ?? null),
      }));
      // La etapa visible sale también de la pieza, como en los formatos de sprint 7.
      let stage = r.stage;
      let error: SpeakingRun["error"] = r.error;
      if (r.stage === "building" && r.contentId !== null) {
        const status = found.content?.status ?? null;
        if (status === "CREATED") stage = "ready";
        else if (status === "FAILED") {
          stage = "failed";
          error = { code: "build_failed", message: "The video could not be rendered." };
        } else if (status === null) {
          stage = "failed";
          error = {
            code: "content_failed",
            message: "The piece is no longer available.",
          };
        }
      }
      out.push({
        id: r.id,
        kind: r.kind,
        formatId: r.formatId,
        stage,
        source: r.source,
        characterModelId: r.characterModelId,
        script: r.script,
        caption: r.caption,
        languageCode: r.languageCode,
        durationSeconds: r.durationSeconds,
        voice: r.voice,
        videoModel: r.videoModel,
        resolution: r.resolution,
        estimate: r.estimate,
        voiceUrl: r.voiceStep.url,
        video:
          found.video === null
            ? null
            : {
                mediaId: found.video.mediaId,
                mediaType: found.video.mediaType,
                url: found.video.r2Url,
              },
        contentId: found.content === null ? null : r.contentId,
        error,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      });
    }
    return out;
  }

  function taskView<Spec>(
    config: Awaited<ReturnType<typeof voiceConfig>>,
    models: (c: VoiceEstimator) => readonly Spec[],
  ) {
    if (config === null) {
      return {
        configured: false,
        provider: null,
        defaultModel: null,
        models: [] as Spec[],
      };
    }
    try {
      return {
        configured: true,
        provider: config.provider,
        defaultModel: config.model,
        models: [...models(clientFor(config))],
      };
    } catch {
      return {
        configured: false,
        provider: null,
        defaultModel: null,
        models: [] as Spec[],
      };
    }
  }

  // ── GET /ai-studio/speaking/options ──
  app.get("/ai-studio/speaking/options", async (request) => {
    const ctx = ctxOf(request);
    const ledger = ledgerOrFail(await deps.ledger.read());
    const writer = deps.scriptLlm === undefined ? null : await deps.scriptLlm.current();
    const view: SpeakingOptions = {
      speech: taskView(await voiceConfig("speech"), (c) =>
        c.speechModels().map((m) => ({ ...m, voices: [...m.voices] })),
      ),
      avatar: taskView(await voiceConfig("avatar"), (c) =>
        c
          .avatarModels()
          .map((m) => ({ ...m, resolutions: m.resolutions.map((r) => ({ ...r })) })),
      ),
      swap: taskView(await voiceConfig("swap"), (c) =>
        c.swapModels().map((m) => ({ ...m, resolutions: [...m.resolutions] })),
      ),
      characters: await characters(ctx).then((list) =>
        list === null
          ? null
          : list.map((c) => ({
              id: c.id,
              name: c.name,
              portraitUrl: c.portraitUrl,
              status: c.status,
              voice: c.voice,
            })),
      ),
      formats: speakingGenerativeFormats().map((f) => ({
        id: f.id,
        layout: f.layout,
        portraitHint: f.portraitHint,
        demoHint: f.demoHint,
        preferredDurationSeconds: f.preferredDurationSeconds,
      })),
      durations: [...SPEAKING_DURATIONS],
      wordsPerSecond: {
        min: SPEAKING_WORDS_PER_SECOND_MIN,
        max: SPEAKING_WORDS_PER_SECOND_MAX,
      },
      swapMaxSourceSeconds: SWAP_MAX_SOURCE_SECONDS,
      scriptWriter: writer !== null,
      budget: toBudgetView(budgetSummary(ledger, monthKey(now()), deps.env)),
    };
    return data(view);
  });

  // ── POST /ai-studio/speaking/:format/script ──
  app.post(
    "/ai-studio/speaking/:format/script",
    { schema: { params: formatParams, body: speakingScriptRequestSchema } },
    async (request) => {
      const format = speakingFormatOrFail(request.params.format);
      const ctx = ctxOf(request);
      const writer = deps.scriptLlm === undefined ? null : await deps.scriptLlm.current();
      if (writer === null) {
        throw new ApiRejection(
          409,
          "conflict",
          "Set up a text model in Settings → Models to write scripts.",
          { reason: "not_configured", task: "text" },
        );
      }
      const body = request.body;
      const profile = body.includeBrand === false ? undefined : await profileOf(ctx);
      const language = LANGUAGES[body.languageCode ?? "en"] ?? "English";
      const prompt = speakingScriptPrompt({
        format,
        durationSeconds: body.durationSeconds,
        language,
        topic: body.topic,
        brand:
          profile === undefined
            ? null
            : {
                productOffering: profile.productOffering,
                coreIdentity: profile.coreIdentity,
                audience: profile.targetAudience,
              },
      });
      let text: string;
      try {
        const done = await writer.llm.complete({
          messages: prompt.messages,
          untrusted: prompt.untrusted,
          temperature: 0.8,
          maxOutputTokens: 400,
          timeoutMs: SCRIPT_TIMEOUT_MS,
        });
        text = done.text;
      } catch (error) {
        request.log.info(
          { code: isPortError(error) ? error.code : "internal" },
          "speaking script failed",
        );
        throw new ApiRejection(
          503,
          "service_unavailable",
          "The text model couldn't write a script. Try again or write your own.",
          { reason: isPortError(error) ? error.code : "provider_unavailable" },
        );
      }
      const script = cleanGeneratedScript(text, maxScriptWords(60));
      const g = scriptGuidance(script, body.durationSeconds);
      const view: SpeakingScript = {
        script,
        guidance: {
          words: g.words,
          min: g.target.min,
          max: g.target.max,
          level: g.level,
          message: g.message,
        },
      };
      return data(view);
    },
  );

  // ── POST /ai-studio/speaking/:format/estimate ──
  app.post(
    "/ai-studio/speaking/:format/estimate",
    { schema: { params: formatParams, body: speakingRunRequestSchema } },
    async (request) => {
      speakingFormatOrFail(request.params.format);
      const ctx = ctxOf(request);
      const input = await speakingInput(
        ctx,
        request.params.format,
        request.body,
        "studio",
      );
      const r = await estimateSpeakingRun(speakingDeps(), input);
      if (!r.ok) throw rejectionToApi(r);
      return data(await estimateView(r));
    },
  );

  // ── POST /ai-studio/speaking/:format/runs ──
  app.post(
    "/ai-studio/speaking/:format/runs",
    {
      schema: {
        params: formatParams,
        querystring: z.object({ source: z.enum(["studio", "influencer"]).optional() }),
        body: speakingRunRequestSchema,
      },
    },
    async (request, reply) => {
      if (app.deps.queue === undefined) {
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Voice formats are temporarily unavailable.",
          },
        });
      }
      speakingFormatOrFail(request.params.format);
      const ctx = ctxOf(request);
      const input = await speakingInput(
        ctx,
        request.params.format,
        request.body,
        request.query.source ?? "studio",
      );
      const r = await startSpeakingRun(speakingDeps(), input);
      if (!r.ok) throw rejectionToApi(r);
      request.log.info(
        { runId: r.run.id, format: r.run.formatId, estimateUsd: r.run.estimate.usd },
        "speaking run queued",
      );
      const [view] = await runViews(ctx, [r.run]);
      return reply.status(202).send(data(view));
    },
  );

  // ── POST /ai-studio/swap/estimate ──
  app.post(
    "/ai-studio/swap/estimate",
    { schema: { body: swapRunRequestSchema } },
    async (request) => {
      const ctx = ctxOf(request);
      const r = await estimateSwapRun(swapDeps(), await swapInput(ctx, request.body));
      if (!r.ok) throw rejectionToApi(r);
      return data(await estimateView(r));
    },
  );

  // ── POST /ai-studio/swap/runs ──
  app.post(
    "/ai-studio/swap/runs",
    { schema: { body: swapRunRequestSchema } },
    async (request, reply) => {
      if (app.deps.queue === undefined) {
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Character swap is temporarily unavailable.",
          },
        });
      }
      const ctx = ctxOf(request);
      const r = await startSwapRun(swapDeps(), await swapInput(ctx, request.body));
      if (!r.ok) throw rejectionToApi(r);
      request.log.info(
        { runId: r.run.id, estimateUsd: r.run.estimate.usd },
        "character swap queued",
      );
      const [view] = await runViews(ctx, [r.run]);
      return reply.status(202).send(data(view));
    },
  );

  // ── GET /ai-studio/speaking-runs ──
  app.get(
    "/ai-studio/speaking-runs",
    { schema: { querystring: speakingRunListQuerySchema } },
    async (request) => {
      const ctx = ctxOf(request);
      const limit = request.query.limit ?? DEFAULT_LIST_LIMIT;
      const characterModelId = request.query.characterModelId;
      const records = (await requireRuns().list(ctx.companyId))
        .map(parseSpeakingRunRecord)
        .filter(
          (r): r is SpeakingRunRecord =>
            r !== null &&
            r.companyId === ctx.companyId &&
            (characterModelId === undefined || r.characterModelId === characterModelId),
        )
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? b.id.localeCompare(a.id)
            : b.createdAt.localeCompare(a.createdAt),
        )
        .slice(0, limit);
      return data(await runViews(ctx, records));
    },
  );

  // ── GET /ai-studio/speaking-runs/:id ──
  app.get(
    "/ai-studio/speaking-runs/:id",
    { schema: { params: idParams } },
    async (request) => {
      const ctx = ctxOf(request);
      const { id } = request.params;
      if (!UUID.test(id)) throw notFound("speaking run");
      const record = parseSpeakingRunRecord(await requireRuns().get(ctx.companyId, id));
      if (record === null || record.companyId !== ctx.companyId) {
        throw notFound("speaking run");
      }
      const [view] = await runViews(ctx, [record]);
      return data(view);
    },
  );
}
