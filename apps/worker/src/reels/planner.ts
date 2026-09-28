/**
 * La cola `reel-planner` — sprint 9 (U), `PU-S9-014`.
 *
 * Por marca (con estrategia guardada), en cada corrida:
 *
 *  1. **El plan de la semana** (`reel_plans`, una fila por semana ISO local):
 *     si no existe se crea con el cupo que pide la estrategia
 *     (`reelWeeklyQuota`), y sus reels se reparten en los días que quedan
 *     (`planReelWeek`: ángulo por pesos de Blitz, plantilla, animación y
 *     subtítulos por preferencias con exploración). `replan` («Plan this
 *     week's reels now») rehace lo que todavía no salió a la cola.
 *  2. **Armar** los reels planificados (`materialize.ts`): copy, assets del
 *     decisor, marca, spec y póster.
 *  3. **Estados**: `suggested` → `discarded` si se descartó en el deck;
 *     `accepted` → `built`/`failed` según la pieza.
 *  4. **La cola de Blitz**: los reels del día (o atrasados) entran **si hay
 *     hueco**, con la misma sentencia y el mismo lock que el refill
 *     (`lockCompanyRefill` + `refillQueue`): nunca se pasa del objetivo (5, o
 *     el del piloto si la marca está en piloto automático). El refill de T no
 *     se toca: los dos convergen al mismo objetivo.
 *
 * El barrido (cron cada hora) encola una corrida por marca con clave que rota
 * (trampas 39 y 45). La API encola una corrida cuando se acepta o descarta
 * algo en el deck (la cola acaba de tener un hueco) y cuando se pide «Plan now».
 */
import {
  JOB_QUEUES,
  TARGET_QUEUED_ITEMS,
  autopilotQueueTarget,
  buildPreferences,
  parseReelPlannerJob,
  planReelWeek,
  reelLocalDateOf,
  reelPlannerJobKey,
  reelWeekStartOf,
  reelWeeklyQuota,
  REEL_SUGGESTION_PLAN_VERSION,
  type ReelMotion,
  type ReelPlannerMode,
  type ReelSuggestionPlan,
  type ReelTemplate,
} from "@fastgram/core";
import type { ReelPlanNote } from "@fastgram/contracts";
import {
  autopilotStore,
  discoveryQueueStore,
  reelPlanStore,
  withCompany,
  withoutCompany,
  type Database,
  type ReelPlanItemRow,
  type Transaction,
} from "@fastgram/db";
import type { Clock, JobHandler, Llm, Queue, Rng, Storage } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { AssetJudge } from "../judgment/asset-decider.js";
import { createLibrarySource } from "../judgment/library-source.js";
import { readReelBrandContext, type ReelBrandContext } from "./context.js";
import { materializeReel } from "./materialize.js";
import type { ReelRenderClient } from "./render-client.js";

export interface ReelPlannerDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly queue: Queue;
  readonly storage: Storage;
  /** El modelo `text` del registro, resuelto en cada corrida. `null` = sin modelo. */
  readonly textLlm: () => Promise<Llm | null>;
  /** El decisor con juicio (Laya/Jev) para la marca, o `null` (ranking textual). */
  readonly assetJudge?: ((subject: {
    readonly companyId: string;
    readonly subjectType: string;
    readonly subjectId?: string;
  }) => Promise<AssetJudge | null>) | undefined;
  readonly render: ReelRenderClient | null;
  readonly captionsAvailable: boolean;
}

export type ReelPlannerOutcome =
  | "no_strategy"
  | "planned"
  | "ticked";

export interface ReelPlannerRunResult {
  readonly outcome: ReelPlannerOutcome;
  readonly weekStart: string | null;
  readonly quota: number;
  readonly created: boolean;
  readonly materialized: number;
  readonly failed: number;
  readonly suggested: number;
}

const EMPTY_PREFS = (nowMs: number) => buildPreferences({ brand: null, owner: null, nowMs });

