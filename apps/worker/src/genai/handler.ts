/**
 * El handler de `ai-studio-generation` — `PU-LATER-005`, `PU-MODEL-003`/`004`/
 * `005`.
 *
 * ```
 *   leer el registro (queued | generating)
 *     └─ sin pedido al proveedor ─► enviar (bajo el semáforo del proveedor)
 *   polling con backoff (2 s × 1,5 hasta 10 s + jitter, receta de Higgsfield)
 *     └─ completed ─► descargar → storage (`media/<marca>/ai-studio/…`) →
 *                     filas de `media` (Media Bank) → registro `ready` →
 *                     gasto cobrado
 *     └─ failed / nsfw / canceled ─► registro cerrado, reserva liberada
 * ```
 *
 * ## Nunca se reenvía un pedido aceptado
 *
 * Ni Higgsfield ni fal aceptan una clave de idempotencia («Do not
 * automatically repeat a generation POST after an ambiguous timeout»,
 * `docs.higgsfield.ai/docs/concepts/errors`). Por eso:
 *
 * - En cuanto el proveedor acepta, el `request_id` y la URL de estado se
 *   escriben en el registro **antes** de hacer polling. Si el worker muere o
 *   el job vence, la próxima entrega **retoma el polling**, no reenvía.
 * - Un rechazo definitivo al enviar (4xx con respuesta) no se cobró: se
 *   cierra el registro y se libera la reserva. Un tope de concurrencia (400
 *   de Higgsfield, 429 de fal) se espera y se reintenta **dentro** del job.
 * - Un fallo **sin** respuesta clara (timeout, red, 5xx) puede haber sido
 *   aceptado: se cierra como fallido **y la reserva queda cobrada**. Para un
 *   tope es mejor contar de más que de menos. No se reenvía.
 *
 * ## La media va a nuestro storage
 *
 * Los resultados del proveedor expiran («at least seven days» en Higgsfield;
 * fal según su política de CDN). Se descargan y se suben con claves
 * deterministas (`media/<marca>/ai-studio/<id>-<n>.<ext>`), así una reentrega
 * no duplica filas (mismo lock y misma consulta que el kit de fondos).
 * Nacen `ready`, `origin = 'brand_kit'` (el origen generado que el Media Bank
 * lista) y ya categorizadas para Blitz.
 */
