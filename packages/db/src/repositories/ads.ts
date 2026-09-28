/**
 * Anuncios pagos — sprint 9 (R), migración `0040`, `D-21`.
 *
 * Todo con `TenantScope` y bajo RLS (las siete tablas están en
 * `COMPANY_SCOPED_TABLES`). Un id de otra marca da `null`/nada; el 404 lo pone
 * la ruta.
 *
 * Dos guardas viven en la **sentencia**, no en una lectura previa (trampa 37):
 *  - consumir un preview de confirmación: `UPDATE … WHERE consumed_at IS NULL
 *    AND expires_at > now` (dos activaciones con el mismo token → una gana);
 *  - el corte de la guardia: `UPDATE … WHERE status = 'ACTIVE'` (dos vueltas
 *    del job → un solo aviso).
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  adAccounts,
  adActions,
  adCampaigns,
  adExperiments,
  adInsightsDaily,
  ads,
  adSets,
  type AdAccountStatus,
  type AdActionKind,
  type AdCampaignStatus,
  type AdPauseReason,
} from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type AdAccountRow = typeof adAccounts.$inferSelect;
export type AdCampaignRow = typeof adCampaigns.$inferSelect;
export type AdSetRow = typeof adSets.$inferSelect;
export type AdRow = typeof ads.$inferSelect;
export type AdExperimentRow = typeof adExperiments.$inferSelect;
export type AdActionRow = typeof adActions.$inferSelect;
export type AdInsightDailyRow = typeof adInsightsDaily.$inferSelect;

/* ------------------------------------------------------------------------ *
 * Marcas del barrido (sin tenant)
 * ------------------------------------------------------------------------ */

export async function listAdsSyncBrands(
  exec: Executor,
): Promise<{ readonly companyId: string; readonly name: string }[]> {
  const rows = (await exec.execute(
    sql`select company_id, name from app.ads_sync_brands()`,
  )) as unknown as Array<{ company_id: string; name: string }>;
  return rows.map((r) => ({ companyId: r.company_id, name: r.name }));
}

/* ------------------------------------------------------------------------ *
 * Cuenta publicitaria de la marca
 * ------------------------------------------------------------------------ */

