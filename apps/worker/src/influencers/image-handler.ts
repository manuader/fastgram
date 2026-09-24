/**
 * Imágenes del personaje — `PU-LATER-004`, `FR-081`. El trabajo `image` de la
 * cola `influencer-pipeline` (ver `jobs.ts` en `core`).
 *
 * ```
 *   leer la fila de influencer_generations (queued | generating)
 *     └─ sin pedido al proveedor ─► SOUL V2 con custom_reference_id
 *                                   (request_id + status_url se guardan ANTES
 *                                    del polling)
 *   polling con backoff (receta de Higgsfield)
 *     └─ completed ─► descargar → storage (`media/<marca>/influencers/…`) →
 *                     filas de `media` (Media Bank, sin categoría) →
 *                     `influencer_assets` → set SLIDESHOW del influencer →
 *                     fila `ready` → gasto cobrado
 *     └─ failed / nsfw ─► fila cerrada, reserva liberada
 * ```
 *
 * Mismas reglas de plata que `genai/handler.ts` (AI Studio), por las mismas
 * razones: un rechazo 4xx al enviar no se cobró (se libera); un fallo ambiguo
 * (timeout, 5xx) puede haberse aceptado y se deja **cobrado**; nunca se
 * reenvía un pedido aceptado.
 *
 * **Por qué sin categoría y con un set**: ver `INFLUENCER_MEDIA_CATEGORIES`.
 * Blitz las toma del set `SLIDESHOW` del influencer (`FR-083`), que este
 * handler crea la primera vez. Hasta ahora ninguna ruta creaba sets de
 * influencer, y por eso `influencerChance` nunca producía uno.
 */
import { canonicalObjectUrl } from "@fastgram/adapters";
import { BYTES_PER_MB } from "@fastgram/contracts";
import {
  INFLUENCER_CHARACTER_PROVIDER,
  INFLUENCER_MEDIA_CATEGORIES,
  generationErrorFromPort,
  influencerImageSetName,
  influencerImageStorageKey,
  isTerminalInfluencerGeneration,
  parseSpendLedger,
  pollDelayMs,
  releaseSpend,
  resolveGenAiConfig,
  settleSpend,
  type CharacterGen,
  type GenerationError,
  type ResolvedGenAiConfig,
  type SecretEnv,
} from "@fastgram/core";
import {
  brandKitStore,
  influencerAssetRepository,
  influencerGenerationRepository,
  influencerRepository,
  mediaRepository,
  mediaSetRepository,
  withCompany,
  type BrandKitMediaInput,
  type Database,
  type Transaction,
} from "@fastgram/db";
import {
  isPortError,
  PortError,
  type GenAspectRatio,
  type GenJobHandle,
  type GenJobState,
  type GenSubmission,
  type JobContext,
  type ModelRegistry,
  type ModelRegistrySnapshot,
  type Storage,
  type VideoGen,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { DownloadedMedia, SpendLedgerStore } from "../genai/handler.js";

/**
 * Sprint 7: lo que el video («Animate this image», `video-handler.ts`) agrega
 * al montaje. Vive acá y no allá para que no haya un ciclo de imports.
 */
export interface InfluencerVideoMount {
  readonly videoClientFor: (config: ResolvedGenAiConfig) => VideoGen;
  /** Baja el video del proveedor (https, con tope de tamaño). */
  readonly downloadVideo: (url: string) => Promise<DownloadedMedia>;
}

/** Lo que el trabajo real necesita. Lo arma `mount.ts`; los tests, dobles. */
export interface InfluencerCharacterMount {
  readonly storage: Storage;
  readonly registry: ModelRegistry;
  /** Las variables que nombre un `apiKeyEnv` del registro. */
  readonly secrets: SecretEnv;
  /** El mismo libro de gasto que AI Studio (`~/.fastgram/spend.json`). */
  readonly ledger: SpendLedgerStore;
  readonly clientFor: (config: ResolvedGenAiConfig) => CharacterGen;
  /** Baja una salida del proveedor (https, con tope de tamaño). */
  readonly download: (url: string) => Promise<DownloadedMedia>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Polling de una entrega de `image` antes de soltarla. Default 25 min. */
  readonly imagePollBudgetMs?: number;
  /** Polling de una entrega de `train` antes de soltarla. Default 40 min. */
  readonly trainPollBudgetMs?: number;
  /** Cuántas veces se espera un tope de concurrencia al enviar. Default 6. */
  readonly submitRateLimitRetries?: number;
  /** Sprint 7: «Animate this image» (`video-handler.ts`). Sin esto, no hay video. */
  readonly video?: InfluencerVideoMount;
}

/** Una entrega que se suelta a propósito para que la cola la retome. */
export class RetryLater extends Error {
  override readonly name = "RetryLater";
}

/** La configuración de Higgsfield, de la tarea de imagen o de la de video. */
export function higgsfieldConfig(
  snapshot: ModelRegistrySnapshot,
  secrets: SecretEnv,
): ResolvedGenAiConfig | null {
  for (const task of ["image", "video"] as const) {
    const config = resolveGenAiConfig(task, snapshot, secrets);
    if (config?.provider === INFLUENCER_CHARACTER_PROVIDER) return config;
  }
  return null;
}

/** Junta un objeto del storage en memoria. Las fotos son ≤ 10 MB (FR-100). */
export async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const DEFAULT_POLL_BUDGET_MS = 25 * 60_000;
const DEFAULT_SUBMIT_RETRIES = 6;
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
};