function noteCodes(
  ctx: ReelBrandContext,
  deps: { readonly llm: boolean; readonly judge: boolean; readonly captions: boolean },
  quota: number,
  lookNotes: readonly string[],
): ReelPlanNote[] {
  const notes: ReelPlanNote[] = [];
  if (quota === 0) notes.push({ code: "quota_zero" });
  if (!deps.llm) notes.push({ code: "llm_unavailable" });
  if (!deps.captions) notes.push({ code: "captions_unavailable" });
  if (!deps.judge) notes.push({ code: "decisor_fallback" });
  if (ctx.designSystem === null) notes.push({ code: "no_design_system" });
  if (ctx.clips.length === 0 && ctx.backgrounds.length === 0) notes.push({ code: "no_media" });
  for (const n of lookNotes) notes.push({ code: "font_replaced", detail: n.slice(0, 300) });
  return notes;
}

function generatedTextOf(copy: { hook: string; beats: readonly string[]; punchline: string | null }): string {
  return [copy.hook, ...copy.beats.map((b, i) => `${String(i + 1)}. ${b}`), copy.punchline ?? ""]
    .filter((t) => t !== "")
    .join("\n\n")
    .slice(0, 2_000);
}

const TEMPLATE_LABEL: Readonly<Record<ReelTemplate, string>> = {
  "hook-reaction-punchline": "hook → reaction → punchline",
  "list-beats": "list with beats",
  "before-after": "before / after",
};

function explanationOf(item: ReelPlanItemRow, picks: readonly string[]): string {
  const lines = [
    `Reel planned for ${item.day} by this week's reel plan.`,
    item.angleTitle === null ? "" : `Angle: ${item.angleTitle}.`,
    `Template: ${TEMPLATE_LABEL[item.template as ReelTemplate] ?? item.template}.`,
    ...picks,
  ].filter((l) => l !== "");
  return lines.map((l) => `• ${l.replace(/\s+/gu, " ").trim()}`).join("\n");
}

function animationsOf(spec: unknown): string[] {
  const layers = (spec as { layers?: { kind?: string; animation?: string }[] }).layers ?? [];
  return [
    ...new Set(
      layers.flatMap((l) => (l.kind === "text" && typeof l.animation === "string" ? [l.animation] : [])),
    ),
  ];
}

function captionStyleOf(spec: unknown): string {
  const layers = (spec as { layers?: { kind?: string; style?: string }[] }).layers ?? [];
  return layers.find((l) => l.kind === "captions")?.style ?? "none";
}

export function createReelPlannerHandler(deps: ReelPlannerDeps): JobHandler<unknown> {
  const roleOpt = deps.appRole === undefined ? {} : { role: deps.appRole };

  async function sweep(): Promise<void> {
    const brands = await withoutCompany(deps.db, (tx) => autopilotStore.listBrands(tx), roleOpt);
    const now = deps.clock.nowMs();
    for (const b of brands) {
      await deps.queue.enqueue({
        queue: JOB_QUEUES.reelPlanner,
        payload: { companyId: b.companyId, mode: "tick" },
        options: {
          singletonKey: reelPlannerJobKey(JOB_QUEUES.reelPlanner, b.companyId, "tick", now),
        },
      });
    }
    deps.logger.info({ brands: brands.length }, "reel-planner: barrido");
  }

  return async (job) => {
    const parsed = parseReelPlannerJob(job.payload);
    if (parsed === null) {
      deps.logger.warn({ jobId: job.jobId }, "reel-planner: payload inválido (se descarta)");
      return;
    }
    if (parsed.kind === "sweep") {
      await sweep();
      return;
    }
    const result = await runReelPlanner(deps, parsed.companyId, parsed.mode);
    deps.logger.info({ companyId: parsed.companyId, mode: parsed.mode, ...result }, "reel-planner");
  };
}

