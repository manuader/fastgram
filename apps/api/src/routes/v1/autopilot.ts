/**
 * Piloto automático — `PU-AUTO-003` (resumen diario) y la política del piloto
 * (`PU-AUTO-002`) · `docs/PLAN-USO-PERSONAL.md` §2, PRD §2.7 `D-08`.
 *
 *   GET /autopilot/digest?date&brands   por marca: generadas, aprobadas solas,
 *                                        rechazadas con motivo, en espera,
 *                                        publicadas y fallidas del día
 *   GET /autopilot/policy               horizonte, objetivo de la cola, cupo y
 *                                        umbrales del pre-chequeo (sólo lectura)
 *
 * ## De dónde sale cada número del resumen
 *
 * | Qué              | De dónde                                              |
 * |------------------|-------------------------------------------------------|
 * | generadas        | `suggestions.created_at` en el día (refill y prompt)  |
 * | aprobadas, etc.  | `autopilot_decisions` del día (las escribe el worker) |
 * | publicadas       | posts con `posted_at` en el día (incluye inbox TikTok)|
 * | fallidas         | posts `FAILED` con fecha efectiva en el día           |
 * | última corrida   | `autopilot_runs`                                      |
 *
 * El "día" es el **local de cada marca** (su `companies.timezone`), no el del
 * servidor ni el del navegador: ver la cabecera del contrato.
 *
 * ## "Todas las marcas"
 *
 * Igual que `GET /calendar?brands=all`: en el modo personal, las del dueño de la
 * credencial (`workspaceDirectory`, sin scope de tenant, sólo para listar); los
 * datos de cada marca se leen con **su** scope (`runScoped`). Fuera del modo
 * personal, "todas" es la de la request.
 */
