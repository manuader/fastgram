/**
 * Automations — `DATA-021`, `DATA-022`, `FR-150`. Tablas de `0000` + `0023`.
 *
 * Todo con `TenantScope`. Lo genérico (crear, leer por id, actualizar) lo da
 * `automationRepository` / `automationSlotRepository` (`index.ts`); acá va lo
 * que la API y el worker necesitan y no es un CRUD de una fila:
 *
 * - **Locks** (`FOR UPDATE`) de la campaña y del slot: las transiciones de
 *   estado se deciden con la fila bloqueada, nunca leyendo y escribiendo por
 *   separado (trampa 37).
 * - **Tomar slots para generar** con `FOR UPDATE SKIP LOCKED`: dos entregas del
 *   mismo job no generan el mismo slot dos veces.
 * - **Conteos por estado** para la lista y el progreso.
 * - **El corpus del dedup**: lo que la marca ya usó.
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  automationSlots,
  automations,
  contents,
  plannedSlots,
  posts,
  suggestions,
} from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type AutomationRow = typeof automations.$inferSelect;
export type AutomationInsert = Omit<
  typeof automations.$inferInsert,
  "id" | "companyId" | "createdAt" | "updatedAt"
>;
export type AutomationSlotRow = typeof automationSlots.$inferSelect;
export type AutomationSlotInsert = Omit<
  typeof automationSlots.$inferInsert,
  "id" | "companyId" | "automationId" | "createdAt" | "updatedAt"
>;
export type AutomationSlotPatch = Partial<
  Omit<
    typeof automationSlots.$inferInsert,
    "id" | "companyId" | "automationId" | "createdAt" | "updatedAt"
  >
>;
export type AutomationPatch = Partial<AutomationInsert>;

type SlotStatus = AutomationSlotRow["status"];

async function lockAutomation(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
): Promise<AutomationRow | null> {
  const rows = await exec
    .select()
    .from(automations)
    .where(
      and(eq(automations.companyId, scope.companyId), eq(automations.id, automationId)),
    )
    .limit(1)
    .for("update");
  return rows[0] ?? null;
}

async function findAutomation(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
): Promise<AutomationRow | null> {
  const rows = await exec
    .select()
    .from(automations)
    .where(
      and(eq(automations.companyId, scope.companyId), eq(automations.id, automationId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function createAutomation(
  exec: Executor,
  scope: TenantScope,
  values: AutomationInsert,
): Promise<AutomationRow> {
  const rows = await exec
    .insert(automations)
    .values({ ...values, companyId: scope.companyId })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("El insert de la campaña no devolvió fila.");
  return row;
}

async function updateAutomation(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
  patch: AutomationPatch,
): Promise<AutomationRow | null> {
  const rows = await exec
    .update(automations)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(eq(automations.companyId, scope.companyId), eq(automations.id, automationId)),
    )
    .returning();
  return rows[0] ?? null;
}

/** Suma a `generationQuotaUsed` en una sentencia (sin leer-y-escribir). */
async function addQuotaUsed(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
  by: number,
): Promise<void> {
  await exec
    .update(automations)
    .set({
      generationQuotaUsed: sql`${automations.generationQuotaUsed} + ${by}`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(automations.companyId, scope.companyId), eq(automations.id, automationId)),
    );
}

/** Borrado real: `automation_slots` cae por `cascade`. */
async function deleteAutomation(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
): Promise<boolean> {
  const rows = await exec
    .delete(automations)
    .where(
      and(eq(automations.companyId, scope.companyId), eq(automations.id, automationId)),
    )
    .returning({ id: automations.id });
  return rows.length > 0;
}

/** Las de la marca, más nuevas primero. Una marca tiene pocas: tope, sin cursor. */
async function listAutomations(
  exec: Executor,
  scope: TenantScope,
  opts: {
    readonly limit: number;
    readonly statuses?: readonly AutomationRow["status"][];
  },
): Promise<AutomationRow[]> {
  return exec
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.companyId, scope.companyId),
        opts.statuses === undefined || opts.statuses.length === 0
          ? undefined
          : inArray(automations.status, [...opts.statuses]),
      ),
    )
    .orderBy(desc(automations.createdAt), desc(automations.id))
    .limit(opts.limit);
}

/** `automationId → estado → cantidad`, para la lista y el progreso. */
async function slotCounts(
  exec: Executor,
  scope: TenantScope,
  automationIds: readonly string[],
): Promise<Map<string, Partial<Record<SlotStatus, number>>>> {
  const out = new Map<string, Partial<Record<SlotStatus, number>>>();
  if (automationIds.length === 0) return out;
  const rows = await exec
    .select({
      automationId: automationSlots.automationId,
      status: automationSlots.status,
      n: sql<number>`count(*)::int`,
    })
    .from(automationSlots)
    .where(
      and(
        eq(automationSlots.companyId, scope.companyId),
        inArray(automationSlots.automationId, [...automationIds]),
      ),
    )
    .groupBy(automationSlots.automationId, automationSlots.status);
  for (const r of rows) {
    const m = out.get(r.automationId) ?? {};
    m[r.status] = Number(r.n);
    out.set(r.automationId, m);
  }
  return out;
}

