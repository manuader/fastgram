/**
 * `reel_plans` / `reel_plan_items` (migración `0041`, sprint 9, agente U,
 * `PU-S9-014`): el plan semanal de reels de una marca.
 *
 * Todo con scope de `companyId` (RLS además). La idempotencia del plan es la
 * clave única `(company_id, week_start)`: {@link ensureReelPlan} inserta con
 * `ON CONFLICT DO NOTHING` y relee, así el cron y el botón «Plan now»
 * convergen en la misma fila aunque corran a la vez.
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { contents } from "../schema/content.js";
import { suggestions } from "../schema/blitz.js";
import { reelPlanItems, reelPlans, type ReelPlanItemStatusDb } from "../schema/reels.js";
import type { TenantScope } from "./base.js";

export type ReelPlanRow = typeof reelPlans.$inferSelect;
export type ReelPlanItemRow = typeof reelPlanItems.$inferSelect;

export async function findReelPlan(
  exec: Executor,
  scope: TenantScope,
  weekStart: string,
): Promise<ReelPlanRow | null> {
  const rows = await exec
    .select()
    .from(reelPlans)
    .where(and(eq(reelPlans.companyId, scope.companyId), eq(reelPlans.weekStart, weekStart)))
    .limit(1);
  return rows[0] ?? null;
}

/** El plan de la semana: lo crea si no existe. `created` dice si esta llamada lo creó. */
export async function ensureReelPlan(
  exec: Executor,
  scope: TenantScope,
  input: { readonly weekStart: string; readonly timezone: string; readonly quota: number },
): Promise<{ readonly plan: ReelPlanRow; readonly created: boolean }> {
  const inserted = await exec
    .insert(reelPlans)
    .values({
      companyId: scope.companyId,
      weekStart: input.weekStart,
      timezone: input.timezone,
      quota: input.quota,
    })
    .onConflictDoNothing({ target: [reelPlans.companyId, reelPlans.weekStart] })
    .returning();
  const row = inserted[0];
  if (row !== undefined) return { plan: row, created: true };
  const found = await findReelPlan(exec, scope, input.weekStart);
  if (found === null) {
    throw new Error("reel_plans: ON CONFLICT sin fila visible (¿RLS o scope distinto?).");
  }
  return { plan: found, created: false };
}

/** Bloquea el plan hasta el fin de la transacción: dos corridas de la misma marca se ordenan. */
export async function lockReelPlan(
  exec: Executor,
  scope: TenantScope,
  planId: string,
): Promise<ReelPlanRow | null> {
  const rows = await exec
    .select()
    .from(reelPlans)
    .where(and(eq(reelPlans.companyId, scope.companyId), eq(reelPlans.id, planId)))
    .for("update");
  return rows[0] ?? null;
}

export async function updateReelPlan(
  exec: Executor,
  scope: TenantScope,
  planId: string,
  patch: { readonly quota?: number; readonly notes?: unknown; readonly timezone?: string },
): Promise<void> {
  await exec
    .update(reelPlans)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(reelPlans.companyId, scope.companyId), eq(reelPlans.id, planId)));
}

export async function listReelPlanItems(
  exec: Executor,
  scope: TenantScope,
  planId: string,
): Promise<ReelPlanItemRow[]> {
  return exec
    .select()
    .from(reelPlanItems)
    .where(and(eq(reelPlanItems.companyId, scope.companyId), eq(reelPlanItems.planId, planId)))
    .orderBy(asc(reelPlanItems.day), asc(reelPlanItems.ord));
}

export interface NewReelPlanItem {
  readonly ord: number;
  readonly day: string;
  readonly template: string;
  readonly angleId: string | null;
  readonly angleTitle: string | null;
  readonly motion: unknown;
  readonly explored: boolean;
}

export async function insertReelPlanItems(
  exec: Executor,
  scope: TenantScope,
  planId: string,
  items: readonly NewReelPlanItem[],
): Promise<ReelPlanItemRow[]> {
  if (items.length === 0) return [];
  return exec
    .insert(reelPlanItems)
    .values(
      items.map((i) => ({
        companyId: scope.companyId,
        planId,
        ord: i.ord,
        day: i.day,
        template: i.template,
        angleId: i.angleId,
        angleTitle: i.angleTitle,
        motion: i.motion,
        explored: i.explored,
      })),
    )
    .returning();
}

export interface ReelPlanItemPatch {
  readonly status?: ReelPlanItemStatusDb;
  readonly template?: string;
  readonly idea?: string | null;
  readonly hook?: string | null;
  readonly copy?: unknown;
  readonly motion?: unknown;
  readonly assets?: unknown;
  readonly spec?: unknown;
  readonly durationSec?: number | null;
  readonly posterKey?: string | null;
  readonly suggestionId?: string | null;
  readonly contentId?: string | null;
  readonly failureReason?: string | null;
}