export interface InfluencerImageHandlerDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly clock: { nowMs(): number };
  readonly mount: InfluencerCharacterMount;
}

type ImageJob = {
  readonly companyId: string;
  readonly influencerId: string;
  readonly generationId: string;
};

export function createInfluencerImageHandler(
  deps: InfluencerImageHandlerDeps,
): (ctx: JobContext<unknown>, job: ImageJob) => Promise<void> {
  const { mount, logger: log } = deps;
  const sleep =
    mount.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const random = mount.random ?? Math.random;
  const nowMs = (): number => deps.clock.nowMs();

  const inCompany = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>) =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  async function spend(
    month: string,
    generationId: string,
    how: "settle" | "release",
  ): Promise<void> {
    try {
      await mount.ledger.update((raw) => {
        const ledger = parseSpendLedger(raw);
        if (ledger === null) {
          log.error({ generationId }, "spend.json ilegible: no se toca");
          return { result: null };
        }
        const next =
          how === "settle"
            ? settleSpend(ledger, month, generationId)
            : releaseSpend(ledger, month, generationId);
        return next === null ? { result: null } : { next, result: null };
      });
    } catch (error) {
      log.error(
        { generationId, how, code: isPortError(error) ? error.code : "internal" },
        "no se pudo actualizar el gasto",
      );
    }
  }

  async function close(
    job: ImageJob,
    month: string,
    error: GenerationError,
    spendAs: "settle" | "release",
  ): Promise<void> {
    await inCompany(job.companyId, (tx) =>
      influencerGenerationRepository.update(
        tx,
        { companyId: job.companyId },
        job.generationId,
        {
          status: error.code === "nsfw_rejected" ? "nsfw" : "failed",
          errorCode: error.code,
          errorMessage: error.message,
          updatedAt: new Date(nowMs()),
        },
      ),
    );
    await spend(month, job.generationId, spendAs);
    log.info(
      { generationId: job.generationId, code: error.code, spendAs },
      "imágenes del influencer cerradas sin resultado",
    );
  }

  function portFailure(error: unknown): GenerationError {
    if (isPortError(error)) {
      return { code: generationErrorFromPort(error.code), message: error.message };
    }
    return { code: "provider_unavailable", message: "Higgsfield failed." };
  }

  async function submit(
    client: CharacterGen,
    request: Parameters<CharacterGen["generateCharacterImage"]>[0],
  ): Promise<GenSubmission> {
    const retries = mount.submitRateLimitRetries ?? DEFAULT_SUBMIT_RETRIES;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.generateCharacterImage(request);
      } catch (error) {
        if (isPortError(error) && error.code === "rate_limited" && attempt < retries) {
          await sleep(
            (error.retryAfterSeconds ?? 0) * 1000 || pollDelayMs(attempt + 1, random()),
          );
          continue;
        }
        throw error;
      }
    }
  }

  async function pollUntilTerminal(
    client: CharacterGen,
    handle: GenJobHandle,
  ): Promise<GenJobState> {
    const deadline = nowMs() + (mount.imagePollBudgetMs ?? DEFAULT_POLL_BUDGET_MS);
    let errors = 0;
    for (let attempt = 0; ; attempt += 1) {
      await sleep(pollDelayMs(attempt, random()));
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
      if (
        state.status === "completed" ||
        state.status === "failed" ||
        state.status === "nsfw" ||
        state.status === "canceled"
      ) {
        return state;
      }
      if (nowMs() > deadline) throw new RetryLater("poll budget exhausted");
    }
  }

  /** Copia, Media Bank, assets y set. Idempotente por clave de storage. */
  async function store(
    job: ImageJob,
    meta: { prompt: string; model: string; aspectRatio: string; influencerName: string },
    outputs: GenJobState["outputs"],
  ): Promise<string[]> {
    const rows: BrandKitMediaInput[] = [];
    for (const [index, output] of outputs.entries()) {
      const media = await mount.download(output.url);
      const contentType = (media.contentType || output.contentType || "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      const ext = contentType === undefined ? undefined : EXTENSIONS[contentType];
      if (ext === undefined || contentType === undefined) {
        throw new PortError(
          "provider_contract_violation",
          "Higgsfield returned a file that is not an image",
          { source: "worker/influencers", cause: contentType },
        );
      }
      const key = influencerImageStorageKey({ ...job, index, ext });
      const stored = await mount.storage.put({ key, body: media.body, contentType });
      rows.push({
        mediaType: "image",
        filename: `${meta.influencerName.slice(0, 40)}-${job.generationId.slice(0, 8)}-${String(index + 1)}.${ext}`,
        r2Url: await canonicalObjectUrl(mount.storage, stored.key),
        storageKey: stored.key,
        sizeMb: stored.sizeBytes / BYTES_PER_MB,
        videoDurationSec: null,
        categories: INFLUENCER_MEDIA_CATEGORIES,
      });
    }
    return inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      // Mismo lock y misma inserción que el kit de fondos: una reentrega no
      // duplica filas de `media`.
      await brandKitStore.lockCompanyBrandKit(tx, scope);
      await brandKitStore.insertBrandKitMedia(tx, scope, rows);
      const page = await mediaRepository.list(tx, scope, {
        limit: Math.max(1, rows.length),
        includeDeleted: true,
        filter: { storageKey: { in: rows.map((r) => r.storageKey) } },
      });
      const byKey = new Map(page.items.map((m) => [m.storageKey, m]));
      const media = rows.flatMap((r) => {
        const m = byKey.get(r.storageKey);
        return m === undefined ? [] : [m];
      });
      const ids = media.map((m) => m.mediaId);

      // `DATA-014`: el asset del influencer (la galería de `FR-081`).
      const existing = await influencerAssetRepository.list(tx, scope, {
        limit: 100,
        filter: {
          influencerId: { eq: job.influencerId },
          url: { in: media.map((m) => m.r2Url) },
        },
      });
      const seen = new Set(existing.items.map((a) => a.url));
      await influencerAssetRepository.createMany(
        tx,
        scope,
        media
          .filter((m) => !seen.has(m.r2Url))
          .map((m) => ({
            influencerId: job.influencerId,
            kind: "image" as const,
            url: m.r2Url,
            prompt: meta.prompt,
            model: meta.model,
            aspect: meta.aspectRatio,
          })),
      );

      // `FR-083`: el set SLIDESHOW del influencer, que es lo que lee Blitz.
      const sets = await mediaSetRepository.list(tx, scope, {
        limit: 1,
        filter: { influencerId: { eq: job.influencerId }, kind: { eq: "SLIDESHOW" } },
      });
      const set = sets.items[0];
      if (set === undefined) {
        await mediaSetRepository.create(tx, scope, {
          name: influencerImageSetName(meta.influencerName),
          kind: "SLIDESHOW",
          influencerId: job.influencerId,
          mediaIds: ids,
        });
      } else {
        const merged = [...new Set([...set.mediaIds, ...ids])];
        if (merged.length !== set.mediaIds.length) {
          await mediaSetRepository.update(tx, scope, set.id, { mediaIds: merged });
        }
      }
      return ids;
    });
  }

  return async function image(ctx, job): Promise<void> {
    const base = { jobId: ctx.jobId, generationId: job.generationId };
    const lastAttempt = ctx.attempt >= ctx.maxAttempts;
    const scope = { companyId: job.companyId };
    const loaded = await inCompany(job.companyId, async (tx) => ({
      gen: await influencerGenerationRepository.findById(tx, scope, job.generationId),
      inf: await influencerRepository.findById(tx, scope, job.influencerId),
    }));
    const gen = loaded.gen;
    if (gen === null || gen.influencerId !== job.influencerId) {
      log.warn(base, "pedido de imágenes inexistente: nada que hacer");
      return;
    }
    if (isTerminalInfluencerGeneration(gen.status)) {
      log.info({ ...base, status: gen.status }, "pedido ya cerrado");
      return;
    }
    const month = gen.spendMonth;
    const accepted = gen.providerRequestId !== null;
    const inf = loaded.inf;
    if (inf?.soulId === null || inf === null) {
      await close(
        job,
        month,
        {
          code: "not_found",
          message: "The influencer or its character no longer exists.",
        },
        accepted ? "settle" : "release",
      );
      return;
    }

    const config = higgsfieldConfig(await mount.registry.read(), mount.secrets);
    if (config === null) {
      await close(
        job,
        month,
        {
          code: "not_configured",
          message: "Higgsfield is no longer set up in Settings → Models.",
        },
        accepted ? "settle" : "release",
      );
      return;
    }
    let client: CharacterGen;
    try {
      client = mount.clientFor(config);
    } catch (error) {
      await close(job, month, portFailure(error), accepted ? "settle" : "release");
      return;
    }

    let handle: GenJobHandle;
    if (gen.providerRequestId !== null && gen.providerStatusUrl !== null) {
      handle = { requestId: gen.providerRequestId, statusUrl: gen.providerStatusUrl };
    } else {
      let submission: GenSubmission;
      try {
        submission = await submit(client, {
          characterId: inf.soulId,
          prompt: gen.prompt,
          aspectRatio: gen.aspectRatio as GenAspectRatio,
          n: gen.count,
        });
      } catch (error) {
        const definite = isPortError(error) && DEFINITE_REJECTIONS.has(error.code);
        await close(job, month, portFailure(error), definite ? "release" : "settle");
        return;
      }
      if (submission.kind === "rejected") {
        await close(
          job,
          month,
          { code: "nsfw_rejected", message: submission.message },
          "release",
        );
        return;
      }
      handle = submission.handle;
      await inCompany(job.companyId, (tx) =>
        influencerGenerationRepository.update(tx, scope, job.generationId, {
          status: "generating",
          providerRequestId: submission.handle.requestId,
          providerStatusUrl: submission.handle.statusUrl,
          updatedAt: new Date(nowMs()),
        }),
      );
      log.info({ ...base, requestId: handle.requestId }, "Higgsfield aceptó el pedido");
    }

    let state: GenJobState;
    try {
      state = await pollUntilTerminal(client, handle);
    } catch (error) {
      if (error instanceof RetryLater && !lastAttempt) throw error;
      await close(
        job,
        month,
        error instanceof RetryLater
          ? { code: "timeout", message: "Higgsfield did not finish in time." }
          : portFailure(error),
        "settle",
      );
      return;
    }
    if (state.status === "failed" || state.status === "canceled") {
      await close(
        job,
        month,
        { code: "generation_failed", message: state.message ?? "Generation failed" },
        "release",
      );
      return;
    }
    if (state.status === "nsfw") {
      await close(
        job,
        month,
        {
          code: "nsfw_rejected",
          message: state.message ?? "Higgsfield's content filter rejected it",
        },
        "release",
      );
      return;
    }

    let mediaIds: string[];
    try {
      mediaIds = await store(
        job,
        {
          prompt: gen.prompt,
          model: gen.model,
          aspectRatio: gen.aspectRatio,
          influencerName: inf.name,
        },
        state.outputs,
      );
    } catch (error) {
      if (!lastAttempt) throw new RetryLater("download failed, retry");
      await close(
        job,
        month,
        {
          code: "download_failed",
          message: "The images could not be copied to storage before retries ran out.",
        },
        "settle",
      );
      log.error(
        { ...base, code: isPortError(error) ? error.code : "internal" },
        "descarga fallida",
      );
      return;
    }
    await inCompany(job.companyId, (tx) =>
      influencerGenerationRepository.update(tx, scope, job.generationId, {
        status: "ready",
        mediaIds,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(nowMs()),
      }),
    );
    await spend(month, job.generationId, "settle");
    log.info({ ...base, media: mediaIds.length }, "imágenes del influencer listas");
  };
}
