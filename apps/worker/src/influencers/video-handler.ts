/**
 * Video del personaje — «Animate this image» (`F-099`, `FR-082`), sprint 7
 * (agente G). El trabajo `video` de la cola `influencer-pipeline`.
 *
 * ```
 *   fila de influencer_generations (kind video, queued | generating)
 *     └─ sin pedido ─► image-to-video de Higgsfield con `source_image_url`
 *                      (la API ya subió la imagen al storage de Higgsfield)
 *                      request_id + status_url se guardan ANTES del polling
 *   polling (receta de Higgsfield)
 *     └─ completed ─► descargar → storage (`media/<marca>/influencers/…`) →
 *                     `media` (Media Bank, sin categoría) → `influencer_assets`
 *                     (video) → set VIDEO del influencer → fila `ready` →
 *                     gasto cobrado
 *     └─ failed / nsfw ─► fila cerrada, reserva liberada
 * ```
 *
 * Mismas reglas de plata que las imágenes (`image-handler.ts`) y que AI
 * Studio: rechazo 4xx al enviar = liberar; fallo ambiguo = cobrado; nunca se
 * reenvía un pedido aceptado.
 *
 * **Por qué un set VIDEO**: `FR-082` (2), «el video generado queda asociado
 * al influencer y es elegible como fuente en Blitz». Blitz toma la media del
 * influencer de sus sets (`FR-083`); el de imágenes lo crea `image-handler`,
 * éste crea el de videos.
 */