export async function updateReelPlanItem(
  exec: Executor,
  scope: TenantScope,
  itemId: string,
  patch: ReelPlanItemPatch,
): Promise<void> {
  await exec
    .update(reelPlanItems)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(reelPlanItems.companyId, scope.companyId), eq(reelPlanItems.id, itemId)));
}

/**
 * Re-planificar: borra lo que todavía no salió (`planned` y `failed`) y
 * devuelve lo que se conserva (lo que ya está en la cola o después).
 */
export async function clearUnsentReelPlanItems(
  exec: Executor,
  scope: TenantScope,
  planId: string,
): Promise<ReelPlanItemRow[]> {
  await exec
    .delete(reelPlanItems)
    .where(
      and(
        eq(reelPlanItems.companyId, scope.companyId),
        eq(reelPlanItems.planId, planId),
        inArray(reelPlanItems.status, ["planned", "failed"]),
      ),
    );
  return listReelPlanItems(exec, scope, planId);
}

/** Los armados que ya tocan (día ≤ hoy) y todavía no entraron a la cola. */
export async function dueReelPlanItems(
  exec: Executor,
  scope: TenantScope,
  planId: string,
  today: string,
): Promise<ReelPlanItemRow[]> {
  return exec
    .select()
    .from(reelPlanItems)
    .where(
      and(
        eq(reelPlanItems.companyId, scope.companyId),
        eq(reelPlanItems.planId, planId),
        eq(reelPlanItems.status, "planned"),
        lte(reelPlanItems.day, today),
        sql`${reelPlanItems.spec} is not null`,
      ),
    )
    .orderBy(asc(reelPlanItems.day), asc(reelPlanItems.ord));
}

/** El ítem de una sugerencia, si la sugerencia salió del plan. */
export async function findReelPlanItemBySuggestion(
  exec: Executor,
  scope: TenantScope,
  suggestionId: string,
): Promise<ReelPlanItemRow | null> {
  const rows = await exec
    .select()
    .from(reelPlanItems)
    .where(
      and(
        eq(reelPlanItems.companyId, scope.companyId),
        eq(reelPlanItems.suggestionId, suggestionId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Pone al día los estados que dependen de otras tablas, en una sentencia por
 * transición: `suggested` → `discarded` si la sugerencia se descartó;
 * `accepted` → `built` / `failed` según la pieza. Idempotente. Devuelve
 * cuántas filas cambió cada transición (para el log).
 */
export async function syncReelPlanItemStatuses(
  exec: Executor,
  scope: TenantScope,
): Promise<{ discarded: number; built: number; failed: number }> {
  const discarded = await exec
    .update(reelPlanItems)
    .set({ status: "discarded", updatedAt: sql`now()` })
    .where(
      and(
        eq(reelPlanItems.companyId, scope.companyId),
        eq(reelPlanItems.status, "suggested"),
        sql`exists (select 1 from ${suggestions} s where s.id = ${reelPlanItems.suggestionId} and s.status = 'discarded')`,
      ),
    )
    .returning({ id: reelPlanItems.id });
  const built = await exec
    .update(reelPlanItems)
    .set({ status: "built", updatedAt: sql`now()` })
    .where(
      and(
        eq(reelPlanItems.companyId, scope.companyId),
        eq(reelPlanItems.status, "accepted"),
        sql`exists (select 1 from ${contents} c where c.id = ${reelPlanItems.contentId} and c.status = 'CREATED')`,
      ),
    )
    .returning({ id: reelPlanItems.id });
  const failed = await exec
    .update(reelPlanItems)
    .set({ status: "failed", failureReason: "build_failed", updatedAt: sql`now()` })
    .where(
      and(
        eq(reelPlanItems.companyId, scope.companyId),
        eq(reelPlanItems.status, "accepted"),
        sql`exists (select 1 from ${contents} c where c.id = ${reelPlanItems.contentId} and c.status = 'FAILED')`,
      ),
    )
    .returning({ id: reelPlanItems.id });
  return { discarded: discarded.length, built: built.length, failed: failed.length };
}

/** El último plan de la marca (el de esta semana o el anterior), para la pantalla. */
export async function latestReelPlan(
  exec: Executor,
  scope: TenantScope,
): Promise<ReelPlanRow | null> {
  const rows = await exec
    .select()
    .from(reelPlans)
    .where(eq(reelPlans.companyId, scope.companyId))
    .orderBy(sql`${reelPlans.weekStart} desc`)
    .limit(1);
  return rows[0] ?? null;
}

export const reelPlanStore = {
  findReelPlan,
  ensureReelPlan,
  lockReelPlan,
  updateReelPlan,
  listReelPlanItems,
  insertReelPlanItems,
  updateReelPlanItem,
  clearUnsentReelPlanItems,
  dueReelPlanItems,
  findReelPlanItemBySuggestion,
  syncReelPlanItemStatuses,
  latestReelPlan,
};
