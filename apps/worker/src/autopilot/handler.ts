/**
 * El piloto automático — `PU-AUTO-001` (generación continua) y `PU-AUTO-002`
 * (pre-chequeo → aprobación → calendario). Cola `automation-generation`
 * (§9.5.11), que existía en el catálogo sin handler y se reusa: es "generar
 * contenido para una automatización", y el piloto es exactamente eso por
 * marca. `automation-build-schedule` sigue sin handler.
 *
 * ## Dos formas de job
 *
 * ```
 *   cron cada 15'  →  {}        barrido: lista las marcas y encola una por marca
 *                 {companyId}   corrida de una marca:
 *                                 1. cola de Blitz al objetivo de su estrategia
 *                                 2. si está en `autopilot`: juzgar y aprobar
 *                                 3. estado de la corrida (`autopilot_runs`)
 * ```
 *
 * La corrida por marca lleva `singletonKey` con un cubo de 15 min
 * (`autopilotBrandJobKey`): un barrido que se repite en la ventana no duplica,
 * y la ventana siguiente es una clave nueva (trampas 39 y 45).
 *
 * ## 1 · La cola al objetivo (`PU-AUTO-001`)
 *
 * El objetivo sale de la estrategia (`autopilotQueueTarget`: piezas/día × redes
 * × 2 días, entre 5 y 30). El relleno **es el de siempre**
 * (`createDiscoveryRefillHandler`) llamado en proceso con ese objetivo: mismo
 * lock por workspace, misma convergencia ("lleva la cola a N", no "inserta
 * N"), misma copy. No se encola un `discovery-refill` porque su payload no
 * lleva objetivo y cambiarlo es de otra área; el refill que pide `GET
 * /blitz/queue` (objetivo 5) y éste conviven porque los dos convergen.
 *
 * Sin LLM para `text` no hay nada que hacer —una sugerencia sin copy no se
 * construye— y el barrido lo dice **una vez** por proceso (y otra vez si el
 * LLM vuelve y se va).
 *
 * ## 2 · El piloto (`PU-AUTO-002`)
 *
 * Sólo marcas con `autonomy = autopilot`. Toma las `queued` más viejas (sin
 * las de «crear desde prompt», que el humano está esperando en el deck), y por
 * cada una corre el pre-chequeo `JV-3` (`@fastgram/core`, `judgment/preflight.ts`):
 *
 * - **aprueba** → acepta (pieza en `BUILDING`, build encolado) y la agenda en
 *   slots planificados, en **una** transacción con la decisión registrada;
 * - **rechaza** → la descarta, con los motivos en `autopilot_decisions`;
 * - **no responde** (timeout duro o proveedor caído) → queda `queued` para
 *   revisión manual, con una decisión `held` que evita que el piloto la vuelva
 *   a tomar. **Nunca se aprueba algo que no se juzgó.** Y la corrida corta
 *   ahí: si el juicio está caído, seguir es gastar timeouts.
 *
 * Cupo: no se aprueban más piezas que las que la estrategia publica en el
 * horizonte (`autopilotAcceptCapacity`), ni se juzgan más de
 * `AUTOPILOT_MAX_DECISIONS_PER_RUN` por corrida.
 *
 * ## Lo que este handler no hace
 *
 * - **Publicar.** Agenda slots; el barrido de publicación (`publishing-sweep`)
 *   los convierte en posts cuando la pieza terminó de construirse y la marca
 *   tiene la conexión. Se le encola uno después de aprobar.
 * - **Resolver dos corridas solapadas de la misma marca** más allá de lo que
 *   garantizan el `FOR UPDATE` de la sugerencia y el `UNIQUE (suggestion_id)`:
 *   dos corridas simultáneas no aprueban dos veces la misma pieza, pero sí
 *   podrían pasarse del cupo en una pieza. Con el cubo de 15 min y un job que
 *   dura segundos, no pasa en la práctica.
 */
