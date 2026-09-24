/**
 * Métricas de vuelta, auto-tune del mix y lecturas de `/analytics` —
 * `PU-AUTO-004`, `P3-ANALYT-001/002`. Tablas y columnas de `0018_metrics_sync.sql`.
 *
 * Todo con `TenantScope` salvo {@link metricsStore.syncBrands}, que es la
 * excepción documentada en la migración: devuelve **sólo ids de marca** para
 * el cron, por una función `SECURITY DEFINER`.
 */
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  blitzPreferences,
  contentMixAutotune,
  contents,
  formatMixAdjustments,
  posts,
  type MixAdjustmentActor,
} from "../schema/index.js";
import type { TenantScope } from "./base.js";

export const POST_METRIC_COLUMNS = ["views", "likes", "comments", "shares"] as const;
export type PostMetricColumn = (typeof POST_METRIC_COLUMNS)[number];

export interface MetricsSyncPostRow {
  readonly id: string;
  readonly platform: string;
  readonly connectionId: string;
  readonly externalPostId: string;
  readonly postedAt: Date;
  readonly metricsSyncedAt: Date | null;
}

export interface PostMetricsWrite {
  /** Las que vinieron. Las que no, quedan en 0 y van a `missing`. */
  readonly values: Readonly<Partial<Record<PostMetricColumn, number>>>;
  readonly syncedAt: Date;
}

export interface AnalyticsPostRow {
  readonly id: string;
  readonly platform: string;
  readonly contentType: string;
  readonly postedAt: Date;
  readonly metricsSyncedAt: Date | null;
  readonly views: number;
  readonly likes: number;
  readonly comments: number;
  readonly shares: number;
  readonly metricsMissing: readonly string[];
  readonly metricsErrorCode: string | null;
  readonly postUrl: string | null;
  readonly caption: string | null;
}

export type ContentMixAutotuneRow = typeof contentMixAutotune.$inferSelect;
export type FormatMixAdjustmentRow = typeof formatMixAdjustments.$inferSelect;

export interface FormatWeightsRow {
  readonly slideshowWeight: number;
  readonly wallOfTextWeight: number;
  readonly greenScreenWeight: number;
  readonly videoHookWeight: number;
}

const analyticsSelection = {
  id: posts.id,
  platform: posts.platform,
  contentType: contents.type,
  postedAt: posts.postedAt,
  metricsSyncedAt: posts.metricsSyncedAt,
  views: posts.views,
  likes: posts.likes,
  comments: posts.comments,
  shares: posts.shares,
  metricsMissing: posts.metricsMissing,
  metricsErrorCode: posts.metricsErrorCode,
  postUrl: posts.postUrl,
  caption: posts.caption,
};

function postedInScope(scope: TenantScope) {
  return and(eq(posts.companyId, scope.companyId), eq(posts.status, "POSTED"));
}

