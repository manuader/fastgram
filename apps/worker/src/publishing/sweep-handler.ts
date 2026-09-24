/**
 * El barrido de publicación por marca — `PU-PUB-008` (`= P3-PUB-002`),
 * `FR-060` (`AWAITING_RECONNECT`), `NFR-015`, y la conversión de slots
 * planificados (`convertPlannedSlot`, sprint 2). Cola `publishing-sweep`.
 *
 * Dos cosas, las dos disparadas por lo mismo — **la marca tiene (otra vez)
 * una conexión activa**:
 *
 * 1. **Reanudar** los posts en `AWAITING_RECONNECT` cuya conexión volvió a
 *    `active`: vuelven a `SCHEDULED` con un job nuevo (`resumeAfterReconnect`
 *    de `@fastgram/core`: dentro de 24 h de su hora se reanudan; después,
 *    `FAILED` con `awaiting_reconnect_expired`).
 * 2. **Convertir los slots planificados** de redes que ya tienen **una**
 *    conexión activa en posts reales (`planSlotConversion`), con su job de
 *    publicación en la misma transacción (ADR-005). Un slot cuya hora ya pasó
 *    no se convierte: publicarlo «ya» sería un publicar-ahora que nadie pidió
 *    (mismo criterio que `convertPlannedSlot` de la API).
 *
 * ## Quién lo encola
 *
 * - El handler de `publishing`, al dejar un post en `AWAITING_RECONNECT`
 *   (para dentro de 30 min).
 * - **Él mismo**, cada 30 min, mientras la marca tenga posts esperando
 *   reconexión dentro del margen: así «se reanuda solo» aunque nadie avise
 *   que la conexión volvió.
 * - **El flujo de OAuth al conectar o reconectar** (otro agente,
 *   `apps/api/src/routes/v1/connections.ts`) debería encolar
 *   `{ companyId }` en `publishing-sweep` para que sea inmediato. Coordinado
 *   por nombre; hasta que lo haga, alcanza con el re-armado de 30 min para los
 *   posts, **pero no para los slots**: una marca que conecta por primera vez
 *   no tiene posts esperando, y nada arma el barrido. Está en el reporte.
 *
 * No hay cron: un cron necesitaría listar todas las marcas de todos los
 * dueños, y en `packages/db` no hay una consulta que cruce tenants para esto
 * (tampoco se escribe una desde el worker).
 */