// ── slots ──

async function listSlots(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
): Promise<AutomationSlotRow[]> {
  return exec
    .select()
    .from(automationSlots)
    .where(
      and(
        eq(automationSlots.companyId, scope.companyId),
        eq(automationSlots.automationId, automationId),
      ),
    )
    .orderBy(asc(automationSlots.scheduledAtUtc), asc(automationSlots.slotIndex))
    .limit(1000);
}

async function lockSlot(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
  slotId: string,
): Promise<AutomationSlotRow | null> {
  const rows = await exec
    .select()
    .from(automationSlots)
    .where(
      and(
        eq(automationSlots.companyId, scope.companyId),
        eq(automationSlots.automationId, automationId),
        eq(automationSlots.id, slotId),
      ),
    )
    .limit(1)
    .for("update");
  return rows[0] ?? null;
}

/**
 * Inserta la grilla. `ON CONFLICT (automation_id, slot_index) DO NOTHING`:
 * una segunda llamada (reentrega) no duplica.
 */
async function insertSlots(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
  values: readonly AutomationSlotInsert[],
): Promise<number> {
  if (values.length === 0) return 0;
  const rows = await exec
    .insert(automationSlots)
    .values(values.map((v) => ({ ...v, automationId, companyId: scope.companyId })))
    .onConflictDoNothing({
      target: [automationSlots.automationId, automationSlots.slotIndex],
    })
    .returning({ id: automationSlots.id });
  return rows.length;
}

