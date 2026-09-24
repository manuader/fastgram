/**
 * AI Studio — `PU-LATER-005` (FR-090 adaptado al plan de uso personal),
 * `PU-MODEL-003`/`004`/`005`.
 *
 *   GET  /ai-studio/options             qué se puede pedir (Settings → Models)
 *   POST /ai-studio/estimate            costo estimado + si entra en el tope
 *   POST /ai-studio/generations         estimar → reservar → encolar (202)
 *   GET  /ai-studio/generations         galería de la marca
 *   GET  /ai-studio/generations/:id     una generación
 *
 * ## El orden de `POST /ai-studio/generations`
 *
 * 1. **Sin cola, 503 antes de nada**: no se reserva gasto que ningún worker
 *    va a liquidar.
 * 2. Validar contra la ficha del modelo (`checkGenerationInput`) → 400 con
 *    `details.field`.
 * 3. **Estimar de nuevo** (no se confía en el número que mandó la UI): el
 *    estimador de Higgsfield o el precio de lista de fal.
 * 4. Reservar en el libro de gasto **bajo lock**: dos pedidos a la vez no
 *    pueden pasarse del tope entre los dos → 402 `payment_required` con
 *    `details.reason = "budget_exceeded"`.
 * 5. Escribir el registro (`queued`) y encolar `ai-studio-generation`. Si
 *    encolar falla, la reserva se libera y el registro queda `failed`.
 *
 * El worker (`apps/worker/src/genai/`) envía, hace polling, copia el
 * resultado a nuestro storage, crea la media y liquida la reserva.
 *
 * ## Errores del proveedor
 *
 * Un `401` de Higgsfield traducido a `401` le diría a la web que venció su
 * sesión (mismo criterio que `models.ts`). Se responde `503
 * service_unavailable` (o `400 bad_request` si el proveedor rechazó los
 * parámetros) con `details.reason` = el código estable de la generación.
 *
 * ## Decisiones que el PRD no cubre
 *
 * - **Las generaciones viven en archivos** (`~/.fastgram/ai-studio/<marca>/`),
 *   no en Postgres: este sprint no tiene migración y el uso es personal. El
 *   `companyId` es parte de la ruta: una generación de otra marca **no
 *   existe** para esta (404, nunca 403).
 * - **Sin tope de «10 en vuelo por workspace»** (FR-090): el modo personal
 *   apaga cuotas (D-06). La concurrencia contra el proveedor la limita el
 *   worker (`FASTGRAM_GENAI_CONCURRENCY`, default 2).
 * - **El resultado va al Media Bank con `origin = 'brand_kit'`**: es el único
 *   origen generado que `GET /media` lista (`LISTED_ORIGINS`); `generated`
 *   está escondido por FR-100.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  formatRunRequestSchema,
  generationListQuerySchema,
  generationRequestSchema,
  type FormatRun,
  type FormatRunEstimate as FormatRunEstimateView,
  type GenerativeFormatsView,
  type AiStudioOptions,
  type AiStudioTaskOptions,
  type CostEstimate,
  type Generation,
  type GenerationEstimate as GenerationEstimateView,
  type GenModelSpec as GenModelSpecView,
} from "@fastgram/contracts";
import {
  GENERATIVE_FORMATS,
  JOB_QUEUES,
  aiStudioSingletonKey,
  estimateGenerativeFormatRun,
  findGenerativeFormat,
  formatRunStatus,
  formatVideoModels,
  parseFormatRunRecord,
  startGenerativeFormatRun,
  type FormatRunDeps,
  type FormatRunInput,
  type FormatRunRecord,
  type FormatRunRejection,
  budgetSummary,
  checkGenerationInput,
  fitsBudget,
  generationErrorFromPort,
  markFailed,
  monthKey,
  newGenerationRecord,
  parseGenerationRecord,
  releaseSpend,
  reserveSpend,
  sortGenerations,
  type AiStudioGenerationJob,
  type GenerationInput,
  type GenerationRecord,
  type ReserveResult,
  type ResolvedGenAiConfig,
} from "@fastgram/core";
import {
  companyProfileRepository,
  contentRepository,
  mediaRepository,
  type Transaction,
} from "@fastgram/db";
import { isPortError, type GenCostEstimate, type GenModelSpec } from "@fastgram/ports";
import type { GenClient } from "@fastgram/adapters";

import { ApiRejection } from "../../http/errors.js";
import { data, notFound } from "./shared.js";
import { registerSpeakingRoutes } from "./ai-studio-speaking.js";
import type { ZodApp } from "../../server/types.js";
import {
  defaultGenAiRouteDeps,
  genAiConfigFor,
  createProviderImageResolver,
  ledgerOrFail,
  toBudgetView,
  type GenAiRouteDeps,
  type GenerationFiles,
} from "./genai.js";

/** pg-boss cuenta reintentos: 1 = dos intentos (`maxAttempts: 2` del catálogo). */
const AI_STUDIO_RETRY_LIMIT = 1;
/**
 * Un video tarda minutos en el proveedor, más la copia a storage. Por encima
 * del `timeoutSeconds` del catálogo a propósito: el worker hace polling dentro
 * del job y un job vencido a mitad de camino se retoma sin reenviar (ver
 * `apps/worker/src/genai/`).
 */
