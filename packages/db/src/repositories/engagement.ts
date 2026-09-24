/**
 * Engagement (Reddit) — `P4-ENGAGE-001…012`. Tablas y función de
 * `0021_engagement.sql`.
 *
 * Todo con `TenantScope` salvo {@link listEngagementBrands}, que es la
 * pregunta de arriba del tenant para los crons y pasa por la función
 * `SECURITY DEFINER` (devuelve sólo ids y booleanos).
 *
 * Lo que este archivo **no** hace: componer el score, decidir el tier ni
 * calcular el nivel del medidor. Eso es `@fastgram/core` (`scoreLead`,
 * `computeBanMeter`); acá sólo se guarda lo que core decidió y las respuestas
 * crudas de las que salió.
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  banRiskAssessments,
  engagementReplies,
  engagementSettings,
  leads,
  redditAccounts,
} from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type LeadRow = typeof leads.$inferSelect;
export type EngagementSettingsRow = typeof engagementSettings.$inferSelect;
export type RedditAccountRow = typeof redditAccounts.$inferSelect;
export type EngagementReplyRow = typeof engagementReplies.$inferSelect;
export type BanRiskAssessmentRow = typeof banRiskAssessments.$inferSelect;

/* ------------------------------------------------------------------------ *
 * Marcas (crons)
 * ------------------------------------------------------------------------ */

export interface EngagementBrandRow {
  readonly companyId: string;
  readonly discoveryEnabled: boolean;
  readonly hasRedditAccount: boolean;
}

export async function listEngagementBrands(
  exec: Executor,
): Promise<EngagementBrandRow[]> {
  const rows = (await exec.execute(
    sql`select company_id, discovery_enabled, has_reddit_account from app.engagement_brands()`,
  )) as unknown as Array<{
    company_id: string;
    discovery_enabled: boolean;
    has_reddit_account: boolean;
  }>;
  return rows.map((r) => ({
    companyId: r.company_id,
    discoveryEnabled: r.discovery_enabled,
    hasRedditAccount: r.has_reddit_account,
  }));
}

/* ------------------------------------------------------------------------ *
 * Configuración
 * ------------------------------------------------------------------------ */

export async function findEngagementSettings(
  exec: Executor,
  scope: TenantScope,
): Promise<EngagementSettingsRow | null> {
  const rows = await exec
    .select()
    .from(engagementSettings)
    .where(eq(engagementSettings.companyId, scope.companyId))
    .limit(1);
  return rows[0] ?? null;
}

export type EngagementSettingsValues = Pick<
  typeof engagementSettings.$inferInsert,
  | "subreddits"
  | "keywords"
  | "replyTone"
  | "customRules"
  | "allowLinks"
  | "discoveryEnabled"
>;

