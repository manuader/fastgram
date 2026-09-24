/**
 * El resumen de `/analytics` — `P3-ANALYT-001` (`FR-120`, rango de días),
 * `P3-ANALYT-002` (`F-171` por red, `F-172` por tipo de contenido), `NFR-016`.
 *
 * Pura: recibe los posts publicados del rango (los lee la API, marca por
 * marca con su scope) y devuelve los totales. La regla que atraviesa todo el
 * archivo es la de `NFR-016` y el criterio 2 de `FR-120` — *«un post recién
 * publicado no se muestra como "0 views" sin indicar que está pre-sync»*:
 *
 * - Un post **sin sincronizar** (`syncedAtMs === null`) cuenta en `posts` y en
 *   `pendingSync`, y **no suma** a views/likes/…: sus ceros de la columna no
 *   son datos.
 * - Una métrica que la red no da (`null`) no suma, y `metricCoverage` dice
 *   cuántos posts sí la tenían, para que la pantalla no presente «0 shares»
 *   de una red que no reporta shares.
 * - El engagement rate agregado es Σ interacciones / Σ views **sólo sobre los
 *   posts con views conocidas y > 0**; sin ninguno, `null`.
 */
import { engagementRate, interactionsOf } from "../metrics/engagement.js";

export interface AnalyticsPostInput {
  readonly postId: string;
  readonly brandId: string;
  readonly network: string;
  readonly format: string;
  readonly postedAtMs: number;
  /** `null` = pre-sync. */
  readonly syncedAtMs: number | null;
  /** `null` = la red no la dio. Sin sync, se ignoran. */
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
  readonly postUrl: string | null;
  readonly caption: string | null;
}

export interface MetricTotals {
  readonly posts: number;
  readonly syncedPosts: number;
  readonly pendingSync: number;
  readonly views: number;
  readonly likes: number;
  readonly comments: number;
  readonly shares: number;
  /** Cuántos posts sincronizados traían cada métrica. */
  readonly metricCoverage: {
    readonly views: number;
    readonly likes: number;
    readonly comments: number;
    readonly shares: number;
  };
  readonly engagementRate: number | null;
}

export interface BreakdownRow extends MetricTotals {
  readonly key: string;
}

export interface TopPost {
  readonly postId: string;
  readonly brandId: string;
  readonly network: string;
  readonly format: string;
  readonly postedAtMs: number;
  readonly views: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
  readonly engagementRate: number | null;
  readonly postUrl: string | null;
  readonly caption: string | null;
}

export interface AnalyticsSummary {
  readonly totals: MetricTotals;
  readonly byNetwork: readonly BreakdownRow[];
  readonly byFormat: readonly BreakdownRow[];
  readonly topPosts: readonly TopPost[];
  /** El sync más reciente del rango (`NFR-016`: «reflejan la última sincronización»). */
  readonly lastSyncedAtMs: number | null;
}

export const ANALYTICS_TOP_POSTS = 5;

function totalsOf(posts: readonly AnalyticsPostInput[]): MetricTotals {
  let views = 0;
  let likes = 0;
  let comments = 0;
  let shares = 0;
  const coverage = { views: 0, likes: 0, comments: 0, shares: 0 };
  let rateViews = 0;
  let rateInteractions = 0;
  let synced = 0;
  for (const p of posts) {
    if (p.syncedAtMs === null) continue;
    synced += 1;
    if (p.views !== null) {
      views += p.views;
      coverage.views += 1;
    }
    if (p.likes !== null) {
      likes += p.likes;
      coverage.likes += 1;
    }
    if (p.comments !== null) {
      comments += p.comments;
      coverage.comments += 1;
    }
    if (p.shares !== null) {
      shares += p.shares;
      coverage.shares += 1;
    }
    if (p.views !== null && p.views > 0) {
      rateViews += p.views;
      rateInteractions += interactionsOf(p);
    }
  }
  return {
    posts: posts.length,
    syncedPosts: synced,
    pendingSync: posts.length - synced,
    views,
    likes,
    comments,
    shares,
    metricCoverage: coverage,
    engagementRate: rateViews > 0 ? rateInteractions / rateViews : null,
  };
}

function breakdown(
  posts: readonly AnalyticsPostInput[],
  keyOf: (p: AnalyticsPostInput) => string,
  order: readonly string[],
): BreakdownRow[] {
  const groups = new Map<string, AnalyticsPostInput[]>();
  for (const p of posts) {
    const key = keyOf(p);
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  const rank = (k: string): number => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, list]) => ({ key, ...totalsOf(list) }));
}

export function summarizeAnalytics(
  posts: readonly AnalyticsPostInput[],
  options: {
    readonly networkOrder?: readonly string[];
    readonly formatOrder?: readonly string[];
    readonly topPosts?: number;
  } = {},
): AnalyticsSummary {
  const synced = posts.filter((p) => p.syncedAtMs !== null);
  const topPosts = [...synced]
    .sort(
      (a, b) =>
        (b.views ?? -1) - (a.views ?? -1) ||
        interactionsOf(b) - interactionsOf(a) ||
        b.postedAtMs - a.postedAtMs,
    )
    .slice(0, options.topPosts ?? ANALYTICS_TOP_POSTS)
    .map((p) => ({
      postId: p.postId,
      brandId: p.brandId,
      network: p.network,
      format: p.format,
      postedAtMs: p.postedAtMs,
      views: p.views,
      likes: p.likes,
      comments: p.comments,
      shares: p.shares,
      engagementRate: engagementRate(p),
      postUrl: p.postUrl,
      caption: p.caption,
    }));
  const lastSyncedAtMs = synced.reduce<number | null>(
    (acc, p) =>
      p.syncedAtMs !== null && (acc === null || p.syncedAtMs > acc) ? p.syncedAtMs : acc,
    null,
  );
  return {
    totals: totalsOf(posts),
    byNetwork: breakdown(posts, (p) => p.network, options.networkOrder ?? []),
    byFormat: breakdown(posts, (p) => p.format, options.formatOrder ?? []),
    topPosts,
    lastSyncedAtMs,
  };
}