import {
  POSTABLE_NETWORKS,
  planSlotConversion,
  resumeAfterReconnect,
  AWAITING_RECONNECT_GRACE_MS,
  type StrategyNetwork,
} from "@fastgram/core";
import {
  automationStore,
  connectionRepository,
  contentRepository,
  plannedSlotRepository,
  postPublishStore,
  postRepository,
  withCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";
import type { Clock, JobContext, JobHandler, Queue } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import {
  SWEEP_REARM_MS,
  firstPublishKey,
  parseSweepJob,
  publishJob,
  resumeKey,
  sweepJob,
} from "./jobs.js";

const DAY_MS = 86_400_000;
/** Cuánto hacia adelante se miran slots para convertir. */
export const SLOT_CONVERSION_HORIZON_DAYS = 60;

export interface SweepDeps {
  readonly db: Database;
  readonly queue: Queue;
  readonly clock: Clock;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  /**
   * Redes que pueden ser un `Post` hoy. Default `POSTABLE_NETWORKS` de
   * `@fastgram/core`, que todavía no incluye `x`/`threads`/`facebook`: ver el
   * reporte (se amplía cuando `0015` esté aplicada en todos lados).
   */
  readonly postableNetworks?: readonly StrategyNetwork[];
}

export interface SweepResult {
  readonly resumed: number;
  readonly expired: number;
  readonly stillWaiting: number;
  readonly converted: number;
}

export function createPublishingSweepHandler(deps: SweepDeps): JobHandler<unknown> {
  const inCompany = <T>(
    companyId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const job = parseSweepJob(ctx.payload);
    if (job === null) {
      deps.logger.error({ jobId: ctx.jobId }, "payload de publishing-sweep inválido");
      return;
    }
    const result = await sweepBrand(job.companyId);
    deps.logger.info(
      { jobId: ctx.jobId, companyId: job.companyId, ...result },
      "barrido de publicación",
    );

    if (result.stillWaiting > 0) {
      await deps.queue.enqueue(
        sweepJob(job.companyId, new Date(deps.clock.nowMs() + SWEEP_REARM_MS)),
      );
    }
  };

  async function sweepBrand(companyId: string): Promise<SweepResult> {
    const scope = { companyId };
    const nowMs = deps.clock.nowMs();

    const active = await inCompany(companyId, async (tx) => {
      const page = await connectionRepository.list(tx, scope, {
        limit: 100,
        filter: { status: { eq: "active" } },
      });
      return page.items;
    });
    const activeIds = new Set(active.map((c) => c.id));

    // 1 · AWAITING_RECONNECT
    const waiting = await inCompany(companyId, async (tx) => {
      const page = await postRepository.list(tx, scope, {
        limit: 100,
        filter: { status: { eq: "AWAITING_RECONNECT" } },
      });
      return page.items;
    });

    let resumed = 0;
    let expired = 0;
    let stillWaiting = 0;
    for (const candidate of waiting) {
      const decision = resumeAfterReconnect({
        scheduledAtMs: candidate.scheduledAtUtc.getTime(),
        nowMs,
      });
      const back =
        candidate.connectionId !== null && activeIds.has(candidate.connectionId);
      if (decision.kind === "expire") {
        const done = await inCompany(companyId, async (tx) => {
          const post = await postPublishStore.lockPost(tx, scope, candidate.id);
          if (post === null || post.status !== "AWAITING_RECONNECT") return false;
          await postRepository.update(tx, scope, candidate.id, {
            status: "FAILED",
            errorCode: "awaiting_reconnect_expired",
            errorMessage: `The account wasn't reconnected within ${String(
              AWAITING_RECONNECT_GRACE_MS / 3_600_000,
            )} hours of the scheduled time.`,
          });
          return true;
        });
        if (done) expired += 1;
        continue;
      }
      if (!back) {
        stillWaiting += 1;
        continue;
      }
      const done = await inCompany(companyId, async (tx) => {
        const post = await postPublishStore.lockPost(tx, scope, candidate.id);
        if (post === null || post.status !== "AWAITING_RECONNECT") return false;
        await postRepository.update(tx, scope, candidate.id, {
          status: "SCHEDULED",
          scheduledAtUtc: new Date(decision.atMs),
          errorCode: null,
          errorMessage: null,
        });
        await deps.queue.enqueue(
          publishJob(
            { companyId, postId: candidate.id },
            new Date(decision.atMs),
            resumeKey(candidate.id, decision.atMs),
            tx,
          ),
        );
        return true;
      });
      if (done) resumed += 1;
    }

    // 2 · slots planificados → posts
    const converted = await convertSlots(companyId, nowMs, active);

    return { resumed, expired, stillWaiting, converted };
  }

  async function convertSlots(
    companyId: string,
    nowMs: number,
    active: readonly {
      readonly id: string;
      readonly platform: string;
      readonly platformUsername: string;
    }[],
  ): Promise<number> {
    if (active.length === 0) return 0;
    const scope = { companyId };
    const postable = deps.postableNetworks ?? POSTABLE_NETWORKS;
    const slots = await inCompany(companyId, (tx) =>
      plannedSlotRepository.listInRange(tx, scope, {
        // Estrictamente futuro: un slot vencido no se publica «ya».
        fromMs: nowMs + 1,
        toMs: nowMs + SLOT_CONVERSION_HORIZON_DAYS * DAY_MS,
        limit: 100,
      }),
    );

    let converted = 0;
    for (const slot of slots) {
      // `FR-150`: un slot de campaña con conexión elegida se convierte con
      // **esa** conexión (si está activa y es de la red); si no, espera. Sin
      // conexión elegida (destino "planificado"), el criterio de siempre.
      const plan =
        slot.connectionId !== null
          ? active.some(
              (c) => c.id === slot.connectionId && c.platform === slot.network,
            ) && postable.includes(slot.network)
            ? ({
                kind: "convert",
                platform: slot.network,
                connectionId: slot.connectionId,
              } as const)
            : ({ kind: "wait" } as const)
          : planSlotConversion(
              slot.network,
              active.map((c) => ({ id: c.id, platform: c.platform })),
              postable,
            );
      if (plan.kind === "wait") continue;
      const connection = active.find((c) => c.id === plan.connectionId);

      try {
        const ok = await inCompany(companyId, async (tx) => {
          const content = await contentRepository.findById(tx, scope, slot.contentId);
          // Sólo piezas terminadas: un post en `BUILDING` no tiene quién lo
          // pase a `SCHEDULED` cuando la pieza termina.
          if (content === null || content.status !== "CREATED") return false;
          const campaign =
            slot.automationSlotId === null
              ? null
              : await campaignPostFields(
                  tx,
                  companyId,
                  slot.automationSlotId,
                  plan.platform,
                );
          const post = await postRepository.create(tx, scope, {
            contentId: slot.contentId,
            platform: plan.platform,
            accountType: "oauth",
            connectionId: plan.connectionId,
            connectionUsername: connection?.platformUsername ?? null,
            scheduledAtUtc: slot.scheduledAtUtc,
            status: "SCHEDULED",
            ...(campaign ?? {}),
          });
          const closed = await plannedSlotRepository.markConverted(
            tx,
            scope,
            slot.id,
            post.id,
          );
          // Otra conversión lo cerró entre la lectura y acá: abortar deshace el post.
          if (closed === null) throw new SlotAlreadyConverted();
          if (slot.automationSlotId !== null) {
            await automationStore.appendPostId(tx, scope, slot.automationSlotId, post.id);
          }
          await deps.queue.enqueue(
            publishJob(
              { companyId, postId: post.id },
              slot.scheduledAtUtc,
              firstPublishKey(post.id),
              tx,
            ),
          );
          return true;
        });
        if (ok) converted += 1;
      } catch (error: unknown) {
        if (error instanceof SlotAlreadyConverted) continue;
        throw error;
      }
    }
    return converted;
  }
}

/**
 * Lo que un post de campaña lleva del slot y de la campaña (`FR-150`): la
 * caption de **esa** red (para YouTube, título + descripción), el vínculo al
 * slot, y las etiquetas de la campaña. `null` si el slot ya no está (la
 * campaña se borró): se publica como un slot planificado cualquiera.
 */
async function campaignPostFields(
  tx: Transaction,
  companyId: string,
  automationSlotId: string,
  platform: string,
): Promise<{
  automationSlotId: string;
  caption: string | null;
  description: string | null;
  aiContentDisclaimer: boolean;
  discloseAsAds: boolean;
  postingMode: "inbox" | "direct" | null;
} | null> {
  const found = await automationStore.slotWithAutomation(
    tx,
    { companyId },
    automationSlotId,
  );
  if (found === null) return null;
  const captions = found.slot.captionsByPlatform;
  const entry =
    captions !== null && typeof captions === "object" && !Array.isArray(captions)
      ? (captions as Record<string, unknown>)[platform]
      : undefined;
  const record =
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
  const caption = typeof record["caption"] === "string" ? record["caption"] : null;
  const description =
    typeof record["description"] === "string" ? record["description"] : null;
  return {
    automationSlotId,
    caption: caption ?? found.slot.generatedText,
    description,
    aiContentDisclaimer: found.automation.aiContentDisclaimer,
    discloseAsAds: found.automation.discloseAsAds,
    postingMode: platform === "tiktok" ? found.automation.postingMode : null,
  };
}

class SlotAlreadyConverted extends Error {
  override readonly name = "SlotAlreadyConverted";
}