export async function saveEngagementSettings(
  exec: Executor,
  scope: TenantScope,
  values: EngagementSettingsValues,
): Promise<EngagementSettingsRow> {
  const rows = await exec
    .insert(engagementSettings)
    .values({ ...values, companyId: scope.companyId })
    .onConflictDoUpdate({
      target: engagementSettings.companyId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("saveEngagementSettings: sin fila");
  return row;
}

export async function recordDiscoveryRun(
  exec: Executor,
  scope: TenantScope,
  run: { readonly at: Date; readonly outcome: string; readonly pausedUntil: Date | null },
): Promise<void> {
  await exec
    .update(engagementSettings)
    .set({
      lastDiscoveryAt: run.at,
      lastDiscoveryOutcome: run.outcome,
      discoveryPausedUntil: run.pausedUntil,
      updatedAt: new Date(),
    })
    .where(eq(engagementSettings.companyId, scope.companyId));
}

/* ------------------------------------------------------------------------ *
 * Cuenta de Reddit
 * ------------------------------------------------------------------------ */

/**
 * `lock` = `FOR UPDATE`, dentro de una transacción: dos refrescos en
 * paralelo no pueden usar el mismo refresh token.
 */
export async function findRedditAccount(
  exec: Executor,
  scope: TenantScope,
  opts: { readonly lock?: boolean } = {},
): Promise<RedditAccountRow | null> {
  const q = exec
    .select()
    .from(redditAccounts)
    .where(eq(redditAccounts.companyId, scope.companyId))
    .limit(1);
  const rows = opts.lock === true ? await q.for("update") : await q;
  return rows[0] ?? null;
}

export interface RedditAccountValues {
  readonly redditUserId: string;
  readonly username: string;
  /** Ciphertext. */
  readonly accessToken: string;
  /** Ciphertext. */
  readonly refreshToken: string | null;
  readonly tokenExpiry: Date | null;
  readonly scopes: readonly string[];
}

export async function saveRedditAccount(
  exec: Executor,
  scope: TenantScope,
  values: RedditAccountValues,
): Promise<RedditAccountRow> {
  const set = {
    ...values,
    scopes: [...values.scopes],
    status: "active",
    statusReason: null,
    updatedAt: new Date(),
  };
  const rows = await exec
    .insert(redditAccounts)
    .values({ ...set, companyId: scope.companyId })
    .onConflictDoUpdate({ target: redditAccounts.companyId, set })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("saveRedditAccount: sin fila");
  return row;
}

export async function updateRedditTokens(
  exec: Executor,
  scope: TenantScope,
  update: {
    readonly accessToken: string;
    readonly refreshToken?: string | null;
    readonly tokenExpiry: Date | null;
  },
): Promise<void> {
  await exec
    .update(redditAccounts)
    .set({
      accessToken: update.accessToken,
      ...(update.refreshToken === undefined ? {} : { refreshToken: update.refreshToken }),
      tokenExpiry: update.tokenExpiry,
      status: "active",
      statusReason: null,
      updatedAt: new Date(),
    })
    .where(eq(redditAccounts.companyId, scope.companyId));
}

/** `revoked` borra los tokens; `expired` los deja (un refresco podría volver). */
export async function markRedditAccount(
  exec: Executor,
  scope: TenantScope,
  status: "expired" | "revoked",
  reason: string,
): Promise<void> {
  await exec
    .update(redditAccounts)
    .set({
      status,
      statusReason: reason,
      ...(status === "revoked"
        ? { accessToken: null, refreshToken: null, tokenExpiry: null }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(redditAccounts.companyId, scope.companyId));
}

/* ------------------------------------------------------------------------ *
 * Leads
 * ------------------------------------------------------------------------ */

export type NewLead = Omit<
  typeof leads.$inferInsert,
  "id" | "companyId" | "createdAt" | "deletedAt"
>;

/** De estos ids de post, cuáles ya existen para la marca (borrados incluidos: F-201). */
export async function knownRedditPostIds(
  exec: Executor,
  scope: TenantScope,
  postIds: readonly string[],
): Promise<Set<string>> {
  if (postIds.length === 0) return new Set();
  const rows = await exec
    .select({ id: leads.redditPostId })
    .from(leads)
    .where(
      and(
        eq(leads.companyId, scope.companyId),
        inArray(leads.redditPostId, [...postIds]),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** Inserta los que no existen. El `UNIQUE (company_id, reddit_post_id)` es la guarda. */
export async function insertLeads(
  exec: Executor,
  scope: TenantScope,
  values: readonly NewLead[],
): Promise<LeadRow[]> {
  if (values.length === 0) return [];
  return exec
    .insert(leads)
    .values(values.map((v) => ({ ...v, companyId: scope.companyId })))
    .onConflictDoNothing({ target: [leads.companyId, leads.redditPostId] })
    .returning();
}

/**
 * Lead a mano (modo sin API). Si el post ya estaba —incluso descartado—, se
 * devuelve ése y se lo restaura: el usuario lo pidió explícitamente.
 */
export async function upsertManualLead(
  exec: Executor,
  scope: TenantScope,
  value: NewLead,
): Promise<{ readonly lead: LeadRow; readonly created: boolean }> {
  const inserted = await insertLeads(exec, scope, [value]);
  if (inserted[0] !== undefined) return { lead: inserted[0], created: true };
  const rows = await exec
    .update(leads)
    .set({ deletedAt: null })
    .where(
      and(
        eq(leads.companyId, scope.companyId),
        eq(leads.redditPostId, value.redditPostId),
      ),
    )
    .returning();
  const lead = rows[0];
  if (lead === undefined) throw new Error("upsertManualLead: sin fila");
  return { lead, created: false };
}

export const LEAD_VIEWS = ["all", "top", "engaged"] as const;
export type LeadView = (typeof LEAD_VIEWS)[number];

export interface LeadListQuery {
  readonly view: LeadView;
  readonly unseenOnly: boolean;
  readonly q?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Visible = tier `top`/`general` (JV-2), **o** todavía sin juzgar (se muestra
 * con esa marca: sin modelo de juicio el módulo no queda vacío), **o**
 * agregado a mano (el usuario lo pidió). `hidden`/`vetoed` no se listan.
 */
const visibleLead = or(
  inArray(leads.leadTier, ["top", "general"]),
  sql`${leads.scoreStatus} <> 'scored'`,
  eq(leads.source, "manual"),
);

export async function listLeads(
  exec: Executor,
  scope: TenantScope,
  query: LeadListQuery,
): Promise<{ readonly items: LeadRow[]; readonly hasMore: boolean }> {
  const conds = [
    eq(leads.companyId, scope.companyId),
    isNull(leads.deletedAt),
    visibleLead,
  ];
  if (query.view === "top") conds.push(eq(leads.leadTier, "top"));
  if (query.unseenOnly) conds.push(or(isNull(leads.seenAt), eq(leads.newActivity, true)));
  const q = query.q?.trim();
  if (q !== undefined && q.length > 0) {
    const pattern = `%${escapeLikePattern(q)}%`;
    conds.push(
      or(
        ilike(leads.title, pattern),
        ilike(leads.body, pattern),
        ilike(leads.subreddit, pattern),
      ),
    );
  }
  const order =
    query.view === "top"
      ? [desc(leads.leadScore), desc(leads.createdAt), desc(leads.id)]
      : query.view === "engaged"
        ? [
            sql`${leads.engagementScore} desc nulls last`,
            desc(leads.createdAt),
            desc(leads.id),
          ]
        : [desc(leads.createdAt), desc(leads.id)];
  const rows = await exec
    .select()
    .from(leads)
    .where(and(...conds))
    .orderBy(...order)
    .limit(query.limit + 1)
    .offset(query.offset);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

export async function findLead(
  exec: Executor,
  scope: TenantScope,
  leadId: string,
): Promise<LeadRow | null> {
  const rows = await exec
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.companyId, scope.companyId),
        eq(leads.id, leadId),
        isNull(leads.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export type LeadPatch = Partial<
  Pick<
    typeof leads.$inferInsert,
    | "whyThisLead"
    | "seenAt"
    | "repliedAt"
    | "threadState"
    | "generatedReply"
    | "score"
    | "engagementScore"
    | "numComments"
    | "contextComments"
    | "subredditRules"
    | "scoreStatus"
    | "scoreAnswers"
    | "scoreVersion"
    | "leadScore"
    | "leadTier"
    | "scoredAt"
    | "replyStatus"
    | "replyError"
    | "replyGeneratedAt"
    | "lastSyncedAt"
    | "ourComments"
    | "repliesToUs"
    | "newActivity"
  >
>;

/** Actualiza un lead vivo. `null` si no existe (o es de otra marca: el 404 lo pone la ruta). */
export async function updateLead(
  exec: Executor,
  scope: TenantScope,
  leadId: string,
  patch: LeadPatch,
): Promise<LeadRow | null> {
  const rows = await exec
    .update(leads)
    .set(patch)
    .where(
      and(
        eq(leads.companyId, scope.companyId),
        eq(leads.id, leadId),
        isNull(leads.deletedAt),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function softDeleteLead(
  exec: Executor,
  scope: TenantScope,
  leadId: string,
  at: Date,
): Promise<boolean> {
  const rows = await exec
    .update(leads)
    .set({ deletedAt: at })
    .where(
      and(
        eq(leads.companyId, scope.companyId),
        eq(leads.id, leadId),
        isNull(leads.deletedAt),
      ),
    )
    .returning({ id: leads.id });
  return rows.length > 0;
}

/** Leads con respuesta desde `since`, los menos revisados primero. */
export async function listLeadsToMonitor(
  exec: Executor,
  scope: TenantScope,
  opts: { readonly since: Date; readonly limit: number },
): Promise<LeadRow[]> {
  return exec
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.companyId, scope.companyId),
        isNull(leads.deletedAt),
        isNotNull(leads.repliedAt),
        gte(leads.repliedAt, opts.since),
      ),
    )
    .orderBy(sql`${leads.lastSyncedAt} asc nulls first`, asc(leads.id))
    .limit(opts.limit);
}

/* ------------------------------------------------------------------------ *
 * Respuestas enviadas
 * ------------------------------------------------------------------------ */

export type NewEngagementReply = Pick<
  typeof engagementReplies.$inferInsert,
  "leadId" | "text" | "channel" | "redditCommentName" | "permalink" | "sentAt"
>;

export async function insertEngagementReply(
  exec: Executor,
  scope: TenantScope,
  value: NewEngagementReply,
): Promise<EngagementReplyRow> {
  const rows = await exec
    .insert(engagementReplies)
    .values({ ...value, companyId: scope.companyId })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("insertEngagementReply: sin fila");
  return row;
}

export async function listLeadReplies(
  exec: Executor,
  scope: TenantScope,
  leadId: string,
): Promise<EngagementReplyRow[]> {
  return exec
    .select()
    .from(engagementReplies)
    .where(
      and(
        eq(engagementReplies.companyId, scope.companyId),
        eq(engagementReplies.leadId, leadId),
      ),
    )
    .orderBy(asc(engagementReplies.sentAt), asc(engagementReplies.id));
}

/** Para el medidor: sólo fecha y etiqueta. El conteo lo hace core. */
export async function listRepliesForMeter(
  exec: Executor,
  scope: TenantScope,
  since: Date,
): Promise<Array<{ sentAt: Date; tone: string | null }>> {
  return exec
    .select({ sentAt: engagementReplies.sentAt, tone: engagementReplies.tone })
    .from(engagementReplies)
    .where(
      and(
        eq(engagementReplies.companyId, scope.companyId),
        gte(engagementReplies.sentAt, since),
      ),
    )
    .orderBy(asc(engagementReplies.sentAt));
}

export interface UnlabeledReply {
  readonly reply: EngagementReplyRow;
  readonly leadTitle: string;
  readonly leadBody: string | null;
}

export async function listUnlabeledReplies(
  exec: Executor,
  scope: TenantScope,
  opts: { readonly since: Date; readonly limit: number },
): Promise<UnlabeledReply[]> {
  const rows = await exec
    .select({ reply: engagementReplies, leadTitle: leads.title, leadBody: leads.body })
    .from(engagementReplies)
    .innerJoin(
      leads,
      and(
        eq(leads.id, engagementReplies.leadId),
        eq(leads.companyId, engagementReplies.companyId),
      ),
    )
    .where(
      and(
        eq(engagementReplies.companyId, scope.companyId),
        isNull(engagementReplies.tone),
        gte(engagementReplies.sentAt, opts.since),
      ),
    )
    .orderBy(asc(engagementReplies.sentAt))
    .limit(opts.limit);
  return rows;
}

export async function setReplyTone(
  exec: Executor,
  scope: TenantScope,
  replyId: string,
  label: {
    readonly tone: string;
    readonly answers: Record<string, unknown>;
    readonly version: string;
    readonly at: Date;
  },
): Promise<void> {
  await exec
    .update(engagementReplies)
    .set({
      tone: label.tone,
      toneAnswers: label.answers,
      toneVersion: label.version,
      classifiedAt: label.at,
    })
    .where(
      and(
        eq(engagementReplies.companyId, scope.companyId),
        eq(engagementReplies.id, replyId),
      ),
    );
}

/* ------------------------------------------------------------------------ *
 * Ban meter (DATA-025)
 * ------------------------------------------------------------------------ */

export type BanAssessmentValues = Pick<
  typeof banRiskAssessments.$inferInsert,
  | "level"
  | "promoRatio"
  | "recommendation"
  | "computedAt"
  | "sampleSize"
  | "counts"
  | "windowDays"
  | "smallSample"
>;

export async function saveBanAssessment(
  exec: Executor,
  scope: TenantScope,
  values: BanAssessmentValues,
): Promise<void> {
  await exec
    .insert(banRiskAssessments)
    .values({ ...values, companyId: scope.companyId })
    .onConflictDoUpdate({
      target: banRiskAssessments.companyId,
      set: { ...values, updatedAt: new Date() },
    });
}

export async function findBanAssessment(
  exec: Executor,
  scope: TenantScope,
): Promise<BanRiskAssessmentRow | null> {
  const rows = await exec
    .select()
    .from(banRiskAssessments)
    .where(eq(banRiskAssessments.companyId, scope.companyId))
    .limit(1);
  return rows[0] ?? null;
}

export const engagementStore = {
  listBrands: listEngagementBrands,
  findSettings: findEngagementSettings,
  saveSettings: saveEngagementSettings,
  recordDiscoveryRun,
  findRedditAccount,
  saveRedditAccount,
  updateRedditTokens,
  markRedditAccount,
  knownRedditPostIds,
  insertLeads,
  upsertManualLead,
  listLeads,
  findLead,
  updateLead,
  softDeleteLead,
  listLeadsToMonitor,
  insertReply: insertEngagementReply,
  listLeadReplies,
  listRepliesForMeter,
  listUnlabeledReplies,
  setReplyTone,
  saveBanAssessment,
  findBanAssessment,
};