import {
  AUTOPILOT_HORIZON_DAYS,
  AUTOPILOT_MAX_DECISIONS_PER_RUN,
  AUTOPILOT_PRECHECK_TIMEOUT_MS,
  JOB_QUEUES,
  PRECHECK_VERSION,
  autopilotAcceptCapacity,
  autopilotBrandJobKey,
  autopilotQueueTarget,
  buildPrecheckState,
  decideAutopilot,
  isDomainError,
  parseAutopilotJob,
  type AutopilotDecision,
  type PrecheckOutcome,
} from "@fastgram/core";
import {
  autopilotStore,
  brandStrategyRepository,
  companyProfileRepository,
  companyRepository,
  discardQueuedSuggestion,
  discoveryQueueStore,
  lockSuggestionById,
  withCompany,
  withoutCompany,
  type AutopilotRunOutcome,
  type Database,
  type SuggestionRow,
  type Transaction,
} from "@fastgram/db";
import type { Clock, JobContext, JobHandler, Queue, Rng } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import {
  createDiscoveryRefillHandler,
  type CopywriterProvider,
} from "../discovery/refill-handler.js";
import { acceptForAutopilot, type AutopilotQuotaPolicy } from "./accept.js";
import { askPrecheck, type JudgmentProvider } from "./judgment.js";
import { occupiedOf, scheduleForAutopilot, type ScheduledSlot } from "./schedule.js";
import { parseAutopilotStrategy, type AutopilotStrategy } from "./strategy.js";

const DAY_MS = 86_400_000;
/** Cuánto esperar antes del barrido de publicación tras aprobar: lo que tarda un build. */
export const AUTOPILOT_SWEEP_DELAY_MS = 3 * 60_000;
const EXCERPT_CHARS = 140;

export const AUTOPILOT_WITHOUT_LLM_WHY =
  "no hay LLM para la tarea `text` (Settings → Models): el piloto no genera ni " +
  "aprueba nada hasta que haya uno";

export interface AutopilotDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly clock: Clock;
  readonly queue: Queue;
  readonly rng: Rng;
  /** La copy del refill, resuelta en cada corrida. `null` = sin LLM. */
  readonly copywriter: CopywriterProvider;
  readonly judgment: JudgmentProvider;
  /** `unlimited` en el modo personal (`D-06`). */
  readonly quotaPolicy: AutopilotQuotaPolicy;
  /**
   * Modo personal: la separación entre marcas mira todas las del dueño (igual
   * que la API). Fuera de él, cada marca es su propio dueño.
   */
  readonly personal: boolean;
  /** Si hay consumidor de `publishing-sweep` al que encolarle el barrido. */
  readonly publishingSweep: boolean;
  readonly precheckTimeoutMs?: number;
  readonly horizonDays?: number;
  readonly maxDecisionsPerRun?: number;
  readonly onMediaBankEmpty?: ((companyId: string) => Promise<void>) | undefined;
  /** Sólo tests: reemplaza el refill real (que necesita Media Bank y copy). */
  readonly refill?: (companyId: string, target: number) => Promise<void>;
}

export interface BrandRunResult {
  readonly outcome: AutopilotRunOutcome;
  readonly queueTarget: number;
  readonly queued: number;
  readonly approved: number;
  readonly rejected: number;
  readonly held: number;
}

