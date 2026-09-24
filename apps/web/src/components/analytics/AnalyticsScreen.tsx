"use client";

import {
  ANALYTICS_DEFAULT_DAYS,
  ANALYTICS_RANGE_DAYS,
  type AnalyticsBreakdownRow,
  type AnalyticsSummary,
  type AnalyticsTopPost,
} from "@fastgram/contracts";
import {
  Button,
  buttonVariants,
  EmptyState,
  ErrorState,
  Skeleton,
  useToast,
} from "@fastgram/ui";
import Link from "next/link";
import { useState } from "react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { BarChartIcon, ExternalLinkIcon, InfoIcon } from "@/icons";
import { copyKeyForError } from "@/lib/api/errors";
import {
  useAnalyticsSummary,
  useRequestSync,
  type AnalyticsScope,
} from "@/lib/analytics/data";
import {
  FORMAT_COLOR,
  formatAgo,
  formatCount,
  formatRate,
  formatShares,
  isEmptySummary,
  metricOf,
} from "@/lib/analytics/format";
import { NETWORK_CHIP_COLOR, NETWORK_LABEL } from "@/lib/calendar/board";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { MixPanel } from "./MixPanel";

const CONNECTIONS_HREF = `${ROUTES.settings}/connections`;

const networkLabel = (n: string): string =>
  (NETWORK_LABEL as Readonly<Record<string, string>>)[n] ?? n;
const networkColor = (n: string): string =>
  (NETWORK_CHIP_COLOR as Readonly<Record<string, string>>)[n] ??
  "var(--fg-color-text-subtle)";
const formatLabel = (f: string): string => tw(`analytics.format.${f}` as CopyKey);

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-lg border border-border bg-surface p-0.5"
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              onChange(o.value);
            }}
            className={
              "rounded-md px-3 py-1 text-sm transition-colors " +
              (selected
                ? "bg-surface-sunken font-medium text-text"
                : "text-text-muted hover:text-text")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Una tarjeta de total. `—` cuando no se sabe (`NFR-016`), nunca 0. */
function Tile({
  id,
  label,
  value,
  hint,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string | undefined;
  readonly hint?: string | undefined;
}) {
  return (
    <li
      data-testid={`analytics-total-${id}`}
      aria-busy={value === undefined}
      className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4"
    >
      <span className="text-xs text-text-muted">{label}</span>
      {value === undefined ? (
        <Skeleton width={64} height={24} />
      ) : (
        <span className="text-2xl font-semibold tabular-nums tracking-tight text-text">
          {value}
        </span>
      )}
      {hint !== undefined && <span className="text-[11px] text-text-subtle">{hint}</span>}
    </li>
  );
}

function Totals({ summary }: { readonly summary: AnalyticsSummary | undefined }) {
  const t = summary?.totals;
  const metric = (m: "views" | "likes" | "comments" | "shares") =>
    t === undefined ? undefined : formatCount(metricOf(t, m));
  const notReported = (m: "views" | "likes" | "comments" | "shares") =>
    t !== undefined && t.syncedPosts > 0 && t.metricCoverage[m] === 0
      ? tw("analytics.totals.notReported")
      : undefined;
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 xl:grid-cols-6">
      <Tile
        id="posts"
        label={tw("analytics.totals.posts")}
        value={t === undefined ? undefined : formatCount(t.posts)}
      />
      <Tile
        id="views"
        label={tw("analytics.totals.views")}
        value={metric("views")}
        hint={notReported("views")}
      />
      <Tile
        id="likes"
        label={tw("analytics.totals.likes")}
        value={metric("likes")}
        hint={notReported("likes")}
      />
      <Tile
        id="comments"
        label={tw("analytics.totals.comments")}
        value={metric("comments")}
        hint={notReported("comments")}
      />
      <Tile
        id="shares"
        label={tw("analytics.totals.shares")}
        value={metric("shares")}
        hint={notReported("shares")}
      />
      <Tile
        id="engagement"
        label={tw("analytics.totals.engagement")}
        value={t === undefined ? undefined : formatRate(t.engagementRate)}
        hint={tw("analytics.totals.engagementHint")}
      />
    </ul>
  );
}

