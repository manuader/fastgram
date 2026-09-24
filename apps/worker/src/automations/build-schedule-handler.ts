/**
 * Después del launch — `F-217`, `F-218`, PRD §9.5.12. Cola
 * `automation-build-schedule`, que existía en el catálogo sin handler.
 *
 * El launch (`POST /automations/:id/launch`) ya creó una pieza por slot con
 * su `content-build` y reservó un slot planificado por destino. Esto mira los
 * builds y mueve las dos máquinas de estados (`core/automations/lifecycle.ts`):
 *
 * - slot `QUEUED_BUILD`/`BUILDING` según su pieza: `SCHEDULED` cuando está
 *   `CREATED`, `FAILED` cuando falló (y se borran sus slots planificados: una
 *   pieza sin render no se publica);
 * - campaña `BUILDING` → `ACTIVE` (o `FAILED` si ninguna pieza salió);
 * - campaña `ACTIVE` → `COMPLETED` cuando pasó el último slot y no queda post
 *   pendiente.
 *
 * Cuando un slot llega a `SCHEDULED` encola el barrido de publicación de la
 * marca: es el que convierte los slots planificados en posts (con la
 * conexión y la caption del slot) — el mismo camino del piloto.
 *
 * ## Dos formas de job
 *
 * - `{companyId, automationId}`: lo encola el launch y se **re-arma** cada
 *   {@link AUTOMATION_BUILD_RECHECK_MS} mientras la campaña esté `BUILDING`.
 * - `{}`: el cron ({@link AUTOMATION_BUILD_SWEEP_CRON}) mira todas las campañas
 *   `BUILDING`/`ACTIVE` de todas las marcas. Es la red por si una cadena se
 *   corta (worker reiniciado) y lo que cierra las `ACTIVE`.
 */
import {
  AUTOMATION_BUILD_RECHECK_MS,
  AUTOMATION_PENDING_POST_STATUSES,
  JOB_QUEUES,
  automationBuildJobKey,
  automationStatusAfterBuilds,
  autopilotBrandJobKey,
  isAutomationComplete,
  parseAutomationBuildJob,
  slotStatusForContent,
  type AutomationSlotStatus,
  type AutomationStatus,
  type BuildContentStatus,
} from "@fastgram/core";
import {
  autopilotStore,
  automationStore,
  contentRepository,
  withCompany,
  withoutCompany,
  type Database,
  type Transaction,
} from "@fastgram/db";
import type { Clock, JobContext, JobHandler, Queue } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

/** Lo que tarda el barrido de publicación en ver una pieza recién `CREATED`. */
export const AUTOMATION_SWEEP_DELAY_MS = 5_000;

export interface AutomationBuildScheduleDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly clock: Clock;
  readonly queue: Queue;
  /** Si hay consumidor de `publishing-sweep`. */
  readonly publishingSweep: boolean;
}

export interface AutomationBuildRun {
  readonly status: string;
  readonly scheduled: number;
  readonly failed: number;
  readonly building: number;
}