export function createAutopilotHandler(deps: AutopilotDeps): JobHandler<unknown> {
  const roleOpt = deps.appRole === undefined ? {} : { role: deps.appRole };
  const inCompany = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>) =>
    withCompany(deps.db, companyId, fn, roleOpt);
  const horizon = deps.horizonDays ?? AUTOPILOT_HORIZON_DAYS;
  const maxDecisions = deps.maxDecisionsPerRun ?? AUTOPILOT_MAX_DECISIONS_PER_RUN;
  const timeoutMs = deps.precheckTimeoutMs ?? AUTOPILOT_PRECHECK_TIMEOUT_MS;
  let warnedNoLlm = false;

  const refill =
    deps.refill ??
    (async (companyId: string, target: number): Promise<void> => {
      const handler = createDiscoveryRefillHandler({
        db: deps.db,
        rng: deps.rng,
        copywriter: deps.copywriter,
        appRole: deps.appRole,
        logger: deps.logger,
        targetQueuedItems: target,
        onMediaBankEmpty: deps.onMediaBankEmpty,
      });
      await handler({
        jobId: `autopilot-refill:${companyId}`,
        payload: { companyId },
        attempt: 1,
        maxAttempts: 1,
      });
    });

  async function hasTextLlm(): Promise<boolean> {
    const found = (await deps.copywriter()) !== null;
    if (!found && !warnedNoLlm) {
      warnedNoLlm = true;
      deps.logger.warn(
        { cola: JOB_QUEUES.automationGeneration },
        AUTOPILOT_WITHOUT_LLM_WHY,
      );
    }
    if (found) warnedNoLlm = false;
    return found;
  }

  async function sweep(jobId: string): Promise<void> {
    if (!(await hasTextLlm())) return;
    const brands = await withoutCompany(
      deps.db,
      (tx) => autopilotStore.listBrands(tx),
      roleOpt,
    );
    const nowMs = deps.clock.nowMs();
    let enqueued = 0;
    for (const brand of brands) {
      // Sólo las que guardaron estrategia: sin fila no hay frecuencia de la
      // que derivar un objetivo, y la cola de 5 ya la pide `GET /blitz/queue`.
      if (brand.autonomy === null) continue;
      const { created } = await deps.queue.enqueue({
        queue: JOB_QUEUES.automationGeneration,
        payload: { companyId: brand.companyId },
        options: {
          singletonKey: autopilotBrandJobKey(
            JOB_QUEUES.automationGeneration,
            brand.companyId,
            nowMs,
          ),
        },
      });
      if (created) enqueued += 1;
    }
    deps.logger.info({ jobId, brands: brands.length, enqueued }, "barrido del piloto");
  }

  async function saveRun(companyId: string, result: BrandRunResult): Promise<void> {
    await inCompany(companyId, (tx) =>
      autopilotStore.saveRun(
        tx,
        { companyId },
        {
          lastRunAt: new Date(deps.clock.nowMs()),
          ...result,
        },
      ),
    );
  }

  async function runBrand(
    jobId: string,
    companyId: string,
  ): Promise<BrandRunResult | null> {
    const scope = { companyId };
    const base = { jobId, companyId };

    const loaded = await inCompany(companyId, async (tx) => {
      const row = await brandStrategyRepository.find(tx, scope);
      const timezone = (await brandStrategyRepository.timezone(tx, scope)) ?? "UTC";
      const profile = (await companyProfileRepository.list(tx, scope, { limit: 1 }))
        .items[0];
      const company = await companyRepository.load(tx, scope);
      return { row, timezone, profile, name: company?.name ?? "" };
    });
    // Sin fila: la marca borró su estrategia (o la company no se ve) entre el
    // barrido y acá. No hay nada que mantener.
    if (loaded.row === null) return null;

    const strategy = parseAutopilotStrategy(loaded.row, loaded.timezone);
    const counts = { approved: 0, rejected: 0, held: 0 };
    const finish = async (
      outcome: AutopilotRunOutcome,
      queueTarget: number,
    ): Promise<BrandRunResult> => {
      const queued = await inCompany(companyId, (tx) =>
        discoveryQueueStore.countQueued(tx, scope),
      );
      const result = { outcome, queueTarget, queued, ...counts };
      await saveRun(companyId, result);
      deps.logger.info({ ...base, ...result }, "corrida del piloto");
      return result;
    };

    if (strategy === null) {
      deps.logger.error(
        { ...base },
        "estrategia ilegible: el piloto no corre sobre ella",
      );
      return finish("invalid_strategy", 0);
    }
    const target = autopilotQueueTarget(strategy.networks, horizon);

    if (!(await hasTextLlm())) return finish("no_llm", target);

    // 1 · la cola al objetivo. Un fallo del LLM no tira la corrida: el piloto
    // juzga lo que ya hay en la cola.
    try {
      await refill(companyId, target);
    } catch (error: unknown) {
      deps.logger.warn(
        { ...base, reason: error instanceof Error ? error.message : String(error) },
        "el relleno de la cola falló; el piloto sigue con lo que hay",
      );
    }

    if (strategy.autonomy !== "autopilot") return finish("manual", target);

    // Mismo criterio que `POST /blitz` (PRD:1023 + decisión 2026-09-24).
    const status = loaded.profile?.status;
    if (status !== "ready" && status !== "partial")
      return finish("profile_not_ready", target);

    // 2 · el piloto
    const nowMs = deps.clock.nowMs();
    const owner = await ownerOf(companyId);
    const own = await inCompany(companyId, (tx) =>
      occupiedOf(tx, companyId, nowMs, nowMs + horizon * DAY_MS),
    );
    const capacity = autopilotAcceptCapacity({
      networks: strategy.networks,
      nowMs,
      scheduled: own,
      horizonDays: horizon,
    });
    if (capacity === 0) return finish("ran", target);

    const candidates = await inCompany(companyId, (tx) =>
      autopilotStore.listCandidates(tx, scope, { limit: maxDecisions }),
    );

    let judgedAny = false;
    for (const candidate of candidates) {
      if (counts.approved >= capacity) break;
      const judgment = await deps.judgment({ companyId, suggestionId: candidate.id });
      if (judgment === null) {
        if (!judgedAny) return finish("no_judgment", target);
        break;
      }
      judgedAny = true;

      const state = buildPrecheckState({
        caption: candidate.generatedText ?? "",
        contentType: candidate.contentType,
        language: strategy.language,
        brandName: loaded.name,
        profile: loaded.profile ?? {},
      });
      const run = await askPrecheck(judgment, state, timeoutMs, () => deps.clock.nowMs());
      const decision = decideAutopilot(run.outcome);
      const details = decisionDetails(candidate, run.outcome, decision, run);

      if (decision.kind === "hold") {
        const recorded = await inCompany(companyId, (tx) =>
          autopilotStore.recordDecision(tx, scope, {
            suggestionId: candidate.id,
            decision: "held",
            reason: decision.reason,
            contentId: null,
            details,
          }),
        );
        if (recorded) counts.held += 1;
        deps.logger.warn(
          { ...base, suggestionId: candidate.id, reason: decision.reason },
          "el juicio no respondió: la pieza queda en la cola para revisión manual",
        );
        // El juicio está caído o lento: seguir es gastar timeouts.
        break;
      }

      if (decision.kind === "reject") {
        if (
          await rejectCandidate(
            companyId,
            candidate.id,
            decision.reasons[0] ?? null,
            details,
          )
        )
          counts.rejected += 1;
        continue;
      }

      const approved = await approveCandidate({
        companyId,
        candidate,
        strategy,
        owner,
        details,
      });
      if (approved === "approved") counts.approved += 1;
      else if (approved === "rejected") counts.rejected += 1;
      else if (approved === "quota") break;
    }

    if (counts.approved > 0 && deps.publishingSweep) {
      const at = new Date(deps.clock.nowMs() + AUTOPILOT_SWEEP_DELAY_MS);
      await deps.queue.enqueue({
        queue: JOB_QUEUES.publishingSweep,
        payload: { companyId },
        options: {
          startAfter: at,
          // Propia del piloto y por ventana de 15 min: no choca con las claves
          // del re-armado del barrido (`publishing/jobs.ts`), y no se repite.
          singletonKey: autopilotBrandJobKey(
            `${JOB_QUEUES.publishingSweep}:autopilot`,
            companyId,
            at.getTime(),
          ),
        },
      });
    }
    return finish("ran", target);
  }

  /** Descarta y registra, en una transacción. `false` si otro ya la tocó. */
  async function rejectCandidate(
    companyId: string,
    suggestionId: string,
    reason: string | null,
    details: Record<string, unknown>,
  ): Promise<boolean> {
    const scope = { companyId };
    return inCompany(companyId, async (tx) => {
      const row = await lockSuggestionById(tx, scope, suggestionId);
      if (row === null || row.status !== "queued") return false;
      const recorded = await autopilotStore.recordDecision(tx, scope, {
        suggestionId,
        decision: "rejected",
        reason,
        contentId: null,
        details,
      });
      if (!recorded) return false;
      await discardQueuedSuggestion(tx, scope, suggestionId);
      return true;
    });
  }

  async function approveCandidate(args: {
    readonly companyId: string;
    readonly candidate: SuggestionRow;
    readonly strategy: AutopilotStrategy;
    readonly owner: { readonly key: string; readonly siblings: readonly string[] };
    readonly details: Record<string, unknown>;
  }): Promise<"approved" | "rejected" | "gone" | "quota"> {
    const { companyId, candidate } = args;
    const scope = { companyId };
    const base = { companyId, suggestionId: candidate.id };
    // Se llena adentro de la transacción; un objeto para que el compilador no
    // lo dé por `null` después del `await`.
    const failed: { unbuildable: string | null } = { unbuildable: null };
    try {
      const done = await inCompany(companyId, async (tx) => {
        const accepted = await acceptForAutopilot(tx, {
          companyId,
          suggestionId: candidate.id,
          queue: deps.queue,
          clock: deps.clock,
          policy: deps.quotaPolicy,
        });
        if (accepted.kind === "gone") return "gone" as const;
        if (accepted.kind === "unbuildable") {
          failed.unbuildable = accepted.detail;
          return "gone" as const;
        }
        const scheduled: ScheduledSlot[] = await scheduleForAutopilot(tx, {
          db: deps.db,
          appRole: deps.appRole,
          companyId,
          ownerKey: args.owner.key,
          siblings: args.owner.siblings,
          contentId: accepted.contentId,
          strategy: args.strategy.slot,
          nowMs: deps.clock.nowMs(),
        });
        const recorded = await autopilotStore.recordDecision(tx, scope, {
          suggestionId: candidate.id,
          decision: "approved",
          reason: null,
          contentId: accepted.contentId,
          details: {
            ...args.details,
            scheduled: scheduled.map((s) => ({ network: s.network, atMs: s.atMs })),
          },
        });
        // Otra corrida la decidió primero: abortar deshace la aceptación entera.
        if (!recorded) throw new AlreadyDecided();
        return "approved" as const;
      });
      if (failed.unbuildable !== null) {
        deps.logger.warn(
          { ...base, detail: failed.unbuildable },
          "aprobada por el pre-chequeo pero no se puede construir: se descarta",
        );
        const rejected = await rejectCandidate(companyId, candidate.id, "unbuildable", {
          ...args.details,
          unbuildable: failed.unbuildable,
        });
        return rejected ? "rejected" : "gone";
      }
      return done;
    } catch (error: unknown) {
      if (error instanceof AlreadyDecided) return "gone";
      if (isDomainError(error) && error.code === "blitz_quota_blocked") {
        // Fuera del modo personal: sin saves no se aprueba nada más hoy. La
        // pieza sigue en la cola; la próxima corrida lo vuelve a intentar.
        deps.logger.warn(
          { ...base, code: error.code },
          "sin cupo de saves: el piloto para",
        );
        return "quota";
      }
      throw error;
    }
  }

  /** La clave del lock del calendario y las marcas hermanas. Igual que la API. */
  async function ownerOf(
    companyId: string,
  ): Promise<{ readonly key: string; readonly siblings: readonly string[] }> {
    if (!deps.personal) return { key: companyId, siblings: [] };
    const brands = await withoutCompany(
      deps.db,
      (tx) => autopilotStore.listBrands(tx),
      roleOpt,
    );
    const mine = brands.find((b) => b.companyId === companyId);
    if (mine === undefined) return { key: companyId, siblings: [] };
    return {
      key: mine.ownerUserId,
      siblings: brands
        .filter((b) => b.ownerUserId === mine.ownerUserId && b.companyId !== companyId)
        .map((b) => b.companyId),
    };
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const job = parseAutopilotJob(ctx.payload);
    if (job === null) {
      // Bug del productor: reintentar da el mismo error.
      deps.logger.error(
        { jobId: ctx.jobId },
        "payload de automation-generation inválido",
      );
      return;
    }
    if (job.kind === "sweep") {
      await sweep(ctx.jobId);
      return;
    }
    try {
      await runBrand(ctx.jobId, job.companyId);
    } catch (error: unknown) {
      // Se deja el estado para el resumen y se relanza: la cola reintenta.
      deps.logger.error(
        {
          jobId: ctx.jobId,
          companyId: job.companyId,
          reason: error instanceof Error ? error.message : String(error),
        },
        "la corrida del piloto falló",
      );
      await saveRun(job.companyId, {
        outcome: "error",
        queueTarget: 0,
        queued: 0,
        approved: 0,
        rejected: 0,
        held: 0,
      }).catch(() => undefined);
      throw error;
    }
  };
}

class AlreadyDecided extends Error {
  override readonly name = "AlreadyDecided";
}

/**
 * Lo que se guarda con cada decisión: las respuestas **crudas** (para
 * recalcular con otros umbrales), la versión de preguntas y umbrales, los
 * motivos, quién juzgó y un extracto de la copy para el resumen.
 */
function decisionDetails(
  candidate: SuggestionRow,
  outcome: PrecheckOutcome,
  decision: AutopilotDecision,
  run: {
    readonly latencyMs: number;
    readonly provenance: { adapter: string; model: string };
  },
): Record<string, unknown> {
  const text = (candidate.generatedText ?? "").replace(/\s+/gu, " ").trim();
  return {
    version: PRECHECK_VERSION,
    excerpt: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text,
    contentType: candidate.contentType,
    reasons:
      decision.kind === "reject"
        ? decision.reasons
        : decision.kind === "hold"
          ? [decision.reason]
          : [],
    answers: outcome.kind === "answered" ? outcome.answers : null,
    ...(outcome.kind === "unavailable" ? { errorCode: outcome.code } : {}),
    judgment: { ...run.provenance, latencyMs: run.latencyMs },
  };
}