export const adAccountRepository = {
  async load(exec: Executor, scope: TenantScope): Promise<AdAccountRow | null> {
    const rows = await exec
      .select()
      .from(adAccounts)
      .where(eq(adAccounts.companyId, scope.companyId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Después del login: token guardado, falta elegir cuenta y Página. */
  async upsertPending(
    exec: Executor,
    scope: TenantScope,
    value: {
      readonly provider: "meta" | "fake";
      readonly accessToken: string | null;
      readonly tokenExpiresAt: Date | null;
      readonly metaUserId: string | null;
      readonly now: Date;
    },
  ): Promise<AdAccountRow> {
    const set = {
      provider: value.provider,
      status: "pending" as AdAccountStatus,
      accessToken: value.accessToken,
      tokenExpiresAt: value.tokenExpiresAt,
      metaUserId: value.metaUserId,
      updatedAt: value.now,
    };
    const rows = await exec
      .insert(adAccounts)
      .values({ companyId: scope.companyId, ...set })
      .onConflictDoUpdate({ target: adAccounts.companyId, set })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("ad_accounts upsert returned nothing");
    return row;
  },

  async select(
    exec: Executor,
    scope: TenantScope,
    value: {
      readonly adAccountId: string;
      readonly adAccountName: string;
      readonly currency: string;
      readonly timezoneName: string | null;
      readonly pageId: string;
      readonly pageName: string;
      readonly instagramUserId: string | null;
      readonly instagramUsername: string | null;
      readonly now: Date;
    },
  ): Promise<AdAccountRow | null> {
    const rows = await exec
      .update(adAccounts)
      .set({
        status: "active",
        adAccountId: value.adAccountId,
        adAccountName: value.adAccountName,
        currency: value.currency,
        timezoneName: value.timezoneName,
        pageId: value.pageId,
        pageName: value.pageName,
        instagramUserId: value.instagramUserId,
        instagramUsername: value.instagramUsername,
        connectedAt: value.now,
        updatedAt: value.now,
      })
      .where(eq(adAccounts.companyId, scope.companyId))
      .returning();
    return rows[0] ?? null;
  },

  async setStatus(
    exec: Executor,
    scope: TenantScope,
    status: AdAccountStatus,
    now: Date,
  ): Promise<void> {
    await exec
      .update(adAccounts)
      .set({
        status,
        updatedAt: now,
        ...(status === "revoked" ? { accessToken: null } : {}),
      })
      .where(eq(adAccounts.companyId, scope.companyId));
  },
};

/* ------------------------------------------------------------------------ *
 * Campañas
 * ------------------------------------------------------------------------ */

export interface NewAdCampaignTree {
  readonly campaign: Omit<
    typeof adCampaigns.$inferInsert,
    "id" | "companyId" | "createdAt" | "updatedAt" | "status" | "pausedReason"
  >;
  readonly adSets: readonly {
    readonly key: string;
    readonly name: string;
    readonly variantLabel: string | null;
    readonly dailyBudgetMinor: number;
    readonly platformAdSetId: string;
  }[];
  readonly ads: readonly {
    readonly adSetKey: string;
    readonly contentId: string | null;
    readonly name: string;
    readonly mediaKind: "video" | "image";
    readonly message: string;
    readonly platformAdId: string;
    readonly platformCreativeId: string;
  }[];
  readonly experiment: {
    readonly metric: "ctr" | "cvr";
    readonly platformStudyId: string | null;
    readonly platformStudyError: string | null;
  } | null;
  readonly now: Date;
}

export interface AdCampaignTree {
  readonly campaign: AdCampaignRow;
  readonly adSets: readonly AdSetRow[];
  readonly ads: readonly AdRow[];
  readonly experiment: AdExperimentRow | null;
}

export const adCampaignRepository = {
  /** Todo lo creado en Meta, de una vez. Nace `PAUSED` (`created`). */
  async insertTree(
    exec: Executor,
    scope: TenantScope,
    tree: NewAdCampaignTree,
  ): Promise<AdCampaignTree> {
    const companyId = scope.companyId;
    const [campaign] = await exec
      .insert(adCampaigns)
      .values({
        ...tree.campaign,
        companyId,
        status: "PAUSED",
        pausedReason: "created",
        pausedAt: null,
      })
      .returning();
    if (campaign === undefined) throw new Error("ad_campaigns insert returned nothing");
    const setRows: AdSetRow[] = [];
    const idByKey = new Map<string, string>();
    for (const s of tree.adSets) {
      const [row] = await exec
        .insert(adSets)
        .values({
          companyId,
          campaignId: campaign.id,
          name: s.name,
          variantLabel: s.variantLabel,
          dailyBudgetMinor: s.dailyBudgetMinor,
          platformAdSetId: s.platformAdSetId,
        })
        .returning();
      if (row === undefined) throw new Error("ad_sets insert returned nothing");
      setRows.push(row);
      idByKey.set(s.key, row.id);
    }
    const adRows: AdRow[] = [];
    for (const a of tree.ads) {
      const adSetId = idByKey.get(a.adSetKey);
      if (adSetId === undefined) throw new Error(`unknown ad set key ${a.adSetKey}`);
      const [row] = await exec
        .insert(ads)
        .values({
          companyId,
          campaignId: campaign.id,
          adSetId,
          contentId: a.contentId,
          name: a.name,
          mediaKind: a.mediaKind,
          message: a.message,
          platformAdId: a.platformAdId,
          platformCreativeId: a.platformCreativeId,
        })
        .returning();
      if (row === undefined) throw new Error("ads insert returned nothing");
      adRows.push(row);
    }
    let experiment: AdExperimentRow | null = null;
    if (tree.experiment !== null) {
      const [row] = await exec
        .insert(adExperiments)
        .values({ companyId, campaignId: campaign.id, ...tree.experiment })
        .returning();
      experiment = row ?? null;
    }
    await exec.insert(adActions).values({
      companyId,
      campaignId: campaign.id,
      kind: "create",
      actor: "owner",
      dailyCapMinor: campaign.dailyCapMinor,
      totalCapMinor: campaign.totalCapMinor,
      detail: { adSets: setRows.length, ads: adRows.length },
    });
    return { campaign, adSets: setRows, ads: adRows, experiment };
  },

  async list(exec: Executor, scope: TenantScope): Promise<AdCampaignRow[]> {
    return exec
      .select()
      .from(adCampaigns)
      .where(eq(adCampaigns.companyId, scope.companyId))
      .orderBy(desc(adCampaigns.createdAt), desc(adCampaigns.id));
  },

  async load(
    exec: Executor,
    scope: TenantScope,
    id: string,
  ): Promise<AdCampaignTree | null> {
    const [campaign] = await exec
      .select()
      .from(adCampaigns)
      .where(and(eq(adCampaigns.companyId, scope.companyId), eq(adCampaigns.id, id)))
      .limit(1);
    if (campaign === undefined) return null;
    const where = (t: typeof adSets | typeof ads) =>
      and(eq(t.companyId, scope.companyId), eq(t.campaignId, id));
    const setRows = await exec
      .select()
      .from(adSets)
      .where(where(adSets))
      .orderBy(asc(adSets.variantLabel), asc(adSets.createdAt));
    const adRows = await exec
      .select()
      .from(ads)
      .where(where(ads))
      .orderBy(asc(ads.createdAt));
    const [experiment] = await exec
      .select()
      .from(adExperiments)
      .where(
        and(
          eq(adExperiments.companyId, scope.companyId),
          eq(adExperiments.campaignId, id),
        ),
      )
      .limit(1);
    return { campaign, adSets: setRows, ads: adRows, experiment: experiment ?? null };
  },

  /** Cambio de estado pedido por el dueño (activar / pausar / archivar). */
  async setStatus(
    exec: Executor,
    scope: TenantScope,
    id: string,
    status: AdCampaignStatus,
    reason: AdPauseReason | null,
    now: Date,
  ): Promise<AdCampaignRow | null> {
    const rows = await exec
      .update(adCampaigns)
      .set({
        status,
        pausedReason: status === "ACTIVE" ? null : reason,
        ...(status === "ACTIVE"
          ? { activatedAt: now, pausedAt: null }
          : { pausedAt: now }),
        updatedAt: now,
      })
      .where(and(eq(adCampaigns.companyId, scope.companyId), eq(adCampaigns.id, id)))
      .returning();
    return rows[0] ?? null;
  },

  async updateCaps(
    exec: Executor,
    scope: TenantScope,
    id: string,
    caps: { readonly dailyCapMinor: number; readonly totalCapMinor: number },
    budgets: readonly { readonly adSetId: string; readonly dailyBudgetMinor: number }[],
    now: Date,
  ): Promise<AdCampaignRow | null> {
    for (const b of budgets) {
      await exec
        .update(adSets)
        .set({ dailyBudgetMinor: b.dailyBudgetMinor, updatedAt: now })
        .where(
          and(
            eq(adSets.companyId, scope.companyId),
            eq(adSets.campaignId, id),
            eq(adSets.id, b.adSetId),
          ),
        );
    }
    const rows = await exec
      .update(adCampaigns)
      .set({ ...caps, updatedAt: now })
      .where(and(eq(adCampaigns.companyId, scope.companyId), eq(adCampaigns.id, id)))
      .returning();
    return rows[0] ?? null;
  },

  async setWinner(
    exec: Executor,
    scope: TenantScope,
    campaignId: string,
    winnerAdSetId: string | null,
    now: Date,
  ): Promise<void> {
    await exec
      .update(adExperiments)
      .set({
        winnerAdSetId,
        decidedAt: winnerAdSetId === null ? null : now,
        updatedAt: now,
      })
      .where(
        and(
          eq(adExperiments.companyId, scope.companyId),
          eq(adExperiments.campaignId, campaignId),
          // Un ganador declarado no se pisa con "sin ganador" por un sync.
          winnerAdSetId === null ? isNull(adExperiments.winnerAdSetId) : sql`true`,
        ),
      );
  },
};

/* ------------------------------------------------------------------------ *
 * Acciones y previews de confirmación
 * ------------------------------------------------------------------------ */

export const adActionRepository = {
  async insertPreview(
    exec: Executor,
    scope: TenantScope,
    value: {
      readonly campaignId: string;
      readonly previewAction: "activate" | "budget_increase";
      readonly token: string;
      readonly dailyCapMinor: number;
      readonly totalCapMinor: number;
      readonly maxSpendMinor: number;
      readonly expiresAt: Date;
      readonly detail: Record<string, unknown>;
    },
  ): Promise<AdActionRow> {
    const [row] = await exec
      .insert(adActions)
      .values({
        companyId: scope.companyId,
        campaignId: value.campaignId,
        kind: "activation_preview",
        actor: "owner",
        previewAction: value.previewAction,
        confirmationToken: value.token,
        dailyCapMinor: value.dailyCapMinor,
        totalCapMinor: value.totalCapMinor,
        maxSpendMinor: value.maxSpendMinor,
        expiresAt: value.expiresAt,
        detail: value.detail,
      })
      .returning();
    if (row === undefined) throw new Error("ad_actions insert returned nothing");
    return row;
  },

  async loadPreview(
    exec: Executor,
    scope: TenantScope,
    token: string,
  ): Promise<AdActionRow | null> {
    const rows = await exec
      .select()
      .from(adActions)
      .where(
        and(
          eq(adActions.companyId, scope.companyId),
          eq(adActions.kind, "activation_preview"),
          eq(adActions.confirmationToken, token),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Un solo uso, en la sentencia. `false` si ya se usó o venció. */
  async consumePreview(
    exec: Executor,
    scope: TenantScope,
    previewId: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await exec
      .update(adActions)
      .set({ consumedAt: now })
      .where(
        and(
          eq(adActions.companyId, scope.companyId),
          eq(adActions.id, previewId),
          isNull(adActions.consumedAt),
          gt(adActions.expiresAt, now),
        ),
      )
      .returning({ id: adActions.id });
    return rows.length === 1;
  },

  async insert(
    exec: Executor,
    scope: TenantScope,
    value: {
      readonly campaignId: string;
      readonly kind: Exclude<AdActionKind, "activation_preview">;
      readonly actor: "owner" | "guard";
      readonly previewId?: string | null;
      readonly dailyCapMinor?: number | null;
      readonly totalCapMinor?: number | null;
      readonly maxSpendMinor?: number | null;
      readonly detail?: Record<string, unknown>;
      readonly at?: Date;
    },
  ): Promise<void> {
    await exec.insert(adActions).values({
      companyId: scope.companyId,
      campaignId: value.campaignId,
      kind: value.kind,
      actor: value.actor,
      previewId: value.previewId ?? null,
      dailyCapMinor: value.dailyCapMinor ?? null,
      totalCapMinor: value.totalCapMinor ?? null,
      maxSpendMinor: value.maxSpendMinor ?? null,
      detail: value.detail ?? {},
      ...(value.at === undefined ? {} : { createdAt: value.at }),
    });
  },

  async list(
    exec: Executor,
    scope: TenantScope,
    campaignId: string,
    limit = 50,
  ): Promise<AdActionRow[]> {
    return exec
      .select()
      .from(adActions)
      .where(
        and(
          eq(adActions.companyId, scope.companyId),
          eq(adActions.campaignId, campaignId),
        ),
      )
      .orderBy(desc(adActions.createdAt))
      .limit(limit);
  },

  /** Cambios de presupuesto recientes (para el límite de 4 por hora de Meta). */
  async budgetChangesSince(
    exec: Executor,
    scope: TenantScope,
    campaignId: string,
    since: Date,
  ): Promise<Date[]> {
    const rows = await exec
      .select({ at: adActions.createdAt })
      .from(adActions)
      .where(
        and(
          eq(adActions.companyId, scope.companyId),
          eq(adActions.campaignId, campaignId),
          eq(adActions.kind, "budget_change"),
          gte(adActions.createdAt, since),
        ),
      );
    return rows.map((r) => r.at);
  },
};

/* ------------------------------------------------------------------------ *
 * Insights
 * ------------------------------------------------------------------------ */

export interface AdInsightInput {
  readonly adId: string;
  readonly date: string;
  readonly spendMinor: number;
  readonly impressions: number;
  readonly clicks: number;
  readonly reach: number | null;
  readonly actions: Readonly<Record<string, number>>;
  readonly actionValuesMinor: Readonly<Record<string, number>>;
}

export const adInsightsRepository = {
  async upsert(
    exec: Executor,
    scope: TenantScope,
    campaignId: string,
    rows: readonly AdInsightInput[],
    now: Date,
  ): Promise<void> {
    for (const r of rows) {
      const values = {
        spendMinor: r.spendMinor,
        impressions: r.impressions,
        clicks: r.clicks,
        reach: r.reach,
        actions: r.actions,
        actionValuesMinor: r.actionValuesMinor,
        syncedAt: now,
      };
      await exec
        .insert(adInsightsDaily)
        .values({
          companyId: scope.companyId,
          campaignId,
          adId: r.adId,
          date: r.date,
          ...values,
        })
        .onConflictDoUpdate({
          target: [adInsightsDaily.companyId, adInsightsDaily.adId, adInsightsDaily.date],
          set: values,
        });
    }
  },

  async spendOf(
    exec: Executor,
    scope: TenantScope,
    campaignId: string,
    today: string,
  ): Promise<{ todayMinor: number; totalMinor: number }> {
    const rows = await exec
      .select({
        total: sql<string>`coalesce(sum(${adInsightsDaily.spendMinor}), 0)`,
        today: sql<string>`coalesce(sum(${adInsightsDaily.spendMinor}) filter (where ${adInsightsDaily.date} = ${today}), 0)`,
      })
      .from(adInsightsDaily)
      .where(
        and(
          eq(adInsightsDaily.companyId, scope.companyId),
          eq(adInsightsDaily.campaignId, campaignId),
        ),
      );
    const r = rows[0];
    return { todayMinor: Number(r?.today ?? 0), totalMinor: Number(r?.total ?? 0) };
  },

  /** Filas diarias de varias campañas (o todas) en un rango, inclusive. */
  async list(
    exec: Executor,
    scope: TenantScope,
    filter: {
      readonly campaignIds?: readonly string[];
      readonly from?: string;
      readonly to?: string;
    } = {},
  ): Promise<AdInsightDailyRow[]> {
    const conds = [eq(adInsightsDaily.companyId, scope.companyId)];
    if (filter.campaignIds !== undefined) {
      if (filter.campaignIds.length === 0) return [];
      conds.push(inArray(adInsightsDaily.campaignId, [...filter.campaignIds]));
    }
    if (filter.from !== undefined) conds.push(gte(adInsightsDaily.date, filter.from));
    if (filter.to !== undefined) conds.push(lte(adInsightsDaily.date, filter.to));
    return exec
      .select()
      .from(adInsightsDaily)
      .where(and(...conds))
      .orderBy(asc(adInsightsDaily.date));
  },
};

/* ------------------------------------------------------------------------ *
 * El store de la guardia (`AdsSyncStore` de `@fastgram/core`, por forma)
 * ------------------------------------------------------------------------ */

type Breach = "daily_cap" | "total_cap";

/**
 * Implementa `AdsSyncStore` (`core/ads/guard.ts`) sobre una transacción con la
 * marca puesta. `db` no importa `core`: la compatibilidad es estructural y la
 * chequea el compilador donde se pasa (`apps/api`, `apps/worker`).
 */
export function adsSyncStore(exec: Executor, scope: TenantScope) {
  return {
    async listCampaigns() {
      const campaigns = await exec
        .select()
        .from(adCampaigns)
        .where(eq(adCampaigns.companyId, scope.companyId));
      if (campaigns.length === 0) return [];
      const adRows = await exec
        .select({
          id: ads.id,
          campaignId: ads.campaignId,
          platformAdId: ads.platformAdId,
        })
        .from(ads)
        .where(eq(ads.companyId, scope.companyId));
      return campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        platformCampaignId: c.platformCampaignId,
        caps: { dailyCapMinor: c.dailyCapMinor, totalCapMinor: c.totalCapMinor },
        startDate: c.startDate,
        pausedAt: c.pausedAt,
        adIdByPlatformId: Object.fromEntries(
          adRows.filter((a) => a.campaignId === c.id).map((a) => [a.platformAdId, a.id]),
        ),
      }));
    },

    async saveInsights(campaignId: string, rows: readonly AdInsightInput[]) {
      await adInsightsRepository.upsert(exec, scope, campaignId, rows, new Date());
    },

    spendOf(campaignId: string, today: string) {
      return adInsightsRepository.spendOf(exec, scope, campaignId, today);
    },

    async markCapPaused(
      campaignId: string,
      breach: Breach,
      spend: { readonly todayMinor: number; readonly totalMinor: number },
      at: Date,
    ) {
      const rows = await exec
        .update(adCampaigns)
        .set({ status: "PAUSED", pausedReason: breach, pausedAt: at, updatedAt: at })
        .where(
          and(
            eq(adCampaigns.companyId, scope.companyId),
            eq(adCampaigns.id, campaignId),
            eq(adCampaigns.status, "ACTIVE"),
          ),
        )
        .returning({
          daily: adCampaigns.dailyCapMinor,
          total: adCampaigns.totalCapMinor,
        });
      const row = rows[0];
      if (row === undefined) return false;
      await adActionRepository.insert(exec, scope, {
        campaignId,
        kind: "cap_pause",
        actor: "guard",
        dailyCapMinor: row.daily,
        totalCapMinor: row.total,
        detail: {
          breach,
          spentTodayMinor: spend.todayMinor,
          spentTotalMinor: spend.totalMinor,
        },
        at,
      });
      return true;
    },

    async recordPauseFailure(
      campaignId: string,
      breach: Breach,
      reason: string,
      at: Date,
    ) {
      await adActionRepository.insert(exec, scope, {
        campaignId,
        kind: "cap_pause_failed",
        actor: "guard",
        detail: { breach, reason },
        at,
      });
    },

    async markSynced(campaignId: string, at: Date, errorReason: string | null) {
      await exec
        .update(adCampaigns)
        .set({
          lastSyncError: errorReason,
          ...(errorReason === null ? { lastSyncedAt: at } : {}),
        })
        .where(
          and(eq(adCampaigns.companyId, scope.companyId), eq(adCampaigns.id, campaignId)),
        );
    },
  };
}