async function updateSlot(
  exec: Executor,
  scope: TenantScope,
  slotId: string,
  patch: AutomationSlotPatch,
  /** Sólo si el slot sigue en uno de estos estados (guarda de la transición). */
  onlyIf?: readonly SlotStatus[],
): Promise<AutomationSlotRow | null> {
  const rows = await exec
    .update(automationSlots)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(automationSlots.companyId, scope.companyId),
        eq(automationSlots.id, slotId),
        onlyIf === undefined ? undefined : inArray(automationSlots.status, [...onlyIf]),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Toma hasta `limit` slots `PENDING_GEN` (o `REROLLING` con `includeRerolls`
 * para un id dado) y los marca `GENERATING`. `SKIP LOCKED`: otra entrega que
 * corre a la vez toma otros.
 */
async function claimPendingSlots(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
  limit: number,
): Promise<AutomationSlotRow[]> {
  // CTE y no `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)`: con el
  // subselect el planificador puede re-ejecutarlo por fila y el `LIMIT` deja de
  // acotar (medido: una tanda de 6 tomó los 7 slots). La CTE con `FOR UPDATE`
  // se materializa una vez.
  const rows = (await exec.execute(sql`
    with picked as (
      select id from ${automationSlots}
       where company_id = ${scope.companyId}
         and automation_id = ${automationId}
         and status = 'PENDING_GEN'
       order by slot_index
       limit ${limit}
       for update skip locked)
    update ${automationSlots} s
       set status = 'GENERATING', generating_since = now(), updated_at = now()
      from picked
     where s.id = picked.id
    returning s.id`)) as unknown as { id: string }[];
  if (rows.length === 0) return [];
  return exec
    .select()
    .from(automationSlots)
    .where(
      and(
        eq(automationSlots.companyId, scope.companyId),
        inArray(
          automationSlots.id,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(automationSlots.slotIndex));
}

/** `GENERATING` desde antes de `beforeMs` → `PENDING_GEN` (worker muerto). */
async function releaseStaleGenerating(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
  beforeMs: number,
): Promise<number> {
  const rows = await exec
    .update(automationSlots)
    .set({ status: "PENDING_GEN", generatingSince: null, updatedAt: new Date() })
    .where(
      and(
        eq(automationSlots.companyId, scope.companyId),
        eq(automationSlots.automationId, automationId),
        eq(automationSlots.status, "GENERATING"),
        lt(automationSlots.generatingSince, new Date(beforeMs)),
      ),
    )
    .returning({ id: automationSlots.id });
  return rows.length;
}

async function countSlotsIn(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
  statuses: readonly SlotStatus[],
): Promise<number> {
  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(automationSlots)
    .where(
      and(
        eq(automationSlots.companyId, scope.companyId),
        eq(automationSlots.automationId, automationId),
        inArray(automationSlots.status, [...statuses]),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

// ── lo ya usado (dedup) ──

export interface UsedTextRow {
  readonly text: string;
  readonly mediaIds: readonly string[] | null;
}

function mediaIdsOfPlan(plan: unknown): string[] | null {
  if (plan === null || typeof plan !== "object") return null;
  const media = (plan as Record<string, unknown>)["media"];
  if (media === null || typeof media !== "object") return null;
  const ids: string[] = [];
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    const r = v as Record<string, unknown>;
    if (typeof r["mediaId"] === "string") ids.push(r["mediaId"]);
    for (const [k, value] of Object.entries(r)) if (k !== "mediaId") visit(value);
  };
  visit(media);
  return ids.length === 0 ? null : ids;
}

/**
 * El corpus del dedup: piezas vivas, sugerencias y slots de campañas de la
 * marca (sin los cancelados), más nuevos primero, hasta `limit` de cada uno.
 * `excludeSlotId` saca al propio slot (un re-roll no compite contra su copia
 * vieja, que se descarta).
 */
async function usedTexts(
  exec: Executor,
  scope: TenantScope,
  opts: { readonly limit: number; readonly excludeSlotId?: string },
): Promise<UsedTextRow[]> {
  const out: UsedTextRow[] = [];
  const contentRows = await exec
    .select({ text: contents.generatedText })
    .from(contents)
    .where(
      and(
        eq(contents.companyId, scope.companyId),
        isNotNull(contents.generatedText),
        sql`${contents.deletedAt} is null`,
      ),
    )
    .orderBy(desc(contents.createdAt))
    .limit(opts.limit);
  for (const r of contentRows)
    if (r.text !== null) out.push({ text: r.text, mediaIds: null });

  const suggestionRows = await exec
    .select({ text: suggestions.generatedText, plan: suggestions.buildPlan })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.companyId, scope.companyId),
        isNotNull(suggestions.generatedText),
      ),
    )
    .orderBy(desc(suggestions.createdAt))
    .limit(opts.limit);
  for (const r of suggestionRows)
    if (r.text !== null) out.push({ text: r.text, mediaIds: mediaIdsOfPlan(r.plan) });

  const slotRows = await exec
    .select({ text: automationSlots.generatedText, data: automationSlots.suggestionData })
    .from(automationSlots)
    .where(
      and(
        eq(automationSlots.companyId, scope.companyId),
        isNotNull(automationSlots.generatedText),
        ne(automationSlots.status, "CANCELLED"),
        opts.excludeSlotId === undefined
          ? undefined
          : ne(automationSlots.id, opts.excludeSlotId),
      ),
    )
    .orderBy(desc(automationSlots.updatedAt))
    .limit(opts.limit);
  for (const r of slotRows) {
    if (r.text === null) continue;
    const plan =
      r.data !== null && typeof r.data === "object"
        ? (r.data as Record<string, unknown>)["buildPlan"]
        : null;
    out.push({ text: r.text, mediaIds: mediaIdsOfPlan(plan) });
  }
  return out;
}

// ── después del launch ──

/** Los slots planificados de los slots de una campaña (para cancelar). */
async function plannedSlotsOf(
  exec: Executor,
  scope: TenantScope,
  slotIds: readonly string[],
): Promise<(typeof plannedSlots.$inferSelect)[]> {
  if (slotIds.length === 0) return [];
  return exec
    .select()
    .from(plannedSlots)
    .where(
      and(
        eq(plannedSlots.companyId, scope.companyId),
        inArray(plannedSlots.automationSlotId, [...slotIds]),
      ),
    );
}

/** Borra los slots planificados **todavía planificados** de estos slots. */
async function deletePlannedSlotsOf(
  exec: Executor,
  scope: TenantScope,
  slotIds: readonly string[],
): Promise<number> {
  if (slotIds.length === 0) return 0;
  const rows = await exec
    .delete(plannedSlots)
    .where(
      and(
        eq(plannedSlots.companyId, scope.companyId),
        eq(plannedSlots.status, "planned"),
        inArray(plannedSlots.automationSlotId, [...slotIds]),
      ),
    )
    .returning({ id: plannedSlots.id });
  return rows.length;
}

export type CampaignPostRow = Pick<
  typeof posts.$inferSelect,
  | "id"
  | "automationSlotId"
  | "platform"
  | "status"
  | "scheduledAtUtc"
  | "postedAt"
  | "postUrl"
  | "views"
  | "likes"
  | "comments"
  | "errorCode"
>;

/** Los posts de los slots de una campaña (monitor, cancel, completado). */
async function postsOfSlots(
  exec: Executor,
  scope: TenantScope,
  slotIds: readonly string[],
): Promise<CampaignPostRow[]> {
  if (slotIds.length === 0) return [];
  return exec
    .select({
      id: posts.id,
      automationSlotId: posts.automationSlotId,
      platform: posts.platform,
      status: posts.status,
      scheduledAtUtc: posts.scheduledAtUtc,
      postedAt: posts.postedAt,
      postUrl: posts.postUrl,
      views: posts.views,
      likes: posts.likes,
      comments: posts.comments,
      errorCode: posts.errorCode,
    })
    .from(posts)
    .where(
      and(
        eq(posts.companyId, scope.companyId),
        inArray(posts.automationSlotId, [...slotIds]),
      ),
    )
    .orderBy(asc(posts.scheduledAtUtc), asc(posts.id));
}

/**
 * Revoca (cancela) los posts **que todavía no salieron** de estos slots.
 * Devuelve cuántos. Lo publicado no se toca (`F-219`).
 */
async function revokePendingPosts(
  exec: Executor,
  scope: TenantScope,
  slotIds: readonly string[],
  statuses: readonly (typeof posts.$inferSelect)["status"][],
): Promise<number> {
  if (slotIds.length === 0) return 0;
  const rows = await exec
    .update(posts)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(
      and(
        eq(posts.companyId, scope.companyId),
        inArray(posts.automationSlotId, [...slotIds]),
        inArray(posts.status, [...statuses]),
      ),
    )
    .returning({ id: posts.id });
  return rows.length;
}

/** Los ids de las campañas de la marca en estos estados. */
async function idsInStatus(
  exec: Executor,
  scope: TenantScope,
  statuses: readonly AutomationRow["status"][],
): Promise<string[]> {
  const rows = await exec
    .select({ id: automations.id })
    .from(automations)
    .where(
      and(
        eq(automations.companyId, scope.companyId),
        inArray(automations.status, [...statuses]),
      ),
    )
    .limit(200);
  return rows.map((r) => r.id);
}

/** Slots de la campaña que **no** están en estos estados (para "¿quedan?"). */
async function slotsNotIn(
  exec: Executor,
  scope: TenantScope,
  automationId: string,
  statuses: readonly SlotStatus[],
): Promise<AutomationSlotRow[]> {
  return exec
    .select()
    .from(automationSlots)
    .where(
      and(
        eq(automationSlots.companyId, scope.companyId),
        eq(automationSlots.automationId, automationId),
        notInArray(automationSlots.status, [...statuses]),
      ),
    )
    .orderBy(asc(automationSlots.slotIndex));
}

/** Agrega un post a `postIds[]` del slot (sin duplicar). */
async function appendPostId(
  exec: Executor,
  scope: TenantScope,
  slotId: string,
  postId: string,
): Promise<void> {
  await exec
    .update(automationSlots)
    .set({
      postIds: sql`case when ${postId}::uuid = any(${automationSlots.postIds}) then ${automationSlots.postIds} else array_append(${automationSlots.postIds}, ${postId}::uuid) end`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(automationSlots.companyId, scope.companyId), eq(automationSlots.id, slotId)),
    );
}

/** Un slot con su campaña (para convertir su slot planificado en post). */
async function slotWithAutomation(
  exec: Executor,
  scope: TenantScope,
  slotId: string,
): Promise<{ slot: AutomationSlotRow; automation: AutomationRow } | null> {
  const rows = await exec
    .select({ slot: automationSlots, automation: automations })
    .from(automationSlots)
    .innerJoin(automations, eq(automations.id, automationSlots.automationId))
    .where(
      and(eq(automationSlots.companyId, scope.companyId), eq(automationSlots.id, slotId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Reserva el slot planificado de un destino (launch). `ON CONFLICT DO NOTHING`
 * sobre `planned_slots_content_network_planned_uq`: si la pieza ya estaba
 * planificada en esa red (programada a mano desde la Library), no se duplica.
 */
async function reservePlannedSlot(
  exec: Executor,
  scope: TenantScope,
  values: {
    readonly contentId: string;
    readonly network: (typeof plannedSlots.$inferInsert)["network"];
    readonly scheduledAtUtc: Date;
    readonly automationSlotId: string;
    readonly connectionId: string | null;
  },
): Promise<boolean> {
  const rows = await exec
    .insert(plannedSlots)
    .values({ ...values, companyId: scope.companyId })
    .onConflictDoNothing()
    .returning({ id: plannedSlots.id });
  return rows.length > 0;
}

export const automationStore = {
  reservePlannedSlot,
  appendPostId,
  slotWithAutomation,
  find: findAutomation,
  lock: lockAutomation,
  create: createAutomation,
  update: updateAutomation,
  delete: deleteAutomation,
  list: listAutomations,
  addQuotaUsed,
  slotCounts,
  idsInStatus,
  listSlots,
  lockSlot,
  insertSlots,
  updateSlot,
  claimPendingSlots,
  releaseStaleGenerating,
  countSlotsIn,
  slotsNotIn,
  usedTexts,
  plannedSlotsOf,
  deletePlannedSlotsOf,
  postsOfSlots,
  revokePendingPosts,
};
