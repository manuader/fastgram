/**
 * Generación de campañas — `F-213`, `F-215`, `AI-012`, `P3-AUTO-004…007`.
 * Cola `automation-generation`, compartida con el piloto (ver
 * {@link createAutomationGenerationDispatcher} y `core/automations/jobs.ts`).
 *
 * ## Mismo pipeline que el refill y «crear desde prompt», a propósito
 *
 * Un slot `READY` tiene que ser **indistinguible** de una sugerencia de Blitz
 * salvo por dónde vive: mismo `build_plan`, misma copy, mismo build al
 * lanzar. Por eso no se reimplementa nada:
 *
 *  - **leer** es `readRefillSubject` (Media Bank, ángulos, perfil…);
 *  - **planificar** es `planAutomationSlot` de `core`: `planBlitzSuggestion`
 *    con el tipo del reparto exacto forzado y el **snapshot** como preferencias;
 *  - **escribir la copy** es `withCopy` del refill, con el tema de la campaña.
 *
 * ## Por tandas
 *
 * Una campaña de 4 semanas × 3/día son 84 slots; con un 7B local, 5–10 s cada
 * copy. Un job toma {@link AUTOMATION_GENERATION_BATCH} slots (`FOR UPDATE
 * SKIP LOCKED`, marcados `GENERATING`), los escribe uno por uno y encola la
 * tanda siguiente. Cuando no queda ninguno por generar, la campaña pasa a
 * `REVIEW`. Un slot `GENERATING` de un worker que murió vuelve a
 * `PENDING_GEN` pasado {@link AUTOMATION_STALE_GENERATING_MS}.
 *
 * ## Dedup y `FAILED_GEN`
 *
 * Cada copy se compara con lo ya usado por la marca (`judgeDuplicate`: ver
 * `core/automations/dedup.ts` por qué es léxico). Repetida → otra copy, hasta
 * {@link AUTOMATION_DEDUP_ATTEMPTS}; si todas repiten, `FAILED_GEN` con
 * `no_unique_content`. Sin media para el tipo, `FAILED_GEN` sin copiar:
 * `no_demo_video` (video-hook) o `errorCode = no_media`. **Nunca se cambia de
 * tipo** (`AI-012`): la campaña entrega menos posts.
 *
 * ## Cuota de la campaña
 *
 * Cada llamada a la copy suma 1 a `generationQuotaUsed`. Con la política
 * `enforced`, pasado `generationQuota` los slots que quedan fallan con
 * `errorCode = generation_quota_exhausted`; en modo personal (`D-06`) se
 * registra y no se corta.
 */
import { randomUUID } from "node:crypto";

import {
  AUTOMATION_DEDUP_ATTEMPTS,
  AUTOMATION_GENERATION_BATCH,
  AUTOMATION_STALE_GENERATING_MS,
  JOB_QUEUES,
  automationCampaignJobKey,
  defaultCaptions,
  dedupFingerprint,
  isAutomationCampaignPayload,
  isBlitzContentType,
  judgeDuplicate,
  mediaKeyOf,
  parseAutomationAccounts,
  parseAutomationCampaignJob,
  parsePrefsSnapshot,
  parseSuggestionBuildPlan,
  planAutomationSlot,
  platformsOf,
  selectionMediaIds,
  topicForSlot,
  type AutomationAccount,
  type AutomationCampaignJob,
  type AutomationPrefsSnapshot,
  type AutomationSlotFailureReason,
  type AutomationSuggestionData,
  type BlitzContentType,
  type UsedContent,
} from "@fastgram/core";
import {
  automationStore,
  withCompany,
  type AutomationRow,
  type AutomationSlotRow,
  type Database,
  type Transaction,
} from "@fastgram/db";
import {
  PortError,
  type Clock,
  type JobContext,
  type JobHandler,
  type Queue,
  type Rng,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import {
  readRefillSubject,
  withCopy,
  type CopywriterProvider,
  type RefillSubject,
} from "../discovery/refill-handler.js";

/** Cuánto del corpus de la marca se mira para el dedup, por fuente. */
export const AUTOMATION_DEDUP_CORPUS = 300;

export interface AutomationGenerationDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly clock: Clock;
  readonly queue: Queue;
  readonly rng: Rng;
  readonly copywriter: CopywriterProvider;
  /** `unlimited` en el modo personal (`D-06`): la cuota se registra y no corta. */
  readonly quotaPolicy: "enforced" | "unlimited";
  readonly batchSize?: number;
}