export function createAutomationBuildScheduleHandler(
  deps: AutomationBuildScheduleDeps,
): JobHandler<unknown> {
  const roleOpt = deps.appRole === undefined ? {} : { role: deps.appRole };
  const inCompany = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>) =>
    withCompany(deps.db, companyId, fn, roleOpt);

  async function runAutomation(
    companyId: string,
    automationId: string,
  ): Promise<AutomationBuildRun | null> {
    const scope = { companyId };
    const nowMs = deps.clock.nowMs();
    const run = await inCompany(companyId, async (tx) => {
      const row = await automationStore.lock(tx, scope, automationId);
      if (row === null || (row.status !== "BUILDING" && row.status !== "ACTIVE"))
        return null;
      const slots = await automationStore.listSlots(tx, scope, automationId);
      let newlyScheduled = 0;
      const statuses: AutomationSlotStatus[] = [];
      for (const slot of slots) {
        let next: AutomationSlotStatus = slot.status;
        if (slot.status === "QUEUED_BUILD" || slot.status === "BUILDING") {
          const content =
            slot.contentId === null
              ? null
              : await contentRepository.findById(tx, scope, slot.contentId);
          const contentStatus: BuildContentStatus =
            content === null ? null : content.status;
          next = slotStatusForContent(slot.status, contentStatus);
          if (next !== slot.status) {
            await automationStore.updateSlot(tx, scope, slot.id, {
              status: next,
              ...(next === "FAILED" ? { errorCode: "build_failed" } : {}),
            });
            if (next === "FAILED")
              await automationStore.deletePlannedSlotsOf(tx, scope, [slot.id]);
            if (next === "SCHEDULED") newlyScheduled += 1;
          }
        }
        statuses.push(next);
      }

      let status: AutomationStatus = row.status;
      if (row.status === "BUILDING") {
        status = automationStatusAfterBuilds(row.status, statuses);
        if (status !== row.status) {
          await automationStore.update(tx, scope, automationId, {
            status,
            ...(status === "FAILED" ? { failureCode: "all_builds_failed" } : {}),
          });
        }
      }
      if (status === "ACTIVE") {
        const posts = await automationStore.postsOfSlots(
          tx,
          scope,
          slots.map((s) => s.id),
        );
        const pendingPosts = posts.filter((p) =>
          (AUTOMATION_PENDING_POST_STATUSES as readonly string[]).includes(p.status),
        ).length;
        const times = slots
          .filter((_, i) => statuses[i] === "SCHEDULED")
          .map((s) => s.scheduledAtUtc?.getTime())
          .filter((t): t is number => t !== undefined);
        if (
          isAutomationComplete({
            status,
            lastSlotAtMs: times.length === 0 ? null : Math.max(...times),
            pendingPosts,
            nowMs,
          })
        ) {
          status = "COMPLETED";
          await automationStore.update(tx, scope, automationId, {
            status,
            completedAt: new Date(nowMs),
          });
        }
      }
      return {
        status,
        scheduled: newlyScheduled,
        failed: statuses.filter((s) => s === "FAILED").length,
        building: statuses.filter((s) => s === "QUEUED_BUILD" || s === "BUILDING").length,
      };
    });
    if (run === null) return null;

    if (run.scheduled > 0 && deps.publishingSweep) {
      const at = new Date(nowMs + AUTOMATION_SWEEP_DELAY_MS);
      await deps.queue.enqueue({
        queue: JOB_QUEUES.publishingSweep,
        payload: { companyId },
        options: {
          startAfter: at,
          // Propia de las campañas y por ventana: no choca con las del piloto
          // ni con el re-armado del barrido.
          singletonKey: autopilotBrandJobKey(
            `${JOB_QUEUES.publishingSweep}:automation`,
            companyId,
            at.getTime(),
          ),
        },
      });
    }
    if (run.status === "BUILDING") {
      const at = new Date(nowMs + AUTOMATION_BUILD_RECHECK_MS);
      await deps.queue.enqueue({
        queue: JOB_QUEUES.automationBuildSchedule,
        payload: { companyId, automationId },
        options: {
          startAfter: at,
          singletonKey: automationBuildJobKey(
            JOB_QUEUES.automationBuildSchedule,
            automationId,
            at.getTime(),
          ),
        },
      });
    }
    return run;
  }

  async function sweep(jobId: string): Promise<void> {
    const brands = await withoutCompany(
      deps.db,
      (tx) => autopilotStore.listBrands(tx),
      roleOpt,
    );
    let looked = 0;
    for (const brand of brands) {
      const ids = await inCompany(brand.companyId, (tx) =>
        automationStore.idsInStatus(tx, { companyId: brand.companyId }, [
          "BUILDING",
          "ACTIVE",
        ]),
      );
      for (const id of ids) {
        await runAutomation(brand.companyId, id);
        looked += 1;
      }
    }
    deps.logger.info(
      { jobId, brands: brands.length, automations: looked },
      "barrido de campañas",
    );
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const job = parseAutomationBuildJob(ctx.payload);
    if (job === null) {
      deps.logger.error(
        { jobId: ctx.jobId },
        "payload de automation-build-schedule inválido",
      );
      return;
    }
    if (job.kind === "sweep") {
      await sweep(ctx.jobId);
      return;
    }
    const run = await runAutomation(job.companyId, job.automationId);
    deps.logger.info(
      {
        jobId: ctx.jobId,
        companyId: job.companyId,
        automationId: job.automationId,
        ...(run ?? {}),
      },
      run === null ? "campaña que ya no está en build ni activa" : "campaña: builds",
    );
  };
}