export const metricsStore = {
  /**
   * Las marcas con trabajo para el cron: posts `POSTED` desde `since` con id en
   * la plataforma, o auto-tune prendido. **Sin scope, a propósito** — ver la
   * cabecera de `0018`. Corre con `withoutCompany`.
   */
  async syncBrands(exec: Executor, since: Date): Promise<string[]> {
    // `since` como texto ISO y cast del lado del servidor: trampa 18 (un
    // `Date` en un `sql` crudo llega sin serializar al protocolo).
    const rows = await exec.execute<{ company_id: string }>(
      sql`select company_id from app.metrics_sync_brands(${since.toISOString()}::timestamptz)`,
    );
    return rows.map((r) => r.company_id);
  },

  /** Los posts de la marca que el sync puede leer: `POSTED`, OAuth, con id externo. */
  async listSyncable(
    exec: Executor,
    scope: TenantScope,
    since: Date,
    limit: number,
  ): Promise<MetricsSyncPostRow[]> {
    const rows = await exec
      .select({
        id: posts.id,
        platform: posts.platform,
        connectionId: posts.connectionId,
        externalPostId: posts.externalPostId,
        postedAt: posts.postedAt,
        metricsSyncedAt: posts.metricsSyncedAt,
      })
      .from(posts)
      .where(
        and(
          postedInScope(scope),
          gte(posts.postedAt, since),
          isNotNull(posts.externalPostId),
          isNotNull(posts.connectionId),
          eq(posts.accountType, "oauth"),
        ),
      )
      .orderBy(desc(posts.postedAt))
      .limit(limit);
    const out: MetricsSyncPostRow[] = [];
    for (const r of rows) {
      // Los `isNotNull` del WHERE ya lo garantizan; el tipo de Drizzle no lo sabe.
      if (r.connectionId === null || r.externalPostId === null || r.postedAt === null)
        continue;
      out.push({
        id: r.id,
        platform: r.platform,
        connectionId: r.connectionId,
        externalPostId: r.externalPostId,
        postedAt: r.postedAt,
        metricsSyncedAt: r.metricsSyncedAt,
      });
    }
    return out;
  },

  /**
   * Escribe el resultado de un sync. Sólo sobre un post que sigue `POSTED`
   * (uno borrado mientras tanto no revive métricas). `false` si no tocó nada.
   */
  async writeMetrics(
    exec: Executor,
    scope: TenantScope,
    postId: string,
    write: PostMetricsWrite,
  ): Promise<boolean> {
    const missing = POST_METRIC_COLUMNS.filter((m) => write.values[m] === undefined);
    const rows = await exec
      .update(posts)
      .set({
        views: write.values.views ?? 0,
        likes: write.values.likes ?? 0,
        comments: write.values.comments ?? 0,
        shares: write.values.shares ?? 0,
        metricsMissing: missing,
        metricsSyncedAt: write.syncedAt,
        metricsErrorCode: null,
        updatedAt: new Date(),
      })
      .where(and(postedInScope(scope), eq(posts.id, postId)))
      .returning({ id: posts.id });
    return rows.length > 0;
  },

  /**
   * Deja el motivo de un sync fallido **sin tocar** las métricas ni
   * `metricsSyncedAt`: lo último bueno sigue siendo lo último bueno.
   */
  async markError(
    exec: Executor,
    scope: TenantScope,
    postIds: readonly string[],
    code: string,
  ): Promise<number> {
    if (postIds.length === 0) return 0;
    const rows = await exec
      .update(posts)
      .set({ metricsErrorCode: code, updatedAt: new Date() })
      .where(and(postedInScope(scope), inArray(posts.id, [...postIds])))
      .returning({ id: posts.id });
    return rows.length;
  },

  /** Posts `POSTED` con `postedAt` en `[from, to)`, con el tipo de su contenido. */
  async listForAnalytics(
    exec: Executor,
    scope: TenantScope,
    range: { readonly from: Date; readonly to: Date; readonly limit: number },
  ): Promise<AnalyticsPostRow[]> {
    const rows = await exec
      .select(analyticsSelection)
      .from(posts)
      .innerJoin(
        contents,
        and(eq(contents.id, posts.contentId), eq(contents.companyId, scope.companyId)),
      )
      .where(
        and(
          postedInScope(scope),
          gte(posts.postedAt, range.from),
          lt(posts.postedAt, range.to),
        ),
      )
      .orderBy(desc(posts.postedAt))
      .limit(range.limit);
    return rows.flatMap((r) =>
      r.postedAt === null ? [] : [{ ...r, postedAt: r.postedAt }],
    );
  },
};