import { canonicalObjectUrl } from "@fastgram/adapters";
import { BYTES_PER_MB } from "@fastgram/contracts";
import {
  INFLUENCER_MEDIA_CATEGORIES,
  generationErrorFromPort,
  influencerVideoSetName,
  influencerVideoStorageKey,
  isTerminalInfluencerGeneration,
  parseSpendLedger,
  pollDelayMs,
  releaseSpend,
  settleSpend,
  type GenerationError,
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
  type VideoGen,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import {
  RetryLater,
  higgsfieldConfig,
  type InfluencerCharacterMount,
  type InfluencerVideoMount,
} from "./image-handler.js";

const DEFAULT_POLL_BUDGET_MS = 25 * 60_000;
const DEFAULT_SUBMIT_RETRIES = 6;
const MAX_POLL_ERRORS = 8;
const DEFINITE_REJECTIONS = new Set([
  "bad_request",
  "unauthorized",
  "forbidden",
  "quota_exceeded",
  "not_found",
  "conflict",
]);
const EXTENSIONS: Readonly<Record<string, string>> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

type VideoJob = {
  readonly companyId: string;
  readonly influencerId: string;
  readonly generationId: string;
};

export function createInfluencerVideoHandler(deps: {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly clock: { nowMs(): number };
  readonly mount: InfluencerCharacterMount & InfluencerVideoMount;
}): (ctx: JobContext<unknown>, job: VideoJob) => Promise<void> {
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

  async function spend(month: string, id: string, how: "settle" | "release") {
    try {
      await mount.ledger.update((raw) => {
        const ledger = parseSpendLedger(raw);
        if (ledger === null) {
          log.error({ generationId: id }, "spend.json ilegible: no se toca");
          return { result: null };
        }
        const next =
          how === "settle"
            ? settleSpend(ledger, month, id)
            : releaseSpend(ledger, month, id);
        return next === null ? { result: null } : { next, result: null };
      });
    } catch (error) {
      log.error(
        { generationId: id, how, code: isPortError(error) ? error.code : "internal" },
        "no se pudo actualizar el gasto",
      );
    }
  }

  async function close(
    job: VideoJob,
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
      "video del influencer cerrado sin resultado",
    );
  }

  const portFailure = (error: unknown): GenerationError =>
    isPortError(error)
      ? { code: generationErrorFromPort(error.code), message: error.message }
      : { code: "provider_unavailable", message: "Higgsfield failed." };

  async function submit(
    client: VideoGen,
    request: Parameters<VideoGen["generateVideo"]>[0],
  ): Promise<GenSubmission> {
    const retries = mount.submitRateLimitRetries ?? DEFAULT_SUBMIT_RETRIES;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await client.generateVideo(request);
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
    client: VideoGen,
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

  async function store(
    job: VideoJob,
    meta: {
      prompt: string;
      model: string;
      aspectRatio: string;
      durationSeconds: number;
      influencerName: string;
    },
    outputs: GenJobState["outputs"],
  ): Promise<string[]> {
    const output = outputs[0];
    if (output === undefined) {
      throw new PortError("provider_contract_violation", "Higgsfield returned no video", {
        source: "worker/influencers",
      });
    }
    const media = await mount.downloadVideo(output.url);
    const contentType = (media.contentType || output.contentType || "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    const ext = contentType === undefined ? undefined : EXTENSIONS[contentType];
    if (ext === undefined || contentType === undefined) {
      throw new PortError(
        "provider_contract_violation",
        "Higgsfield returned a file that is not a video",
        { source: "worker/influencers", cause: contentType },
      );
    }
    const key = influencerVideoStorageKey({ ...job, ext });
    const stored = await mount.storage.put({ key, body: media.body, contentType });
    const row: BrandKitMediaInput = {
      mediaType: "video",
      filename: `${meta.influencerName.slice(0, 40)}-${job.generationId.slice(0, 8)}.${ext}`,
      r2Url: await canonicalObjectUrl(mount.storage, stored.key),
      storageKey: stored.key,
      sizeMb: stored.sizeBytes / BYTES_PER_MB,
      videoDurationSec: Math.round(meta.durationSeconds),
      categories: INFLUENCER_MEDIA_CATEGORIES,
    };
    return inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      await brandKitStore.lockCompanyBrandKit(tx, scope);
      await brandKitStore.insertBrandKitMedia(tx, scope, [row]);
      const page = await mediaRepository.list(tx, scope, {
        limit: 1,
        includeDeleted: true,
        filter: { storageKey: { eq: row.storageKey } },
      });
      const m = page.items[0];
      if (m === undefined) return [];

      const existing = await influencerAssetRepository.list(tx, scope, {
        limit: 1,
        filter: { influencerId: { eq: job.influencerId }, url: { eq: m.r2Url } },
      });
      if (existing.items.length === 0) {
        await influencerAssetRepository.create(tx, scope, {
          influencerId: job.influencerId,
          kind: "video",
          url: m.r2Url,
          prompt: meta.prompt,
          model: meta.model,
          aspect: meta.aspectRatio,
          durationSec: Math.round(meta.durationSeconds),
        });
      }

      // `FR-083`: el set VIDEO del influencer, que es lo que lee Blitz.
      const sets = await mediaSetRepository.list(tx, scope, {
        limit: 1,
        filter: { influencerId: { eq: job.influencerId }, kind: { eq: "VIDEO" } },
      });
      const set = sets.items[0];
      if (set === undefined) {
        await mediaSetRepository.create(tx, scope, {
          name: influencerVideoSetName(meta.influencerName),
          kind: "VIDEO",
          influencerId: job.influencerId,
          mediaIds: [m.mediaId],
        });
      } else if (!set.mediaIds.includes(m.mediaId)) {
        await mediaSetRepository.update(tx, scope, set.id, {
          mediaIds: [...set.mediaIds, m.mediaId],
        });
      }
      return [m.mediaId];
    });
  }

  return async function video(ctx, job): Promise<void> {
    const base = { jobId: ctx.jobId, generationId: job.generationId };
    const lastAttempt = ctx.attempt >= ctx.maxAttempts;
    const scope = { companyId: job.companyId };
    const loaded = await inCompany(job.companyId, async (tx) => ({
      gen: await influencerGenerationRepository.findById(tx, scope, job.generationId),
      inf: await influencerRepository.findById(tx, scope, job.influencerId),
    }));
    const gen = loaded.gen;
    if (gen === null || gen.influencerId !== job.influencerId || gen.kind !== "video") {
      log.warn(base, "pedido de video inexistente: nada que hacer");
      return;
    }
    if (isTerminalInfluencerGeneration(gen.status)) {
      log.info({ ...base, status: gen.status }, "pedido ya cerrado");
      return;
    }
    const month = gen.spendMonth;
    const accepted = gen.providerRequestId !== null;
    const inf = loaded.inf;
    if (inf === null || gen.sourceImageUrl === null || gen.durationSeconds === null) {
      await close(
        job,
        month,
        { code: "not_found", message: "The influencer or the image no longer exists." },
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
    let client: VideoGen;
    try {
      client = mount.videoClientFor(config);
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
          model: gen.model,
          prompt: gen.prompt,
          imageUrl: gen.sourceImageUrl,
          aspectRatio: gen.aspectRatio as GenAspectRatio,
          durationSeconds: gen.durationSeconds,
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
      log.info({ ...base, requestId: handle.requestId }, "Higgsfield aceptó el video");
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
          durationSeconds: gen.durationSeconds,
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
          message: "The video could not be copied to storage before retries ran out.",
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
    log.info({ ...base }, "video del influencer listo");
  };
}