import {
  autopilotDigestQuerySchema,
  autopilotReasonSchema,
  autopilotRunOutcomeSchema,
  contentTypeSchema,
  postPlatformSchema,
  strategyNetworkSchema,
  type AutopilotBrandDigest,
  type AutopilotDecisionItem,
  type AutopilotPolicy,
  type FastgramMode,
} from "@fastgram/contracts";
import {
  AUTOPILOT_HORIZON_DAYS,
  AUTOPILOT_MAX_DECISIONS_PER_RUN,
  AUTOPILOT_PRECHECK_TIMEOUT_MS,
  AUTOPILOT_QUEUE_TARGET_MAX,
  AUTOPILOT_QUEUE_TARGET_MIN,
  AUTOPILOT_RUN_EVERY_MINUTES,
  PRECHECK_THRESHOLDS,
  PRECHECK_VERSION,
  localDateOf,
  localDayRange,
  parseLocalDate,
} from "@fastgram/core";
import {
  autopilotStore,
  brandStrategyRepository,
  companyRepository,
  postCalendar,
  withoutCompany,
  workspaceDirectory,
  type DecisionWithSuggestion,
  type Executor,
} from "@fastgram/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { ownerOrFail, runScoped } from "../../auth/scope.js";
import { ApiRejection } from "../../http/errors.js";
import { data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

/** Tope por lista y por marca. Con el cupo del piloto (6 por corrida) sobra. */
export const AUTOPILOT_DIGEST_LIST_MAX = 100;

interface Brand {
  readonly id: string;
  readonly name: string;
}

function homeCompanyOf(request: FastifyRequest): string {
  return request.auth.homeCompanyId ?? request.auth.companyId;
}

export function autopilotPolicy(): AutopilotPolicy {
  return {
    horizonDays: AUTOPILOT_HORIZON_DAYS,
    queueTargetMin: AUTOPILOT_QUEUE_TARGET_MIN,
    queueTargetMax: AUTOPILOT_QUEUE_TARGET_MAX,
    maxDecisionsPerRun: AUTOPILOT_MAX_DECISIONS_PER_RUN,
    runEveryMinutes: AUTOPILOT_RUN_EVERY_MINUTES,
    precheckTimeoutMs: AUTOPILOT_PRECHECK_TIMEOUT_MS,
    precheckVersion: PRECHECK_VERSION,
    thresholds: { ...PRECHECK_THRESHOLDS },
  };
}

const scheduledSchema = z.array(
  z.object({ network: strategyNetworkSchema, atMs: z.number().int().nonnegative() }),
);
const reasonsSchema = z.array(z.string());

/** Una fila de `autopilot_decisions` → el ítem del contrato. Lo que no parsea, no viaja. */
function toItem(row: DecisionWithSuggestion): AutopilotDecisionItem {
  const details =
    typeof row.decision.details === "object" && row.decision.details !== null
      ? (row.decision.details as Record<string, unknown>)
      : {};
  const excerpt = typeof details["excerpt"] === "string" ? details["excerpt"] : "";
  const rawReasons = reasonsSchema.safeParse(details["reasons"]);
  const reasons = (rawReasons.success ? rawReasons.data : [row.decision.reason ?? ""])
    .map((r) => autopilotReasonSchema.safeParse(r))
    .flatMap((r) => (r.success ? [r.data] : []));
  const scheduled = scheduledSchema.safeParse(details["scheduled"]);
  const type = contentTypeSchema.safeParse(row.contentType);
  const contentType = type.success ? type.data : undefined;
  return {
    suggestionId: row.decision.suggestionId,
    ...(contentType === undefined ? {} : { contentType }),
    excerpt,
    at: row.decision.createdAt.getTime(),
    reasons,
    ...(row.decision.contentId === null ? {} : { contentId: row.decision.contentId }),
    scheduled: scheduled.success
      ? scheduled.data.map((s) => ({ network: s.network, at: s.atMs }))
      : [],
  };
}

async function readBrandDigest(
  tx: Executor,
  brand: Brand,
  date: string | undefined,
  nowMs: number,
): Promise<AutopilotBrandDigest> {
  const scope = { companyId: brand.id };
  const timezone = (await brandStrategyRepository.timezone(tx, scope)) ?? "UTC";
  const day = date ?? localDateOf(nowMs, timezone);
  const civil = parseLocalDate(day);
  if (civil === null) {
    throw new ApiRejection(400, "bad_request", "date must be a real day (YYYY-MM-DD).", {
      field: "date",
    });
  }
  const { fromMs, toMs } = localDayRange(civil, timezone);
  const limit = AUTOPILOT_DIGEST_LIST_MAX + 1;

  const strategy = await brandStrategyRepository.find(tx, scope);
  const run = await autopilotStore.findRun(tx, scope);
  const generated = await autopilotStore.countSuggestionsCreatedInRange(tx, scope, {
    fromMs,
    toMs,
  });
  const decisions = await autopilotStore.listDecisionsInRange(tx, scope, {
    fromMs,
    toMs,
    limit,
  });
  // Publicados: con `posted_at` en el día. `listInRange` filtra por fecha
  // efectiva (`coalesce(posted_at, scheduled_at_utc)`), que para un publicado
  // es `posted_at`.
  const posted = await postCalendar.listInRange(tx, scope, {
    fromMs,
    toMs,
    limit,
    statuses: ["POSTED", "IN_USER_INBOX"],
  });
  const failed = await postCalendar.listInRange(tx, scope, {
    fromMs,
    toMs,
    limit,
    statuses: ["FAILED"],
  });

  const truncated =
    decisions.length > AUTOPILOT_DIGEST_LIST_MAX ||
    posted.length > AUTOPILOT_DIGEST_LIST_MAX ||
    failed.length > AUTOPILOT_DIGEST_LIST_MAX;
  const kept = decisions.slice(0, AUTOPILOT_DIGEST_LIST_MAX);
  const of = (kind: string) =>
    kept.filter((d) => d.decision.decision === kind).map(toItem);

  return {
    brandId: brand.id,
    brandName: brand.name,
    timezone,
    date: day,
    autonomy: strategy?.autonomy ?? "manual",
    lastRun:
      run === null
        ? null
        : {
            at: run.lastRunAt.getTime(),
            // Un código que el contrato no conoce es un cambio del worker que no
            // pasó por acá: se muestra como `error`, no rompe la respuesta.
            outcome: autopilotRunOutcomeSchema.catch("error").parse(run.outcome),
            queueTarget: run.queueTarget,
            queued: run.queued,
            approved: run.approved,
            rejected: run.rejected,
            held: run.held,
          },
    generated,
    approved: of("approved"),
    rejected: of("rejected"),
    held: of("held"),
    published: Math.min(posted.length, AUTOPILOT_DIGEST_LIST_MAX),
    // `linkedin` existe en la base y no en el enum del contrato (entra por
    // automations): no viaja, en vez de hacer fallar la respuesta entera.
    failed: failed.slice(0, AUTOPILOT_DIGEST_LIST_MAX).flatMap((p) => {
      const network = postPlatformSchema.safeParse(p.platform);
      if (!network.success) return [];
      return [
        {
          postId: p.id,
          network: network.data,
          ...(p.errorCode === null ? {} : { errorCode: p.errorCode }),
          at: (p.postedAt ?? p.scheduledAtUtc).getTime(),
        },
      ];
    }),
    truncated,
  };
}

export function registerAutopilotRoutes(app: ZodApp): void {
  const { db, clock, appRole } = app.deps;
  const mode: FastgramMode = app.deps.mode ?? "standard";

  async function brandsFor(
    request: FastifyRequest,
    which: "current" | "all",
  ): Promise<Brand[]> {
    const companyId = request.auth.companyId;
    if (mode !== "personal") {
      const company = await runScoped(db, companyId, appRole, (tx) =>
        companyRepository.load(tx, { companyId }),
      );
      return [{ id: companyId, name: company?.name ?? "" }];
    }
    return withoutCompany(db, async (tx) => {
      const owner = await ownerOrFail(tx, homeCompanyOf(request));
      const all = await workspaceDirectory.list(tx, owner);
      return all
        .filter((w) => which === "all" || w.id === companyId)
        .map((w) => ({ id: w.id, name: w.name }));
    });
  }

  // ── GET /autopilot/policy ──
  app.get("/autopilot/policy", async () => data(autopilotPolicy()));

  // ── GET /autopilot/digest ──
  app.get(
    "/autopilot/digest",
    { schema: { querystring: autopilotDigestQuerySchema } },
    async (request) => {
      const { date, brands } = request.query;
      const nowMs = clock.nowMs();
      const out: AutopilotBrandDigest[] = [];
      for (const brand of await brandsFor(request, brands)) {
        out.push(
          await runScoped(db, brand.id, appRole, (tx) =>
            readBrandDigest(tx, brand, date, nowMs),
          ),
        );
      }
      return data({ brands: out });
    },
  );
}