import { canonicalObjectUrl, type GenClient } from "@fastgram/adapters";
import { BYTES_PER_MB } from "@fastgram/contracts";
import {
  generationErrorFromPort,
  isTerminalGeneration,
  markFailed,
  markReady,
  markSubmitted,
  mediaCategoriesFor,
  parseAiStudioGenerationJob,
  parseGenerationRecord,
  parseSpendLedger,
  pollDelayMs,
  releaseSpend,
  resolveGenAiConfig,
  settleSpend,
  type GenerationError,
  type GenerationRecord,
  type ResolvedGenAiConfig,
  type SecretEnv,
  type SpendLedger,
} from "@fastgram/core";
import {
  brandKitStore,
  mediaRepository,
  withCompany,
  type BrandKitMediaInput,
  type Database,
  type Transaction,
} from "@fastgram/db";
import {
  isPortError,
  PortError,
  type GenJobHandle,
  type GenJobState,
  type GenOutput,
  type GenSubmission,
  type JobContext,
  type JobHandler,
  type ModelRegistry,
  type Storage,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { Semaphore } from "./semaphore.js";

/** Lo que el handler necesita del libro de gasto (`JsonFileDocument`). */
export interface SpendLedgerStore {
  read(): Promise<unknown>;
  update<T>(fn: (current: unknown) => { next?: unknown; result: T }): Promise<T>;
}

/** Lo que el handler necesita de las generaciones (`JsonFileCollection`). */
export interface GenerationStore {
  get(scope: string, id: string): Promise<unknown>;
  update<T>(
    scope: string,
    id: string,
    fn: (current: unknown) => { next?: unknown; result: T },
  ): Promise<T>;
}

export interface DownloadedMedia {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface AiStudioHandlerDeps {
  readonly db: Database;
  readonly storage: Storage;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly registry: ModelRegistry;
  /** Las variables que nombre un `apiKeyEnv` del registro. */
  readonly secrets: SecretEnv;
  readonly ledger: SpendLedgerStore;
  readonly generations: GenerationStore;
  readonly clientFor: (config: ResolvedGenAiConfig) => GenClient;
  readonly semaphoreFor: (provider: string) => Semaphore;
  readonly download: (url: string) => Promise<DownloadedMedia>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Cuánto se hace polling en **una** entrega antes de soltarla. */
  readonly pollBudgetMs?: number;
  /** Cuántas veces se espera un tope de concurrencia al enviar. */
  readonly submitRateLimitRetries?: number;
}

/** 25 min: por debajo de los 30 de `expireInSeconds` con que encola la API. */
const DEFAULT_POLL_BUDGET_MS = 25 * 60_000;
const DEFAULT_SUBMIT_RETRIES = 6;
/** Errores seguidos de polling (red, 5xx) antes de soltar la entrega. */
const MAX_POLL_ERRORS = 8;

/** Rechazos al enviar que **seguro** no se aceptaron (hubo respuesta 4xx). */
const DEFINITE_REJECTIONS = new Set([
  "bad_request",
  "unauthorized",
  "forbidden",
  "quota_exceeded",
  "not_found",
  "conflict",
]);

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

/** Una entrega que se suelta a propósito para que la cola la retome. */
class RetryLater extends Error {
  override readonly name = "RetryLater";
}

export function createAiStudioGenerationHandler(
  deps: AiStudioHandlerDeps,
): JobHandler<unknown> {
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
    record: GenerationRecord,
    change: (current: GenerationRecord) => GenerationRecord,
  ): Promise<GenerationRecord> {
    return deps.generations.update(record.companyId, record.id, (raw) => {
      const current = parseGenerationRecord(raw) ?? record;
      const next = change(current);
      return { next, result: next };
    });
  }

  /** Libera o cobra la reserva. Un libro ilegible se loguea, no tumba el job. */
  async function spend(
    record: GenerationRecord,
    how: "settle" | "release",
  ): Promise<void> {
    try {
      await deps.ledger.update((raw) => {
        const ledger: SpendLedger | null = parseSpendLedger(raw);
        if (ledger === null) {
          log.error({ generationId: record.id }, "spend.json ilegible: no se toca");
          return { result: null };
        }
        const next =
          how === "settle"
            ? settleSpend(ledger, record.spendMonth, record.id)
            : releaseSpend(ledger, record.spendMonth, record.id);
        return next === null ? { result: null } : { next, result: null };
      });
    } catch (error) {
      log.error(
        {
          generationId: record.id,
          how,
          code: isPortError(error) ? error.code : "internal",
        },
        "no se pudo actualizar el gasto",
      );
    }
  }

  async function close(
    record: GenerationRecord,
    error: GenerationError,
    spendAs: "settle" | "release",
    status?: "canceled",
  ): Promise<void> {
    const at = now().toISOString();
    await save(record, (cur) =>
      status === "canceled"
        ? { ...cur, status: "canceled", error, updatedAt: at }
        : markFailed(cur, error, at),
    );
    await spend(record, spendAs);
    log.info(
      { generationId: record.id, companyId: record.companyId, code: error.code, spendAs },
      "generación de AI Studio cerrada sin resultado",
    );
  }

  function portFailure(error: unknown): GenerationError {
    if (isPortError(error)) {
      return { code: generationErrorFromPort(error.code), message: error.message };
    }
    return { code: "provider_unavailable", message: "The generation provider failed." };
  }

  async function submit(
    client: GenClient,
    record: GenerationRecord,
  ): Promise<GenSubmission> {
    let attempt = 0;
    for (;;) {
      try {
        return record.kind === "image"
          ? await client.generateImage({
              model: record.model,
              prompt: record.prompt,
              aspectRatio: record.aspectRatio,
              n: record.count,
            })
          : await client.generateVideo({
              model: record.model,
              prompt: record.prompt,
              aspectRatio: record.aspectRatio,
              durationSeconds: record.durationSeconds ?? 0,
              ...(record.imageUrl === null ? {} : { imageUrl: record.imageUrl }),
            });
      } catch (error) {
        // El tope de concurrencia es un rechazo **antes** de aceptar: se espera.
        if (
          isPortError(error) &&
          error.code === "rate_limited" &&
          attempt < submitRetries
        ) {
          const wait =
            (error.retryAfterSeconds ?? 0) * 1000 || pollDelayMs(attempt + 1, random());
          attempt += 1;
          log.warn(
            { generationId: record.id, attempt, wait },
            "tope de concurrencia del proveedor",
          );
          await sleep(wait);
          continue;
        }
        throw error;
      }
    }
  }

  async function pollUntilTerminal(
    client: GenClient,
    handle: GenJobHandle,
  ): Promise<GenJobState> {
    const deadline = now().getTime() + pollBudgetMs;
    let attempt = 0;
    let errors = 0;
    for (;;) {
      await sleep(pollDelayMs(attempt, random()));
      attempt += 1;
      let state: GenJobState;
      try {
        state = await client.poll(handle);
        errors = 0;
      } catch (error) {
        const retryable = isPortError(error) ? error.isRetryable : true;
        if (!retryable) throw error;
        errors += 1;
        if (errors >= MAX_POLL_ERRORS) throw new RetryLater("too many polling errors");
        continue;
      }
      if (state.status === "completed" || state.status === "failed") return state;
      if (state.status === "nsfw" || state.status === "canceled") return state;
      if (now().getTime() > deadline) throw new RetryLater("poll budget exhausted");
    }
  }

  async function store(
    record: GenerationRecord,
    outputs: readonly GenOutput[],
  ): Promise<string[]> {
    const rows: BrandKitMediaInput[] = [];
    for (const [i, output] of outputs.entries()) {
      const media = await deps.download(output.url);
      const contentType = (media.contentType || output.contentType || "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      const ext = contentType === undefined ? undefined : EXTENSIONS[contentType];
      if (ext === undefined || !contentType?.startsWith(`${record.kind}/`)) {
        throw new PortError(
          "provider_contract_violation",
          "The provider returned a file that is not the expected media",
          { source: "worker/ai-studio", cause: contentType },
        );
      }
      const key = `media/${record.companyId}/ai-studio/${record.id}-${String(i + 1)}.${ext}`;
      const stored = await deps.storage.put({ key, body: media.body, contentType });
      rows.push({
        mediaType: record.kind,
        filename: `ai-studio-${record.id.slice(0, 8)}-${String(i + 1)}.${ext}`,
        r2Url: await canonicalObjectUrl(deps.storage, stored.key),
        storageKey: stored.key,
        sizeMb: stored.sizeBytes / BYTES_PER_MB,
        // El pedido, no un probe: el proveedor entrega la duración pedida.
        videoDurationSec:
          record.kind === "video" && record.durationSeconds !== null
            ? Math.round(record.durationSeconds)
            : null,
        categories: mediaCategoriesFor(record.kind),
      });
    }
    return inCompany(record.companyId, async (tx) => {
      const scope = { companyId: record.companyId };
      await brandKitStore.lockCompanyBrandKit(tx, scope);
      await brandKitStore.insertBrandKitMedia(tx, scope, rows);
      const page = await mediaRepository.list(tx, scope, {
        limit: Math.max(1, rows.length),
        includeDeleted: true,
        filter: { storageKey: { in: rows.map((r) => r.storageKey) } },
      });
      const byKey = new Map(page.items.map((m) => [m.storageKey, m.mediaId]));
      return rows.flatMap((r) => {
        const id = byKey.get(r.storageKey);
        return id === undefined ? [] : [id];
      });
    });
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseAiStudioGenerationJob(ctx.payload);
    if (!parsed.ok) {
      log.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de ai-studio inválido",
      );
      return;
    }
    const { companyId, generationId } = parsed.payload;
    const base = { jobId: ctx.jobId, companyId, generationId, attempt: ctx.attempt };
    const lastAttempt = ctx.attempt >= ctx.maxAttempts;

    const record = parseGenerationRecord(
      await deps.generations.get(companyId, generationId),
    );
    if (record === null || record.companyId !== companyId) {
      log.warn(base, "generación de AI Studio inexistente: nada que hacer");
      return;
    }
    if (isTerminalGeneration(record.status)) {
      log.info({ ...base, status: record.status }, "generación ya cerrada");
      return;
    }

    const config = resolveGenAiConfig(
      record.kind,
      await deps.registry.read(),
      deps.secrets,
    );
    if (config === null || config.provider !== record.provider) {
      // Sin pedido aceptado no se cobró nada; con pedido, el proveedor puede
      // haberlo cobrado y ya no hay cómo seguirlo: se deja cobrado.
      await close(
        record,
        {
          code: "not_configured",
          message: `The ${record.kind} model is no longer set up in Settings → Models.`,
        },
        record.providerRequest === null ? "release" : "settle",
      );
      return;
    }

    let client: GenClient;
    try {
      client = deps.clientFor(config);
    } catch (error) {
      await close(
        record,
        portFailure(error),
        record.providerRequest === null ? "release" : "settle",
      );
      return;
    }

    try {
      await deps.semaphoreFor(record.provider).run(async () => {
        let current = record as GenerationRecord;
        let handle: GenJobHandle | null =
          current.providerRequest === null
            ? null
            : {
                requestId: current.providerRequest.requestId,
                statusUrl: current.providerRequest.statusUrl,
                ...(current.providerRequest.responseUrl === null
                  ? {}
                  : { responseUrl: current.providerRequest.responseUrl }),
              };

        if (handle === null) {
          let submission: GenSubmission;
          try {
            submission = await submit(client, current);
          } catch (error) {
            const definite = isPortError(error) && DEFINITE_REJECTIONS.has(error.code);
            await close(current, portFailure(error), definite ? "release" : "settle");
            return;
          }
          if (submission.kind === "rejected") {
            await close(
              current,
              { code: "nsfw_rejected", message: submission.message },
              "release",
            );
            return;
          }
          const accepted = submission.handle;
          handle = accepted;
          current = await save(current, (cur) =>
            markSubmitted(
              cur,
              {
                requestId: accepted.requestId,
                statusUrl: accepted.statusUrl,
                responseUrl: accepted.responseUrl ?? null,
              },
              now().toISOString(),
            ),
          );
          log.info(
            {
              ...base,
              provider: current.provider,
              model: current.model,
              requestId: accepted.requestId,
            },
            "generación aceptada por el proveedor",
          );
        }

        let state: GenJobState;
        try {
          state = await pollUntilTerminal(client, handle);
        } catch (error) {
          if (error instanceof RetryLater && !lastAttempt) throw error;
          // Aceptado y sin saber cómo terminó: puede haberse cobrado.
          await close(
            current,
            error instanceof RetryLater
              ? { code: "timeout", message: "The provider did not finish in time." }
              : portFailure(error),
            "settle",
          );
          return;
        }

        if (state.status === "failed") {
          await close(
            current,
            { code: "generation_failed", message: state.message ?? "Generation failed" },
            "release",
          );
          return;
        }
        if (state.status === "nsfw") {
          await close(
            current,
            {
              code: "nsfw_rejected",
              message: state.message ?? "The provider's content filter rejected it",
            },
            "release",
          );
          return;
        }
        if (state.status === "canceled") {
          await close(
            current,
            { code: "generation_failed", message: "The provider canceled the request" },
            "release",
            "canceled",
          );
          return;
        }

        let mediaIds: string[];
        try {
          mediaIds = await store(current, state.outputs);
        } catch (error) {
          if (!lastAttempt) throw new RetryLater("download failed, retry");
          await close(
            current,
            {
              code: "download_failed",
              message:
                "The result could not be copied to storage before retries ran out.",
            },
            // Se generó bien: el proveedor lo cobró.
            "settle",
          );
          log.error(
            { ...base, code: isPortError(error) ? error.code : "internal" },
            "descarga fallida",
          );
          return;
        }
        await save(current, (cur) => markReady(cur, mediaIds, now().toISOString()));
        await spend(current, "settle");
        log.info({ ...base, media: mediaIds.length }, "generación de AI Studio lista");
      });
    } catch (error) {
      if (error instanceof RetryLater) {
        log.warn(
          { ...base, why: error.message },
          "generación de AI Studio: se retoma después",
        );
      }
      throw error;
    }
  };
}

/**
 * La descarga por defecto: `GET` https con timeout y tope de tamaño. Las URLs
 * salen de la respuesta del proveedor (su CDN), nunca del usuario.
 */
export function httpDownloader(options: {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly fetch?: typeof fetch;
}): (url: string) => Promise<DownloadedMedia> {
  const doFetch = options.fetch ?? fetch;
  return async (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PortError("provider_contract_violation", "Output URL is not a URL", {
        source: "worker/ai-studio",
      });
    }
    if (parsed.protocol !== "https:") {
      throw new PortError("provider_contract_violation", "Output URL is not https", {
        source: "worker/ai-studio",
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs);
    try {
      const res = await doFetch(parsed, { signal: controller.signal });
      if (!res.ok) {
        throw new PortError(
          "provider_unavailable",
          "The result could not be downloaded",
          {
            source: "worker/ai-studio",
            cause: `HTTP ${String(res.status)}`,
          },
        );
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        throw new PortError("bad_request", "The result is too large", {
          source: "worker/ai-studio",
        });
      }
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength > options.maxBytes) {
        throw new PortError("bad_request", "The result is too large", {
          source: "worker/ai-studio",
        });
      }
      return { body, contentType: res.headers.get("content-type") ?? "" };
    } catch (error) {
      if (isPortError(error)) throw error;
      throw new PortError(
        controller.signal.aborted ? "timeout" : "provider_unavailable",
        "The result could not be downloaded",
        { source: "worker/ai-studio", cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
