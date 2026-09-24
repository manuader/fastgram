/**
 * Formato de `/analytics` — puro, sin React, para poder probarlo solo.
 *
 * La regla de la pantalla es la de `NFR-016`: un número que no se sabe **no se
 * muestra como 0**. `null` es «—», y la pantalla dice por qué.
 */
import type { AnalyticsBreakdownRow, AnalyticsTotals } from "@fastgram/contracts";

export const ANALYTICS_FORMATS = [
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
] as const;
export type AnalyticsFormat = (typeof ANALYTICS_FORMATS)[number];

/** Color por formato (leyenda de `F-172`): tokens de estado del tema, claro y oscuro. */
export const FORMAT_COLOR: Readonly<Record<string, string>> = {
  slideshow: "var(--fg-color-accent)",
  "wall-of-text": "var(--fg-color-info)",
  "green-screen": "var(--fg-color-success)",
  "video-hook": "var(--fg-color-warning)",
  custom: "var(--fg-color-text-subtle)",
};

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** `1234` → `1.2K`. `null` → `—`. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value < 10_000 ? value.toLocaleString("en-US") : compact.format(value);
}

/** `0.0345` → `3.45%`; `null` → `—`. */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const pct = value * 100;
  return `${pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)}%`;
}

/**
 * Una métrica de un total: `null` si **ningún** post medido la trajo (una red
 * que no reporta shares no aporta «0 shares»), o si no hay nada medido.
 */
export function metricOf(
  totals: AnalyticsTotals,
  metric: "views" | "likes" | "comments" | "shares",
): number | null {
  return totals.metricCoverage[metric] === 0 ? null : totals[metric];
}

/** Proporción de cada formato sobre los posts del rango, para la barra apilada. */
export function formatShares(
  rows: readonly AnalyticsBreakdownRow[],
): { key: string; posts: number; share: number }[] {
  const total = rows.reduce((acc, r) => acc + r.posts, 0);
  if (total === 0) return [];
  return rows.map((r) => ({ key: r.key, posts: r.posts, share: r.posts / total }));
}

/** `true` si en el rango no hay ni un post publicado: el empty state honesto. */
export function isEmptySummary(totals: AnalyticsTotals): boolean {
  return totals.posts === 0;
}

/** «hace 5 min», «hace 3 h», «hace 2 d» — para «Last synced …». */
export function formatAgo(atMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - atMs);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${String(min)} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${String(h)} h ago`;
  return `${String(Math.round(h / 24))} d ago`;
}

/** Diferencia de un ajuste del mix, en puntos con signo: `+10`, `-5`, `0`. */
export function signedDelta(from: number, to: number): string {
  const d = to - from;
  return d > 0 ? `+${String(d)}` : String(d);
}