export const mixTuningStore = {
  /** `null` = sin fila = apagado. */
  async find(exec: Executor, scope: TenantScope): Promise<ContentMixAutotuneRow | null> {
    const rows = await exec
      .select()
      .from(contentMixAutotune)
      .where(eq(contentMixAutotune.companyId, scope.companyId))
      .limit(1);
    return rows[0] ?? null;
  },

  async setEnabled(
    exec: Executor,
    scope: TenantScope,
    enabled: boolean,
  ): Promise<ContentMixAutotuneRow> {
    const rows = await exec
      .insert(contentMixAutotune)
      .values({ companyId: scope.companyId, enabled })
      .onConflictDoUpdate({
        target: contentMixAutotune.companyId,
        set: { enabled, updatedAt: new Date() },
      })
      .returning();
    const row = rows[0];
    if (row === undefined)
      throw new Error("El upsert de content_mix_autotune no devolvió fila.");
    return row;
  },

  async recordRun(
    exec: Executor,
    scope: TenantScope,
    run: { readonly at: Date; readonly outcome: string },
  ): Promise<void> {
    await exec
      .update(contentMixAutotune)
      .set({ lastRunAt: run.at, lastOutcome: run.outcome, updatedAt: new Date() })
      .where(eq(contentMixAutotune.companyId, scope.companyId));
  },

  /**
   * Los cuatro pesos **con lock** (`FOR UPDATE`), para que un ajuste no pise
   * un cambio a mano del usuario que llegó entre la lectura y la escritura.
   * `null` = la marca no tiene fila (usa los defaults de `core`).
   */
  async lockWeights(
    exec: Executor,
    scope: TenantScope,
  ): Promise<FormatWeightsRow | null> {
    const rows = await exec
      .select({
        slideshowWeight: blitzPreferences.slideshowWeight,
        wallOfTextWeight: blitzPreferences.wallOfTextWeight,
        greenScreenWeight: blitzPreferences.greenScreenWeight,
        videoHookWeight: blitzPreferences.videoHookWeight,
      })
      .from(blitzPreferences)
      .where(eq(blitzPreferences.companyId, scope.companyId))
      .for("update")
      .limit(1);
    return rows[0] ?? null;
  },

  async recordAdjustment(
    exec: Executor,
    scope: TenantScope,
    adjustment: {
      readonly actor: MixAdjustmentActor;
      readonly from: Readonly<Record<string, number>>;
      readonly to: Readonly<Record<string, number>>;
      readonly stats: unknown;
      readonly at: Date;
    },
  ): Promise<FormatMixAdjustmentRow> {
    const rows = await exec
      .insert(formatMixAdjustments)
      .values({
        companyId: scope.companyId,
        actor: adjustment.actor,
        fromWeights: adjustment.from,
        toWeights: adjustment.to,
        stats: adjustment.stats,
        createdAt: adjustment.at,
      })
      .returning();
    const row = rows[0];
    if (row === undefined)
      throw new Error("El insert de format_mix_adjustments no devolvió fila.");
    return row;
  },

  async listAdjustments(
    exec: Executor,
    scope: TenantScope,
    limit: number,
  ): Promise<FormatMixAdjustmentRow[]> {
    return exec
      .select()
      .from(formatMixAdjustments)
      .where(eq(formatMixAdjustments.companyId, scope.companyId))
      .orderBy(desc(formatMixAdjustments.createdAt), desc(formatMixAdjustments.id))
      .limit(limit);
  },

  /**
   * Los posts medidos desde `since`, con su formato: la materia prima de la
   * muestra del auto-tune (`selectMixSamples` en `core` elige cuáles entran).
   */
  async listMeasured(
    exec: Executor,
    scope: TenantScope,
    since: Date,
    limit: number,
  ): Promise<AnalyticsPostRow[]> {
    const rows = await exec
      .select(analyticsSelection)
      .from(posts)
      .innerJoin(
        contents,
        and(eq(contents.id, posts.contentId), eq(contents.companyId, scope.companyId)),
      )
      .where(
        and(
          postedInScope(scope),
          gte(posts.postedAt, since),
          isNotNull(posts.metricsSyncedAt),
        ),
      )
      .orderBy(desc(posts.postedAt))
      .limit(limit);
    return rows.flatMap((r) =>
      r.postedAt === null ? [] : [{ ...r, postedAt: r.postedAt }],
    );
  },
};