function NetworkCards({
  rows,
  unsupported,
}: {
  readonly rows: readonly AnalyticsBreakdownRow[];
  readonly unsupported: readonly string[];
}) {
  return (
    <section aria-labelledby="analytics-network-title" className="flex flex-col gap-3">
      <h2 id="analytics-network-title" className="m-0 text-lg font-semibold text-text">
        {tw("analytics.byNetwork.title")}
      </h2>
      <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => {
          const noMetrics = unsupported.includes(r.key);
          return (
            <li
              key={r.key}
              data-testid={`analytics-network-${r.key}`}
              className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4"
              style={{ borderTop: `3px solid ${networkColor(r.key)}` }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-text">
                  {tw("analytics.byNetwork.posts", { network: networkLabel(r.key) })}
                </span>
                <span className="text-xl font-semibold tabular-nums text-text">
                  {r.posts}
                </span>
              </div>
              {noMetrics ? (
                <span className="text-xs text-text-muted">
                  {tw("analytics.byNetwork.noMetrics")}
                </span>
              ) : (
                <dl className="m-0 grid grid-cols-4 gap-2 text-xs">
                  {(
                    [
                      ["views", "analytics.totals.views"],
                      ["likes", "analytics.totals.likes"],
                      ["comments", "analytics.totals.comments"],
                    ] as const
                  ).map(([m, key]) => (
                    <div key={m} className="flex flex-col">
                      <dt className="text-text-muted">{tw(key)}</dt>
                      <dd className="m-0 tabular-nums text-text">
                        {formatCount(metricOf(r, m))}
                      </dd>
                    </div>
                  ))}
                  <div className="flex flex-col">
                    <dt className="text-text-muted">ER</dt>
                    <dd className="m-0 tabular-nums text-text">
                      {formatRate(r.engagementRate)}
                    </dd>
                  </div>
                </dl>
              )}
              {r.pendingSync > 0 && !noMetrics && (
                <span className="text-[11px] text-text-subtle">
                  {tw("analytics.pendingSync", { count: r.pendingSync })}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FormatBreakdown({ rows }: { readonly rows: readonly AnalyticsBreakdownRow[] }) {
  const shares = formatShares(rows);
  return (
    <section aria-labelledby="analytics-format-title" className="flex flex-col gap-3">
      <h2 id="analytics-format-title" className="m-0 text-lg font-semibold text-text">
        {tw("analytics.byFormat.title")}
      </h2>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
        <div
          className="flex h-2.5 overflow-hidden rounded-full bg-surface-sunken"
          aria-hidden
        >
          {shares.map((s) => (
            <div
              key={s.key}
              style={{
                width: `${String(s.share * 100)}%`,
                background: FORMAT_COLOR[s.key] ?? "var(--fg-color-text-subtle)",
              }}
            />
          ))}
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted">
              <th className="py-1 font-normal">{tw("analytics.byFormat.title")}</th>
              <th className="py-1 text-right font-normal">
                {tw("analytics.totals.posts")}
              </th>
              <th className="py-1 text-right font-normal">
                {tw("analytics.totals.views")}
              </th>
              <th className="py-1 text-right font-normal">
                {tw("analytics.totals.engagement")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className="border-t border-border"
                data-testid={`analytics-format-${r.key}`}
              >
                <td className="py-1.5">
                  <span className="inline-flex items-center gap-2 text-text">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 rounded-full"
                      style={{
                        background: FORMAT_COLOR[r.key] ?? "var(--fg-color-text-subtle)",
                      }}
                    />
                    {formatLabel(r.key)}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{r.posts}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatCount(metricOf(r, "views"))}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatRate(r.engagementRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TopPosts({
  posts,
  brandName,
}: {
  readonly posts: readonly AnalyticsTopPost[];
  readonly brandName: (id: string) => string | null;
}) {
  return (
    <section aria-labelledby="analytics-top-title" className="flex flex-col gap-3">
      <h2 id="analytics-top-title" className="m-0 text-lg font-semibold text-text">
        {tw("analytics.top.title")}
      </h2>
      {posts.length === 0 ? (
        <p className="m-0 text-sm text-text-muted">{tw("analytics.top.empty")}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col divide-y divide-border rounded-xl border border-border bg-surface p-0">
          {posts.map((p, i) => {
            const brand = brandName(p.brandId);
            return (
              <li
                key={p._id}
                className="flex items-center gap-3 p-3"
                data-testid="analytics-top-post"
              >
                <span className="w-5 text-right text-sm tabular-nums text-text-subtle">
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-text">
                    {p.caption ?? tw("analytics.top.noCaption")}
                  </span>
                  <span className="text-xs text-text-muted">
                    {networkLabel(p.network)} · {formatLabel(p.format)} ·{" "}
                    {DATE.format(p.postedAt)}
                    {brand !== null && ` · ${brand}`}
                  </span>
                </div>
                <dl className="m-0 hidden gap-4 text-right text-xs sm:flex">
                  <div>
                    <dt className="text-text-muted">{tw("analytics.totals.views")}</dt>
                    <dd className="m-0 tabular-nums text-text">{formatCount(p.views)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">ER</dt>
                    <dd className="m-0 tabular-nums text-text">
                      {formatRate(p.engagementRate)}
                    </dd>
                  </div>
                </dl>
                {p.postUrl !== undefined && (
                  <a
                    href={p.postUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={tw("analytics.top.open")}
                    className="text-text-muted hover:text-text"
                  >
                    <ExternalLinkIcon size={14} />
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** Avisos del sync: pendientes, problemas por motivo, redes sin métricas. */
function SyncNotes({ summary }: { readonly summary: AnalyticsSummary }) {
  const notes: { key: string; text: string; tone: "muted" | "warning" }[] = [];
  if (summary.totals.pendingSync > 0) {
    notes.push({
      key: "pending",
      text: tw("analytics.pendingSync", { count: summary.totals.pendingSync }),
      tone: "muted",
    });
  }
  for (const issue of summary.syncIssues) {
    notes.push({
      key: issue.code,
      text: tw(`analytics.issue.${issue.code}` as CopyKey, { count: issue.count }),
      tone: "warning",
    });
  }
  if (summary.unsupportedNetworks.length > 0) {
    notes.push({
      key: "unsupported",
      text: tw("analytics.unsupported", {
        networks: summary.unsupportedNetworks.map(networkLabel).join(", "),
      }),
      tone: "muted",
    });
  }
  if (summary.truncated) {
    notes.push({ key: "truncated", text: tw("analytics.truncated"), tone: "warning" });
  }
  if (notes.length === 0) return null;
  const needsReconnect = summary.syncIssues.some(
    (i) =>
      i.code === "metrics_permission_missing" || i.code === "metrics_reconnect_required",
  );
  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface-sunken p-3"
      data-testid="analytics-sync-notes"
    >
      {notes.map((n) => (
        <p
          key={n.key}
          className={
            "m-0 flex items-start gap-2 text-xs " +
            (n.tone === "warning" ? "text-warning" : "text-text-muted")
          }
        >
          <InfoIcon size={14} className="mt-px flex-none" />
          <span>{n.text}</span>
        </p>
      ))}
      {needsReconnect && (
        <Link href={CONNECTIONS_HREF} className="text-xs font-medium text-accent">
          {tw("analytics.issue.action")}
        </Link>
      )}
    </div>
  );
}

function LoadingBody() {
  return (
    <div className="flex flex-col gap-6" aria-busy aria-label={tw("loading.analytics")}>
      <Totals summary={undefined} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={96} />
        ))}
      </div>
      <p className="m-0 text-xs text-text-muted">{tw("loading.analytics")}</p>
    </div>
  );
}

/**
 * `/analytics` · `P3-ANALYT-001/002` (`FR-120`, `F-171`, `F-172`), con el panel
 * del content mix de `PU-AUTO-004`.
 *
 * El rango y el alcance (esta marca / todas) viven en el estado de la
 * pantalla; cambiar cualquiera recalcula todas las tarjetas (`FR-120`,
 * criterio 1) porque son una sola consulta.
 */
export function AnalyticsScreen() {
  const { isPersonal, workspaces, active } = useWorkspace();
  const [days, setDays] = useState<number>(ANALYTICS_DEFAULT_DAYS);
  const multiBrand = isPersonal && (workspaces.data?.length ?? 1) > 1;
  const [scope, setScope] = useState<AnalyticsScope>("current");
  const effectiveScope: AnalyticsScope = multiBrand ? scope : "current";

  const summary = useAnalyticsSummary(days, effectiveScope);
  const sync = useRequestSync();
  const { toast } = useToast();

  const brandName = (id: string): string | null =>
    effectiveScope === "all"
      ? (summary.data?.brands.find((b) => b.id === id)?.name ?? null)
      : null;

  const data = summary.data;

  return (
    <div className="fgw-page">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-3xl font-semibold tracking-tight text-text">
            {tw("analytics.title")}
          </h1>
          <p className="m-0 text-sm text-text-muted">{tw("analytics.subtitle")}</p>
          <p className="m-0 text-xs text-text-subtle" data-testid="analytics-last-sync">
            {data === undefined
              ? " "
              : data.lastSyncedAt === null
                ? tw("analytics.neverSynced")
                : tw("analytics.lastSynced", {
                    ago: formatAgo(data.lastSyncedAt, Date.now()),
                  })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label={tw("analytics.range.label")}
            value={days}
            options={ANALYTICS_RANGE_DAYS.map((n) => ({
              value: n as number,
              label: tw("analytics.range.days", { n }),
            }))}
            onChange={setDays}
          />
          {multiBrand && (
            <Segmented
              label={tw("analytics.scope.label")}
              value={scope}
              options={[
                {
                  value: "current" as const,
                  label: active?.name ?? tw("analytics.scope.current"),
                },
                { value: "all" as const, label: tw("analytics.scope.all") },
              ]}
              onChange={setScope}
            />
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={sync.isPending}
            aria-busy={sync.isPending}
            onClick={() => {
              sync.mutate(undefined, {
                onSuccess: (res) => {
                  toast({
                    title: tw(
                      res.queued ? "analytics.sync.queued" : "analytics.sync.already",
                    ),
                    tone: "success",
                    duration: 3000,
                  });
                },
                onError: (error) => {
                  toast({
                    title: tw("analytics.sync.failed"),
                    description: tw(copyKeyForError(error)),
                    tone: "danger",
                  });
                },
              });
            }}
          >
            {tw("analytics.sync.now")}
          </Button>
        </div>
      </header>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="flex min-w-0 flex-col gap-6">
          {summary.isPending ? (
            <LoadingBody />
          ) : summary.isError || data === undefined ? (
            <ErrorState
              title={tw("analytics.error")}
              description={tw(copyKeyForError(summary.error))}
              onRetry={() => {
                void summary.refetch();
              }}
            />
          ) : isEmptySummary(data.totals) ? (
            <EmptyState
              icon={<BarChartIcon size={20} />}
              title={tw("analytics.empty.title")}
              description={tw("analytics.empty.body")}
              action={
                <Link
                  href={CONNECTIONS_HREF}
                  className={buttonVariants({ variant: "primary", size: "md" })}
                >
                  {tw("analytics.empty.connect")}
                </Link>
              }
            />
          ) : (
            <>
              <Totals summary={data} />
              <SyncNotes summary={data} />
              <NetworkCards
                rows={data.byNetwork}
                unsupported={data.unsupportedNetworks}
              />
              <FormatBreakdown rows={data.byFormat} />
              <TopPosts posts={data.topPosts} brandName={brandName} />
              <p className="m-0 text-[11px] text-text-subtle">{tw("analytics.xNote")}</p>
            </>
          )}
        </div>
        <aside className="flex min-w-0 flex-col gap-6">
          <MixPanel />
        </aside>
      </div>
    </div>
  );
}