const AI_STUDIO_EXPIRE_SECONDS = 30 * 60;
const DEFAULT_LIST_LIMIT = 50;

const idParams = z.object({ id: z.string().min(1) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function specView(spec: GenModelSpec): GenModelSpecView {
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    aspectRatios: [...spec.aspectRatios],
    aspectFromImage: spec.aspectFromImage,
    counts: [...spec.counts],
    durationsSeconds: [...spec.durationsSeconds],
    promptRequired: spec.promptRequired,
    imageInput: spec.imageInput,
    maxReferenceImages: spec.maxReferenceImages,
    docsUrl: spec.docsUrl,
    listPrice: spec.listPrice === null ? null : { ...spec.listPrice },
  };
}

function estimateView(e: GenCostEstimate | GenerationRecord["estimate"]): CostEstimate {
  return { usd: e.usd, source: e.source, basis: e.basis, sourceUrl: e.sourceUrl ?? null };
}

/** Un error del proveedor → una respuesta que no se confunde con la sesión. */
function providerRejection(error: unknown): ApiRejection {
  if (isPortError(error)) {
    const reason = generationErrorFromPort(error.code);
    return reason === "bad_request"
      ? new ApiRejection(400, "bad_request", error.message, { reason })
      : new ApiRejection(503, "service_unavailable", error.message, { reason });
  }
  return new ApiRejection(503, "service_unavailable", "The generation provider failed.", {
    reason: "provider_unavailable",
  });
}

function notConfigured(kind: "image" | "video"): ApiRejection {
  return new ApiRejection(
    409,
    "conflict",
    `Set up a ${kind} model in Settings → Models first.`,
    { reason: "not_configured", field: "kind" },
  );
}

type GenerationBody = z.infer<typeof generationRequestSchema>;

/**
 * Lo del request que hace falta fuera del handler. Perezoso a propósito: sólo
 * la imagen del Media Bank lo usa, y los montajes de test sin scope (sin
 * `auth` ni `tx`) no tienen que pagarlo.
 */
interface RequestCtx {
  readonly companyId: () => string;
  readonly run: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
}

function ctxOf(request: {
  readonly auth: { readonly companyId: string };
  readonly tx: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
}): RequestCtx {
  return {
    companyId: () => request.auth.companyId,
    run: (fn) => request.tx(fn),
  };
}

interface Prepared {
  readonly config: ResolvedGenAiConfig;
  readonly client: GenClient;
  readonly spec: GenModelSpec;
  readonly input: GenerationInput;
}

export function registerAiStudioRoutes(
  app: ZodApp,
  deps: GenAiRouteDeps = defaultGenAiRouteDeps(),
): void {
  const now = (): Date => app.deps.clock.now();

  const providerImage = createProviderImageResolver(deps);

  /**
   * Sprint 7 (`P4-AISTUDIO-001`): la imagen de entrada elegida del Media Bank
   * → una URL que el proveedor pueda leer. Una imagen de otra marca no existe
   * acá (400, igual que una borrada: el id no dice nada).
   */
  async function imageFromMediaBank(
    config: ResolvedGenAiConfig,
    ctx: RequestCtx,
    mediaId: string,
  ): Promise<string> {
    const companyId = ctx.companyId();
    const found = await ctx.run((tx) =>
      mediaRepository.list(
        tx,
        { companyId },
        { limit: 1, filter: { mediaId: { eq: mediaId } } },
      ),
    );
    const media = found.items[0];
    if (media === undefined || media.mediaType !== "image" || media.status !== "ready") {
      throw new ApiRejection(
        400,
        "bad_request",
        "We couldn't find that reference image. Pick another image and try again.",
        { field: "imageMediaId" },
      );
    }
    return providerImage(config, app.deps.storage, companyId, media);
  }

  async function prepare(body: GenerationBody, ctx: RequestCtx): Promise<Prepared> {
    const config = await genAiConfigFor(deps, body.kind);
    if (config === null) throw notConfigured(body.kind);
    let client: GenClient;
    try {
      client = deps.clientFor(config);
    } catch (error) {
      throw providerRejection(error);
    }
    const model = body.model ?? config.model;
    const spec = client.models().find((m) => m.id === model);
    const typedUrl = body.imageUrl?.trim() === "" ? undefined : body.imageUrl?.trim();
    if (typedUrl !== undefined && body.imageMediaId !== undefined) {
      throw new ApiRejection(
        400,
        "bad_request",
        "Use a Media Bank image or a URL, not both.",
        { field: "imageMediaId" },
      );
    }
    let imageUrl = typedUrl;
    if (body.imageMediaId !== undefined) {
      if (spec === undefined || spec.imageInput === "none") {
        throw new ApiRejection(
          400,
          "bad_request",
          "This model does not take a start image.",
          {
            field: "imageMediaId",
          },
        );
      }
      imageUrl = await imageFromMediaBank(config, ctx, body.imageMediaId);
    }
    const input: GenerationInput = {
      kind: body.kind,
      model,
      prompt: body.prompt,
      aspectRatio: body.aspectRatio,
      count: body.count,
      durationSeconds: body.durationSeconds,
      imageUrl,
    };
    // ComfyUI (`PU-LATER-003`) corre acá y la imagen de entrada la baja el
    // adaptador: vale también la URL `http://` del MinIO local.
    const check = checkGenerationInput(spec, input, {
      localImageFetch: config.provider === "comfyui",
    });
    if (!check.ok || spec === undefined) {
      throw new ApiRejection(
        400,
        "bad_request",
        check.ok ? "That model is not available." : check.message,
        { field: check.ok ? "model" : check.field },
      );
    }
    return { config, client, spec, input };
  }

  async function estimate(p: Prepared): Promise<GenCostEstimate> {
    const { input, client } = p;
    try {
      return input.kind === "image"
        ? await client.estimateImage({
            model: input.model,
            prompt: input.prompt.trim(),
            aspectRatio: input.aspectRatio,
            n: input.count,
          })
        : await client.estimateVideo({
            model: input.model,
            prompt: input.prompt.trim(),
            aspectRatio: input.aspectRatio,
            durationSeconds: input.durationSeconds ?? 0,
            ...(input.imageUrl === undefined ? {} : { imageUrl: input.imageUrl }),
          });
    } catch (error) {
      throw providerRejection(error);
    }
  }

  /** Registro → vista, con la media que ya está en el Media Bank. */
  async function views(
    run: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>,
    companyId: string,
    records: readonly GenerationRecord[],
  ): Promise<Generation[]> {
    const ids = [...new Set(records.flatMap((r) => r.mediaIds))];
    const byId = new Map<string, { url: string; mediaType: "image" | "video" }>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const page = await run((tx) =>
        mediaRepository.list(
          tx,
          { companyId },
          {
            limit: chunk.length,
            filter: { mediaId: { in: chunk } },
          },
        ),
      );
      for (const row of page.items) {
        byId.set(row.mediaId, { url: row.r2Url, mediaType: row.mediaType });
      }
    }
    return records.map((r) => ({
      id: r.id,
      kind: r.kind,
      provider: r.provider,
      model: r.model,
      prompt: r.prompt,
      aspectRatio: r.aspectRatio,
      count: r.count,
      durationSeconds: r.durationSeconds,
      imageUrl: r.imageUrl,
      status: r.status,
      estimate: estimateView(r.estimate),
      // Una media borrada del Media Bank ya no se muestra acá.
      media: r.mediaIds.flatMap((mediaId) => {
        const m = byId.get(mediaId);
        return m === undefined ? [] : [{ mediaId, mediaType: m.mediaType, url: m.url }];
      }),
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async function taskOptions(kind: "image" | "video"): Promise<AiStudioTaskOptions> {
    const config = await genAiConfigFor(deps, kind);
    if (config === null) {
      return { kind, configured: false, provider: null, defaultModel: null, models: [] };
    }
    let models: GenModelSpecView[] = [];
    try {
      models = deps
        .clientFor(config)
        .models()
        .filter((m) => m.kind === kind)
        .map(specView);
    } catch {
      return { kind, configured: false, provider: null, defaultModel: null, models: [] };
    }
    return {
      kind,
      configured: true,
      provider: config.provider,
      defaultModel: config.model,
      models,
    };
  }

  // ── GET /ai-studio/options ──
  app.get("/ai-studio/options", async () => {
    const ledger = ledgerOrFail(await deps.ledger.read());
    const options: AiStudioOptions = {
      image: await taskOptions("image"),
      video: await taskOptions("video"),
      budget: toBudgetView(budgetSummary(ledger, monthKey(now()), deps.env)),
    };
    return data(options);
  });

  // ── POST /ai-studio/estimate ──
  app.post(
    "/ai-studio/estimate",
    { schema: { body: generationRequestSchema } },
    async (request) => {
      const prepared = await prepare(request.body, ctxOf(request));
      const cost = await estimate(prepared);
      const ledger = ledgerOrFail(await deps.ledger.read());
      const summary = budgetSummary(ledger, monthKey(now()), deps.env);
      const view: GenerationEstimateView = {
        provider: prepared.config.provider,
        model: prepared.input.model,
        estimate: estimateView(cost),
        budget: toBudgetView(summary),
        fits: fitsBudget(summary, cost.usd),
      };
      return data(view);
    },
  );

  // ── POST /ai-studio/generations ──
  app.post(
    "/ai-studio/generations",
    { schema: { body: generationRequestSchema } },
    async (request, reply) => {
      const queue = app.deps.queue;
      if (queue === undefined) {
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "AI Studio is temporarily unavailable.",
          },
        });
      }
      const companyId = request.auth.companyId;
      const prepared = await prepare(request.body, ctxOf(request));
      const cost = await estimate(prepared);

      const at = now();
      const month = monthKey(at);
      const id = randomUUID();
      const reserved = await deps.ledger.update<ReserveResult>((raw) => {
        const r = reserveSpend(
          ledgerOrFail(raw),
          {
            month,
            generationId: id,
            usd: cost.usd,
            provider: prepared.config.provider,
            model: prepared.input.model,
            kind: prepared.input.kind,
            companyId,
            at: at.toISOString(),
          },
          deps.env,
        );
        return r.ok ? { next: r.next, result: r } : { result: r };
      });
      if (!reserved.ok) {
        throw new ApiRejection(
          402,
          "payment_required",
          "This generation would go over this month's AI budget.",
          {
            reason: "budget_exceeded",
            estimateUsd: cost.usd,
            remainingUsd: reserved.summary.remainingUsd,
            budgetUsd: reserved.summary.budgetUsd,
          },
        );
      }

      let record = newGenerationRecord({
        id,
        companyId,
        kind: prepared.input.kind,
        provider: prepared.config.provider,
        model: prepared.input.model,
        prompt: prepared.input.prompt,
        aspectRatio: prepared.input.aspectRatio,
        count: prepared.input.count,
        durationSeconds: prepared.input.durationSeconds ?? null,
        imageUrl: prepared.input.imageUrl ?? null,
        estimate: {
          usd: cost.usd,
          source: cost.source,
          basis: cost.basis,
          sourceUrl: cost.sourceUrl ?? null,
        },
        spendMonth: month,
        now: at.toISOString(),
      });

      const release = () =>
        deps.ledger.update((raw) => {
          const next = releaseSpend(ledgerOrFail(raw), month, id);
          return next === null ? { result: null } : { next, result: null };
        });

      try {
        await deps.generations.create(companyId, id, record);
      } catch (error) {
        await release().catch(() => undefined);
        throw error;
      }

      const job: AiStudioGenerationJob = { companyId, generationId: id };
      try {
        await queue.enqueue<AiStudioGenerationJob>({
          queue: JOB_QUEUES.aiStudioGeneration,
          payload: job,
          options: {
            singletonKey: aiStudioSingletonKey(job),
            retryLimit: AI_STUDIO_RETRY_LIMIT,
            retryBackoff: true,
            expireInSeconds: AI_STUDIO_EXPIRE_SECONDS,
          },
        });
      } catch (error) {
        await release().catch(() => undefined);
        record = markFailed(
          record,
          { code: "provider_unavailable", message: "The job could not be queued." },
          now().toISOString(),
        );
        await deps.generations
          .update(companyId, id, () => ({ next: record, result: null }))
          .catch(() => undefined);
        throw error;
      }

      request.log.info(
        {
          generationId: id,
          kind: record.kind,
          provider: record.provider,
          model: record.model,
          estimateUsd: cost.usd,
        },
        "ai studio generation queued",
      );
      const [view] = await views(request.tx, companyId, [record]);
      return reply.status(202).send(data(view));
    },
  );

  // ── GET /ai-studio/generations ──
  app.get(
    "/ai-studio/generations",
    { schema: { querystring: generationListQuerySchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const limit = request.query.limit ?? DEFAULT_LIST_LIMIT;
      const records = sortGenerations(
        (await deps.generations.list(companyId))
          .map(parseGenerationRecord)
          // El archivo está en la carpeta de la marca; la marca del registro
          // tiene que coincidir igual (defensa si alguien movió archivos).
          .filter((r): r is GenerationRecord => r !== null && r.companyId === companyId),
      ).slice(0, limit);
      return data(await views(request.tx, companyId, records));
    },
  );

  // ── GET /ai-studio/generations/:id ──
  app.get(
    "/ai-studio/generations/:id",
    { schema: { params: idParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { id } = request.params;
      if (!UUID.test(id)) throw notFound("generation");
      const record = parseGenerationRecord(await deps.generations.get(companyId, id));
      if (record === null || record.companyId !== companyId) throw notFound("generation");
      const [view] = await views(request.tx, companyId, [record]);
      return data(view);
    },
  );

  // Sprint 7 (agente G): formatos generativos. Sin la colección (montajes de
  // test viejos) no se registran.
  const formatRuns = deps.formatRuns;
  if (formatRuns !== undefined) {
    registerFormatRoutes(app, deps, formatRuns, { taskOptions, providerRejection });
  }
  // Sprint 8 (agente L): formatos con voz y character swap. Mismo criterio:
  // sin su colección, no se registran.
  if (deps.speakingRuns !== undefined) {
    registerSpeakingRoutes(app, deps);
  }
}

/* ------------------------------------------------------------------------ *
 * Formatos generativos — sprint 7 (agente G), `P4-FORMAT-001`/`002`
 *
 *   GET  /ai-studio/formats                     catálogo + texto a video + tope
 *   POST /ai-studio/formats/:format/estimate    costo del clip
 *   POST /ai-studio/formats/:format/runs        reservar y encolar (202)
 *   GET  /ai-studio/format-runs                 corridas de la marca
 *   GET  /ai-studio/format-runs/:id             una corrida
 *
 * El clip es una generación de AI Studio (mismo job, mismo tope); al quedar
 * lista, el worker arma la pieza (`apps/worker/src/formats/`). El caso de uso
 * es `startGenerativeFormatRun` de `core`, el mismo que puede llamar Blitz.
 * `:format` y no `:formatId`: trampa 56.
 * ------------------------------------------------------------------------ */

const formatParams = z.object({ format: z.string().min(1).max(64) });
/**
 * Sprint 7 (segunda tanda): quién pidió la corrida. «Create from prompt» de
 * Blitz manda `?source=blitz`; sin él, `studio` como siempre. Va por query y
 * no en el body porque `formatRunRequestSchema` es `.strict()` y es el mismo
 * pedido en los dos lados: sólo cambia la procedencia que queda en el registro.
 */
const formatRunQuery = z.object({ source: z.enum(["studio", "blitz"]).optional() });

interface FormatRouteHelpers {
  readonly taskOptions: (kind: "image" | "video") => Promise<AiStudioTaskOptions>;
  readonly providerRejection: (error: unknown) => ApiRejection;
}

function rejectionToApi(r: FormatRunRejection): ApiRejection {
  switch (r.reason) {
    case "invalid":
      return new ApiRejection(400, "bad_request", r.message, { field: r.field });
    case "not_configured":
      return new ApiRejection(409, "conflict", r.message, { reason: "not_configured" });
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

function registerFormatRoutes(
  app: ZodApp,
  deps: GenAiRouteDeps,
  runs: GenerationFiles,
  helpers: FormatRouteHelpers,
): void {
  const now = (): Date => app.deps.clock.now();

  /** El formato pedido: 404 si no existe, 409 si está bloqueado o no es clip + texto. */
  function formatOrFail(id: string): void {
    const format = findGenerativeFormat(id);
    if (format === undefined) throw notFound("format");
    if (format.status === "blocked") {
      throw new ApiRejection(409, "conflict", format.why, {
        reason: "format_unavailable",
        blockedBy: format.reason,
      });
    }
    // Sprint 8: los formatos con voz y el swap tienen sus rutas (`ai-studio-speaking.ts`).
    if (format.status !== "available") {
      throw new ApiRejection(
        409,
        "conflict",
        "This format is made with a voice or a source video: use its own form.",
        { reason: "format_unavailable", blockedBy: format.status },
      );
    }
  }

  function depsFor(): FormatRunDeps {
    let client: GenClient | null = null;
    return {
      now,
      newId: () => randomUUID(),
      env: deps.env,
      videoTask: async () => {
        const config = await genAiConfigFor(deps, "video");
        if (config === null) return null;
        try {
          client = deps.clientFor(config);
        } catch (error) {
          throw helpers.providerRejection(error);
        }
        return {
          provider: config.provider,
          defaultModel: config.model,
          models: client.models(),
        };
      },
      estimate: async (request) => {
        if (client === null) throw new Error("estimate antes de videoTask");
        try {
          return await client.estimateVideo(request);
        } catch (error) {
          throw helpers.providerRejection(error);
        }
      },
      ledger: deps.ledger,
      generations: deps.generations,
      runs,
      enqueue: async (job) => {
        const queue = app.deps.queue;
        if (queue === undefined) throw new Error("sin cola");
        await queue.enqueue<AiStudioGenerationJob>({
          queue: JOB_QUEUES.aiStudioGeneration,
          payload: job,
          options: {
            singletonKey: aiStudioSingletonKey(job),
            retryLimit: AI_STUDIO_RETRY_LIMIT,
            retryBackoff: true,
            expireInSeconds: AI_STUDIO_EXPIRE_SECONDS,
          },
        });
      },
    };
  }

  async function inputFor(
    run: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>,
    companyId: string,
    formatId: string,
    body: z.infer<typeof formatRunRequestSchema>,
    source: FormatRunInput["source"] = "studio",
  ): Promise<FormatRunInput> {
    const profile = await run(
      async (tx) =>
        (await companyProfileRepository.list(tx, { companyId }, { limit: 1 })).items[0],
    );
    return {
      companyId,
      formatId,
      overlayText: body.overlayText,
      topic: body.topic,
      includeBrand: body.includeBrand,
      model: body.model,
      durationSeconds: body.durationSeconds,
      brand:
        profile === undefined
          ? null
          : {
              productOffering: profile.productOffering,
              coreIdentity: profile.coreIdentity,
            },
      source,
    };
  }

  /** Corrida → vista: estado de la generación y de la pieza, y el clip. */
  async function runViews(
    tx: <T>(fn: (t: Transaction) => Promise<T>) => Promise<T>,
    companyId: string,
    records: readonly FormatRunRecord[],
  ): Promise<FormatRun[]> {
    const out: FormatRun[] = [];
    for (const run of records) {
      const generation = parseGenerationRecord(
        await deps.generations.get(companyId, run.id),
      );
      const gen =
        generation !== null && generation.companyId === companyId ? generation : null;
      const found = await tx(async (t) => ({
        content:
          run.contentId === null
            ? null
            : await contentRepository.findById(t, { companyId }, run.contentId),
        clip:
          gen === null || gen.mediaIds.length === 0
            ? null
            : ((
                await mediaRepository.list(
                  t,
                  { companyId },
                  { limit: 1, filter: { mediaId: { eq: gen.mediaIds[0] as string } } },
                )
              ).items[0] ?? null),
      }));
      const contentStatus = found.content?.status ?? null;
      const status = formatRunStatus(run, gen?.status ?? null, contentStatus);
      let error: FormatRun["error"] = null;
      if (run.error !== null) error = run.error;
      else if (gen === null)
        error = { code: "generation_missing", message: "The clip's record is missing." };
      else if (gen.error !== null && (status === "failed" || status === "nsfw"))
        error = gen.error;
      else if (status === "failed" && contentStatus === "FAILED")
        error = { code: "build_failed", message: "The video could not be rendered." };
      else if (status === "failed")
        error = { code: "content_failed", message: "The piece is no longer available." };
      out.push({
        id: run.id,
        formatId: run.formatId,
        status,
        topic: run.topic,
        overlayText: run.overlayText,
        videoPrompt: run.videoPrompt,
        model: gen?.model ?? null,
        durationSeconds: gen?.durationSeconds ?? null,
        estimate: gen === null ? null : estimateView(gen.estimate),
        contentId: found.content === null ? null : run.contentId,
        clip:
          found.clip === null
            ? null
            : {
                mediaId: found.clip.mediaId,
                mediaType: found.clip.mediaType,
                url: found.clip.r2Url,
              },
        error,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
    }
    return out;
  }

  // ── GET /ai-studio/formats ──
  app.get("/ai-studio/formats", async () => {
    const video = await helpers.taskOptions("video");
    const models = formatVideoModels(video.models).map(specView);
    const ledger = ledgerOrFail(await deps.ledger.read());
    const view: GenerativeFormatsView = {
      formats: GENERATIVE_FORMATS.map((f) =>
        f.status === "available"
          ? {
              id: f.id,
              label: f.label,
              description: f.description,
              status: "available" as const,
              reason: null,
              why: null,
              narrationMissing: /narration/i.test(f.description) && !f.narration,
              preferredDurationSeconds: f.preferredDurationSeconds,
            }
          : f.status === "blocked"
            ? {
                id: f.id,
                label: f.label,
                description: f.description,
                status: "blocked" as const,
                reason: f.reason,
                why: f.why,
                narrationMissing: false,
                preferredDurationSeconds: null,
              }
            : {
                // Sprint 8: con voz o swap. El detalle, en `/ai-studio/speaking/options`.
                id: f.id,
                label: f.label,
                description: f.description,
                status: f.status,
                reason: null,
                why: null,
                narrationMissing: false,
                preferredDurationSeconds:
                  f.status === "speaking" ? f.preferredDurationSeconds : null,
              },
      ),
      video: {
        ...video,
        configured: video.configured && models.length > 0,
        defaultModel:
          video.defaultModel !== null && models.some((m) => m.id === video.defaultModel)
            ? video.defaultModel
            : (models[0]?.id ?? null),
        models,
      },
      budget: toBudgetView(budgetSummary(ledger, monthKey(now()), deps.env)),
    };
    return data(view);
  });

  // ── POST /ai-studio/formats/:format/estimate ──
  app.post(
    "/ai-studio/formats/:format/estimate",
    { schema: { params: formatParams, body: formatRunRequestSchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      formatOrFail(request.params.format);
      const input = await inputFor(
        request.tx,
        companyId,
        request.params.format,
        request.body,
      );
      const r = await estimateGenerativeFormatRun(depsFor(), input);
      if (!r.ok) throw rejectionToApi(r);
      const summary = budgetSummary(
        ledgerOrFail(await deps.ledger.read()),
        monthKey(now()),
        deps.env,
      );
      const view: FormatRunEstimateView = {
        provider: r.provider as FormatRunEstimateView["provider"],
        model: r.model,
        durationSeconds: r.durationSeconds,
        videoPrompt: r.videoPrompt,
        estimate: estimateView(r.estimate),
        budget: toBudgetView(summary),
        fits: fitsBudget(summary, r.estimate.usd),
      };
      return data(view);
    },
  );

  // ── POST /ai-studio/formats/:format/runs ──
  app.post(
    "/ai-studio/formats/:format/runs",
    {
      schema: {
        params: formatParams,
        querystring: formatRunQuery,
        body: formatRunRequestSchema,
      },
    },
    async (request, reply) => {
      if (app.deps.queue === undefined) {
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Generative formats are temporarily unavailable.",
          },
        });
      }
      const companyId = request.auth.companyId;
      formatOrFail(request.params.format);
      const input = await inputFor(
        request.tx,
        companyId,
        request.params.format,
        request.body,
        request.query.source,
      );
      const r = await startGenerativeFormatRun(depsFor(), input);
      if (!r.ok) throw rejectionToApi(r);
      request.log.info(
        {
          runId: r.run.id,
          format: r.run.formatId,
          model: r.generation.model,
          estimateUsd: r.estimate.usd,
        },
        "format run queued",
      );
      const [view] = await runViews(request.tx, companyId, [r.run]);
      return reply.status(202).send(data(view));
    },
  );

  // ── GET /ai-studio/format-runs ──
  app.get(
    "/ai-studio/format-runs",
    { schema: { querystring: generationListQuerySchema } },
    async (request) => {
      const companyId = request.auth.companyId;
      const limit = request.query.limit ?? DEFAULT_LIST_LIMIT;
      const records = (await runs.list(companyId))
        .map(parseFormatRunRecord)
        .filter((r): r is FormatRunRecord => r !== null && r.companyId === companyId)
        .sort((a, b) =>
          a.createdAt === b.createdAt
            ? b.id.localeCompare(a.id)
            : b.createdAt.localeCompare(a.createdAt),
        )
        .slice(0, limit);
      return data(await runViews(request.tx, companyId, records));
    },
  );

  // ── GET /ai-studio/format-runs/:id ──
  app.get(
    "/ai-studio/format-runs/:id",
    { schema: { params: idParams } },
    async (request) => {
      const companyId = request.auth.companyId;
      const { id } = request.params;
      if (!UUID.test(id)) throw notFound("format run");
      const record = parseFormatRunRecord(await runs.get(companyId, id));
      if (record === null || record.companyId !== companyId) throw notFound("format run");
      const [view] = await runViews(request.tx, companyId, [record]);
      return data(view);
    },
  );
}