/** Una corrida de una marca. Exportada para los tests de integración. */
export async function runReelPlanner(
  deps: ReelPlannerDeps,
  companyId: string,
  mode: ReelPlannerMode,
): Promise<ReelPlannerRunResult> {
  const roleOpt = deps.appRole === undefined ? {} : { role: deps.appRole };
  const inCompany = <T>(fn: (tx: Transaction) => Promise<T>) =>
    withCompany(deps.db, companyId, fn, roleOpt);
  const scope = { companyId };
  const nowMs = deps.clock.nowMs();

  const ctx = await inCompany((tx) => readReelBrandContext(tx, companyId, nowMs));
  if (ctx.strategy === null) {
    return {
      outcome: "no_strategy",
      weekStart: null,
      quota: 0,
      created: false,
      materialized: 0,
      failed: 0,
      suggested: 0,
    };
  }
  const strategy = ctx.strategy;
  const today = reelLocalDateOf(nowMs, ctx.timezone);
  const weekStart = reelWeekStartOf(today);
  const quota = reelWeeklyQuota(strategy);

  // 1 · El plan (idempotente por semana) y sus ranuras.
  const { planId, created } = await inCompany(async (tx) => {
    const ensured = await reelPlanStore.ensureReelPlan(tx, scope, {
      weekStart,
      timezone: ctx.timezone,
      quota,
    });
    await reelPlanStore.lockReelPlan(tx, scope, ensured.plan.id);
    if (!ensured.created && mode !== "replan") {
      return { planId: ensured.plan.id, created: false };
    }
    const kept =
      mode === "replan"
        ? await reelPlanStore.clearUnsentReelPlanItems(tx, scope, ensured.plan.id)
        : await reelPlanStore.listReelPlanItems(tx, scope, ensured.plan.id);
    const nextOrd = kept.reduce((m, i) => Math.max(m, i.ord + 1), 0);
    const slots = planReelWeek({
      quota: Math.max(0, quota - kept.length),
      weekStart,
      today,
      angles: ctx.angles,
      availability: { clips: ctx.clips.length, backgrounds: ctx.backgrounds.length },
      prefs: ctx.prefs ?? EMPTY_PREFS(nowMs),
      rng: deps.rng,
      startOrd: nextOrd,
    });
    await reelPlanStore.insertReelPlanItems(
      tx,
      scope,
      ensured.plan.id,
      slots.map((s) => ({
        ord: s.ord,
        day: s.day,
        template: s.template,
        angleId: s.angle?.id ?? null,
        angleTitle: s.angle?.title ?? null,
        motion: s.motion,
        explored: s.explored,
      })),
    );
    await reelPlanStore.updateReelPlan(tx, scope, ensured.plan.id, {
      quota,
      timezone: ctx.timezone,
    });
    return { planId: ensured.plan.id, created: true };
  });

  // 2 · Armar lo planificado que todavía no tiene spec (fuera de la transacción).
  const pending = (await inCompany((tx) => reelPlanStore.listReelPlanItems(tx, scope, planId))).filter(
    (i) => i.status === "planned" && i.spec === null,
  );
  const llm = pending.length === 0 ? null : await deps.textLlm();
  const judge =
    pending.length === 0 || deps.assetJudge === undefined
      ? null
      : await deps.assetJudge({ companyId, subjectType: "reel_plan", subjectId: planId });
  const recent = new Set<string>();
  const library =
    pending.length === 0
      ? null
      : createLibrarySource({
          db: deps.db,
          storage: deps.storage,
          companyId,
          appRole: deps.appRole,
          logger: deps.logger,
        });
  const lookNotes = new Set<string>();
  let materialized = 0;
  let failed = 0;
  for (const item of pending) {
    const angle =
      item.angleId === null ? null : (ctx.angles.find((a) => a.id === item.angleId) ?? null);
    const built = await materializeReel(
      {
        logger: deps.logger,
        storage: deps.storage,
        llm,
        judge,
        render: deps.render,
        captionsAvailable: deps.captionsAvailable,
        library,
      },
      ctx,
      {
        itemId: item.id,
        template: item.template as ReelTemplate,
        motion: (item.motion ?? {}) as ReelMotion,
        angle:
          angle === null
            ? item.angleTitle === null
              ? null
              : { id: item.angleId ?? "", title: item.angleTitle, description: null }
            : { id: angle.id, title: angle.title, description: angle.description },
      },
      recent,
    );
    if (!built.ok) {
      failed += 1;
      await inCompany((tx) =>
        reelPlanStore.updateReelPlanItem(tx, scope, item.id, {
          status: "failed",
          failureReason: built.reason.slice(0, 500),
        }),
      );
      continue;
    }
    for (const n of built.lookNotes) lookNotes.add(n);
    materialized += 1;
    await inCompany((tx) =>
      reelPlanStore.updateReelPlanItem(tx, scope, item.id, {
        template: built.template,
        idea: built.idea,
        hook: built.copy.hook,
        copy: { ...built.copy, source: built.copySource },
        assets: { ...built.assets, mediaIds: built.mediaIds, clipKind: built.clipKind },
        spec: built.spec,
        durationSec: built.spec.durationSec,
        posterKey: built.posterKey,
      }),
    );
  }
  if (pending.length > 0 || created) {
    await inCompany((tx) =>
      reelPlanStore.updateReelPlan(tx, scope, planId, {
        notes: noteCodes(
          ctx,
          {
            llm: pending.length === 0 ? true : llm !== null,
            judge: pending.length === 0 ? true : judge !== null,
            captions: deps.captionsAvailable,
          },
          quota,
          [...lookNotes],
        ),
      }),
    );
  }

  // 3 · Estados que dependen del deck y del build.
  await inCompany((tx) => reelPlanStore.syncReelPlanItemStatuses(tx, scope));

  // 4 · Los reels del día, a la cola si hay hueco (mismo lock y sentencia que el refill).
  const target =
    strategy.autonomy === "autopilot"
      ? autopilotQueueTarget(strategy.networkPlans)
      : TARGET_QUEUED_ITEMS;
  const due = await inCompany((tx) => reelPlanStore.dueReelPlanItems(tx, scope, planId, today));
  let suggested = 0;
  for (const item of due) {
    const assets = (item.assets ?? {}) as {
      picks?: string[];
      mediaIds?: string[];
      clipKind?: ReelSuggestionPlan["features"]["clip"];
    };
    const plan: ReelSuggestionPlan = {
      kind: "reel",
      version: REEL_SUGGESTION_PLAN_VERSION,
      planItemId: item.id,
      spec: item.spec,
      posterKey: item.posterKey,
      mediaIds: assets.mediaIds ?? [],
      template: item.template as ReelTemplate,
      features: {
        template: item.template,
        animations: animationsOf(item.spec),
        captionStyle: captionStyleOf(item.spec),
        clip: assets.clipKind ?? null,
      },
      durationSec: item.durationSec ?? 0,
    };
    const copy = (item.copy ?? { hook: item.hook ?? "", beats: [], punchline: null }) as {
      hook: string;
      beats: string[];
      punchline: string | null;
    };
    const inserted = await inCompany(async (tx) => {
      await discoveryQueueStore.lockCompanyRefill(tx, scope);
      const res = await discoveryQueueStore.refillQueue(tx, scope, target, [
        {
          contentType: "reel",
          aiExplanation: explanationOf(item, assets.picks ?? []),
          angleId: item.angleId,
          influencerId: null,
          textStylePresetId: null,
          generatedText: generatedTextOf(copy),
          buildPlan: plan,
        },
      ]);
      const id = res.insertedIds[0];
      if (id !== undefined) {
        await reelPlanStore.updateReelPlanItem(tx, scope, item.id, {
          status: "suggested",
          suggestionId: id,
        });
      }
      return id !== undefined;
    });
    if (!inserted) break; // La cola está llena: el resto espera al próximo hueco.
    suggested += 1;
  }

  return {
    outcome: created || mode === "replan" ? "planned" : "ticked",
    weekStart,
    quota,
    created,
    materialized,
    failed,
    suggested,
  };
}