type SlotResult =
  | {
      readonly kind: "ready";
      readonly contentType: BlitzContentType;
      readonly data: AutomationSuggestionData;
      readonly generatedText: string;
      readonly attempts: number;
    }
  | {
      readonly kind: "failed";
      readonly failureReason: AutomationSlotFailureReason | null;
      readonly errorCode: string;
      readonly attempts: number;
    };

interface Campaign {
  readonly row: AutomationRow;
  readonly prefs: AutomationPrefsSnapshot;
  readonly accounts: readonly AutomationAccount[];
}

class RetryableLlmFailure extends Error {
  override readonly name = "RetryableLlmFailure";
  constructor(readonly portError: PortError) {
    super(portError.message);
  }
}

export function createAutomationCampaignHandler(
  deps: AutomationGenerationDeps,
): JobHandler<unknown> {
  const roleOpt = deps.appRole === undefined ? {} : { role: deps.appRole };
  const inCompany = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>) =>
    withCompany(deps.db, companyId, fn, roleOpt);
  const batch = deps.batchSize ?? AUTOMATION_GENERATION_BATCH;

  function campaignOf(row: AutomationRow): Campaign | null {
    const prefs = parsePrefsSnapshot(row.prefsSnapshot);
    const accounts = parseAutomationAccounts(row.accounts);
    if (prefs === null || accounts === null) return null;
    return { row, prefs, accounts };
  }

  async function enqueueNext(companyId: string, automationId: string, at?: Date) {
    await deps.queue.enqueue({
      queue: JOB_QUEUES.automationGeneration,
      payload: { companyId, automationId },
      options: {
        singletonKey: automationCampaignJobKey(
          JOB_QUEUES.automationGeneration,
          automationId,
          randomUUID(),
        ),
        ...(at === undefined ? {} : { startAfter: at }),
      },
    });
  }

  async function failCampaign(companyId: string, automationId: string, code: string) {
    await inCompany(companyId, async (tx) => {
      const scope = { companyId };
      const row = await automationStore.lock(tx, scope, automationId);
      if (row === null || row.status !== "GENERATING") return;
      await automationStore.update(tx, scope, automationId, {
        status: "FAILED",
        failureCode: code,
      });
      // Lo que no se llegó a generar no va a generarse: no produce post.
      for (const slot of await automationStore.listSlots(tx, scope, automationId)) {
        if (slot.status === "PENDING_GEN" || slot.status === "GENERATING") {
          await automationStore.updateSlot(tx, scope, slot.id, {
            status: "FAILED_GEN",
            errorCode: code,
            generatingSince: null,
          });
        }
      }
    });
  }

  /** Una pieza para un slot: plan → copy → dedup, hasta los intentos. */
  async function generateOne(args: {
    readonly campaign: Campaign;
    readonly subject: RefillSubject;
    readonly corpus: UsedContent[];
    readonly slot: AutomationSlotRow;
    readonly contentType: BlitzContentType;
    readonly copywriter: NonNullable<Awaited<ReturnType<CopywriterProvider>>>;
    readonly quotaLeft: () => boolean;
    readonly spend: () => void;
    readonly lastAttempt: boolean;
  }): Promise<SlotResult> {
    const { campaign, slot, contentType } = args;
    const topic = topicForSlot(campaign.prefs, slot.slotIndex);
    let attempts = 0;
    let lastReason: "duplicate" | "copy_rejected" | "llm_failed" = "copy_rejected";
    for (let i = 0; i < AUTOMATION_DEDUP_ATTEMPTS; i += 1) {
      const planned = planAutomationSlot(
        deps.rng,
        campaign.prefs,
        args.subject.planning,
        contentType,
      );
      if (!planned.ok) {
        return {
          kind: "failed",
          failureReason: planned.failureReason,
          errorCode: planned.errorCode,
          attempts,
        };
      }
      if (!args.quotaLeft()) {
        return {
          kind: "failed",
          failureReason: null,
          errorCode: "generation_quota_exhausted",
          attempts,
        };
      }
      attempts += 1;
      args.spend();
      let draft;
      try {
        draft = await withCopy(args.copywriter, args.subject, planned.planned, topic);
      } catch (error: unknown) {
        if (!(error instanceof PortError)) throw error;
        deps.logger.warn(
          { automationId: campaign.row.id, slotId: slot.id, code: error.code },
          "copy de campaña: el LLM falló",
        );
        // Transitorio con intentos por delante: la tanda entera se reintenta.
        if (error.isRetryable && !args.lastAttempt) throw new RetryableLlmFailure(error);
        lastReason = "llm_failed";
        continue;
      }
      if (!draft.ok) {
        lastReason = "copy_rejected";
        continue;
      }
      const plan = parseSuggestionBuildPlan(draft.draft.buildPlan, contentType);
      if (!plan.ok) {
        lastReason = "copy_rejected";
        continue;
      }
      const text = draft.draft.generatedText ?? "";
      const mediaKey = mediaKeyOf(selectionMediaIds(plan.plan.media));
      const verdict = judgeDuplicate({ text, mediaKey }, args.corpus);
      if (verdict.verdict === "duplicate") {
        lastReason = "duplicate";
        deps.logger.info(
          { automationId: campaign.row.id, slotId: slot.id, reason: verdict.reason },
          "copy de campaña repetida: se pide otra",
        );
        continue;
      }
      args.corpus.push({ text, mediaKey });
      return {
        kind: "ready",
        contentType,
        generatedText: text,
        attempts,
        data: {
          buildPlan: plan.plan,
          aiExplanation: draft.draft.aiExplanation,
          angleId: draft.draft.angleId,
          influencerId: draft.draft.influencerId,
          textStylePresetId: draft.draft.textStylePresetId,
          topic: topic ?? null,
          dedup: { fingerprint: dedupFingerprint(text), score: verdict.score },
        },
      };
    }
    return lastReason === "duplicate"
      ? {
          kind: "failed",
          failureReason: "no_unique_content",
          errorCode: "no_unique_content",
          attempts,
        }
      : { kind: "failed", failureReason: null, errorCode: lastReason, attempts };
  }

  /** Escribe el resultado si el slot sigue en `from`. Suma la cuota usada. */
  async function writeResult(
    companyId: string,
    campaign: Campaign,
    slot: AutomationSlotRow,
    result: SlotResult,
    from: "GENERATING" | "REROLLING",
  ): Promise<void> {
    await inCompany(companyId, async (tx) => {
      const scope = { companyId };
      if (result.attempts > 0)
        await automationStore.addQuotaUsed(tx, scope, campaign.row.id, result.attempts);
      if (result.kind === "ready") {
        await automationStore.updateSlot(
          tx,
          scope,
          slot.id,
          {
            status: "READY",
            contentType: result.contentType,
            suggestionData: result.data,
            generatedText: result.generatedText,
            captionsByPlatform: defaultCaptions(
              result.generatedText,
              platformsOf(campaign.accounts),
            ),
            failureReason: null,
            errorCode: null,
            dedupFingerprint: result.data.dedup.fingerprint,
            generationAttempts: slot.generationAttempts + result.attempts,
            generatingSince: null,
          },
          [from],
        );
      } else {
        await automationStore.updateSlot(
          tx,
          scope,
          slot.id,
          {
            status: "FAILED_GEN",
            failureReason: result.failureReason,
            errorCode: result.errorCode,
            // Re-roll destructivo e irrecuperable (`FR-150`): la sugerencia
            // vieja ya se descartó al pedirlo.
            suggestionData: null,
            generatedText: null,
            captionsByPlatform: {},
            dedupFingerprint: null,
            generationAttempts: slot.generationAttempts + result.attempts,
            generatingSince: null,
          },
          [from],
        );
      }
    });
  }

  async function prepare(companyId: string, excludeSlotId?: string) {
    return inCompany(companyId, async (tx) => {
      const subject = await readRefillSubject(tx, companyId);
      const used = await automationStore.usedTexts(
        tx,
        { companyId },
        {
          limit: AUTOMATION_DEDUP_CORPUS,
          ...(excludeSlotId === undefined ? {} : { excludeSlotId }),
        },
      );
      const corpus: UsedContent[] = used.map((u) => ({
        text: u.text,
        mediaKey: mediaKeyOf(u.mediaIds),
      }));
      return { subject, corpus };
    });
  }

  async function generate(
    ctx: JobContext<unknown>,
    job: Extract<AutomationCampaignJob, { kind: "generate" }>,
  ): Promise<void> {
    const { companyId, automationId } = job;
    const scope = { companyId };
    const base = { jobId: ctx.jobId, companyId, automationId };
    const nowMs = deps.clock.nowMs();

    const claimed = await inCompany(companyId, async (tx) => {
      const row = await automationStore.lock(tx, scope, automationId);
      if (row === null || row.status !== "GENERATING") return { row, slots: [] };
      await automationStore.releaseStaleGenerating(
        tx,
        scope,
        automationId,
        nowMs - AUTOMATION_STALE_GENERATING_MS,
      );
      const slots = await automationStore.claimPendingSlots(
        tx,
        scope,
        automationId,
        batch,
      );
      return { row, slots };
    });
    if (claimed.row === null || claimed.row.status !== "GENERATING") {
      deps.logger.info(
        { ...base, status: claimed.row?.status ?? null },
        "campaña que ya no está generando: nada que hacer",
      );
      return;
    }
    const campaign = campaignOf(claimed.row);
    if (campaign === null) {
      deps.logger.error({ ...base }, "campaña con snapshot o destinos ilegibles");
      await failCampaign(companyId, automationId, "invalid_state");
      return;
    }

    if (claimed.slots.length > 0) {
      const copywriter = await deps.copywriter();
      if (copywriter === null) {
        deps.logger.warn({ ...base }, "campaña sin LLM para `text`: queda FAILED");
        await failCampaign(companyId, automationId, "llm_not_configured");
        return;
      }
      const { subject, corpus } = await prepare(companyId);
      let used = claimed.row.generationQuotaUsed;
      const quota = claimed.row.generationQuota;
      const lastAttempt = ctx.attempt >= ctx.maxAttempts;
      for (const slot of claimed.slots) {
        const contentType = isBlitzContentType(slot.contentType)
          ? slot.contentType
          : null;
        if (contentType === null) {
          await writeResult(
            companyId,
            campaign,
            slot,
            {
              kind: "failed",
              failureReason: null,
              errorCode: "invalid_state",
              attempts: 0,
            },
            "GENERATING",
          );
          continue;
        }
        let result: SlotResult;
        try {
          result = await generateOne({
            campaign,
            subject,
            corpus,
            slot,
            contentType,
            copywriter,
            quotaLeft: () => deps.quotaPolicy === "unlimited" || used < quota,
            spend: () => {
              used += 1;
            },
            lastAttempt,
          });
        } catch (error: unknown) {
          if (error instanceof RetryableLlmFailure) {
            // Los tomados vuelven a la fila; la cola reintenta con backoff.
            await inCompany(companyId, async (tx) => {
              for (const s of claimed.slots) {
                await automationStore.updateSlot(
                  tx,
                  scope,
                  s.id,
                  { status: "PENDING_GEN", generatingSince: null },
                  ["GENERATING"],
                );
              }
            });
            throw error.portError;
          }
          throw error;
        }
        await writeResult(companyId, campaign, slot, result, "GENERATING");
      }
      deps.logger.info({ ...base, generated: claimed.slots.length }, "tanda de campaña");
    }

    // ¿Queda algo? Pendientes → otra tanda. Sólo `GENERATING` de otro → mirar
    // más tarde (puede ser un worker muerto). Nada → `REVIEW`.
    const left = await inCompany(companyId, async (tx) => ({
      pending: await automationStore.countSlotsIn(tx, scope, automationId, [
        "PENDING_GEN",
      ]),
      generating: await automationStore.countSlotsIn(tx, scope, automationId, [
        "GENERATING",
      ]),
    }));
    if (left.pending > 0) {
      await enqueueNext(companyId, automationId);
      return;
    }
    if (left.generating > 0) {
      await enqueueNext(
        companyId,
        automationId,
        new Date(deps.clock.nowMs() + AUTOMATION_STALE_GENERATING_MS + 60_000),
      );
      return;
    }
    const reviewed = await inCompany(companyId, async (tx) => {
      const row = await automationStore.lock(tx, scope, automationId);
      if (row === null || row.status !== "GENERATING") return false;
      await automationStore.update(tx, scope, automationId, { status: "REVIEW" });
      return true;
    });
    if (reviewed) deps.logger.info({ ...base }, "campaña generada: en revisión");
  }

  async function reroll(
    ctx: JobContext<unknown>,
    job: Extract<AutomationCampaignJob, { kind: "reroll" }>,
  ): Promise<void> {
    const { companyId, automationId, slotId } = job;
    const scope = { companyId };
    const base = { jobId: ctx.jobId, companyId, automationId, slotId };
    const loaded = await inCompany(companyId, async (tx) => ({
      row: await automationStore.find(tx, scope, automationId),
      slot: await automationStore.lockSlot(tx, scope, automationId, slotId),
    }));
    if (
      loaded.row === null ||
      loaded.slot === null ||
      loaded.slot.status !== "REROLLING"
    ) {
      deps.logger.info(
        { ...base },
        "re-roll sin efecto: el slot ya no está en REROLLING",
      );
      return;
    }
    const campaign = campaignOf(loaded.row);
    const slot = loaded.slot;
    const contentType =
      job.contentType ?? (isBlitzContentType(slot.contentType) ? slot.contentType : null);
    const fail = (
      errorCode: string,
      reason: AutomationSlotFailureReason | null = null,
    ) =>
      campaign === null
        ? Promise.resolve()
        : writeResult(
            companyId,
            campaign,
            slot,
            { kind: "failed", failureReason: reason, errorCode, attempts: 0 },
            "REROLLING",
          );
    if (campaign === null || contentType === null) {
      if (campaign === null) {
        await inCompany(companyId, (tx) =>
          automationStore.updateSlot(
            tx,
            scope,
            slot.id,
            { status: "FAILED_GEN", errorCode: "invalid_state" },
            ["REROLLING"],
          ),
        );
      } else await fail("invalid_state");
      return;
    }
    const copywriter = await deps.copywriter();
    if (copywriter === null) {
      await fail("llm_not_configured");
      return;
    }
    const { subject, corpus } = await prepare(companyId, slot.id);
    let used = loaded.row?.generationQuotaUsed ?? 0;
    const quota = loaded.row?.generationQuota ?? 0;
    let result: SlotResult;
    try {
      result = await generateOne({
        campaign,
        subject,
        corpus,
        slot,
        contentType,
        copywriter,
        quotaLeft: () => deps.quotaPolicy === "unlimited" || used < quota,
        spend: () => {
          used += 1;
        },
        lastAttempt: ctx.attempt >= ctx.maxAttempts,
      });
    } catch (error: unknown) {
      if (error instanceof RetryableLlmFailure) throw error.portError;
      throw error;
    }
    await writeResult(companyId, campaign, slot, result, "REROLLING");
    deps.logger.info({ ...base, result: result.kind }, "re-roll de slot");
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const job = parseAutomationCampaignJob(ctx.payload);
    if (job === null) {
      deps.logger.error({ jobId: ctx.jobId }, "payload de campaña inválido");
      return;
    }
    if (job.kind === "generate") await generate(ctx, job);
    else await reroll(ctx, job);
  };
}

/**
 * `automation-generation` atiende al piloto y a las campañas: con
 * `automationId`, campaña; sin él, exactamente lo que el piloto recibía antes.
 */
export function createAutomationGenerationDispatcher(handlers: {
  readonly campaign: JobHandler<unknown>;
  readonly autopilot?: JobHandler<unknown> | undefined;
  readonly logger: BuildLogger;
}): JobHandler<unknown> {
  return async (ctx) => {
    if (isAutomationCampaignPayload(ctx.payload)) {
      await handlers.campaign(ctx);
      return;
    }
    if (handlers.autopilot === undefined) {
      handlers.logger.warn(
        { jobId: ctx.jobId },
        "job del piloto sin piloto montado: se descarta",
      );
      return;
    }
    await handlers.autopilot(ctx);
  };
}
