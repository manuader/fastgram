"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  ErrorState,
  Input,
  Skeleton,
  Spinner,
} from "@fastgram/ui";
import type { AdCampaignDetail, AdMetrics } from "@fastgram/contracts";
import Link from "next/link";
import { useState } from "react";
import { tw } from "@/lib/i18n/t";
import {
  reasonOf,
  useActivateCampaign,
  useAdCampaign,
  usePauseCampaign,
  useUpdateAdBudget,
} from "./api";
import { ConfirmSpendDialog } from "./ConfirmSpendDialog";
import {
  formatCount,
  formatMinor,
  formatPercent,
  minorToMajorInput,
  parseMajorToMinor,
} from "./money";
import { campaignStatusKey, campaignStatusTone, reasonKey } from "./present";

export function MetricGrid({
  metrics,
  currency,
}: {
  readonly metrics: AdMetrics;
  readonly currency: string | null;
}) {
  const cells: [string, string][] = [
    [tw("ads.metric.spend"), formatMinor(metrics.spendMinor, currency)],
    [tw("ads.metric.impressions"), formatCount(metrics.impressions)],
    [tw("ads.metric.clicks"), formatCount(metrics.clicks)],
    [tw("ads.metric.ctr"), formatPercent(metrics.ctr)],
    [tw("ads.metric.cpc"), formatMinor(metrics.cpcMinor, currency)],
    [tw("ads.metric.cpm"), formatMinor(metrics.cpmMinor, currency)],
    [tw("ads.metric.results"), formatCount(metrics.results)],
    [tw("ads.metric.cpa"), formatMinor(metrics.cpaMinor, currency)],
    [tw("ads.metric.roas"), metrics.roas === null ? "—" : `${metrics.roas.toFixed(2)}×`],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {cells.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-border p-3">
          <dt className="text-xs text-text-muted">{label}</dt>
          <dd className="text-lg font-semibold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Experiment({ detail }: { readonly detail: AdCampaignDetail }) {
  const e = detail.experiment;
  if (e === null) return null;
  const verdictKey =
    e.status === "winner"
      ? "ads.ab.winner"
      : e.status === "no_winner_yet"
        ? "ads.ab.noWinner"
        : "ads.ab.insufficient";
  const winner = e.variants.find((v) => v.adSetId === e.winnerAdSetId);
  return (
    <section className="flex flex-col gap-2" aria-label={tw("ads.ab.title")}>
      <h2 className="text-base font-semibold">{tw("ads.ab.title")}</h2>
      <p className="text-sm" data-testid="ab-verdict">
        {tw(verdictKey, { label: winner?.label ?? "" })}
      </p>
      <p className="text-xs text-text-muted">
        {tw("ads.ab.rule", {
          metric: e.metric.toUpperCase(),
          impressions: String(e.minImpressions),
          events: String(e.minEvents),
        })}
        {e.platformStudy ? "" : ` ${tw("ads.ab.noStudy")}`}
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-text-muted">
            <th className="py-1">{tw("ads.ab.variant")}</th>
            <th>{tw("ads.metric.impressions")}</th>
            <th>{tw("ads.metric.clicks")}</th>
            <th>{tw("ads.metric.results")}</th>
            <th>{e.metric.toUpperCase()}</th>
            <th>{tw("ads.metric.spend")}</th>
          </tr>
        </thead>
        <tbody>
          {e.variants.map((v) => (
            <tr key={v.adSetId} className="border-t border-border">
              <td className="py-1">
                {v.label}
                {v.adSetId === e.winnerAdSetId && (
                  <Badge tone="success" className="ml-2">
                    {tw("ads.ab.winnerBadge")}
                  </Badge>
                )}
              </td>
              <td>{formatCount(v.impressions)}</td>
              <td>{formatCount(v.clicks)}</td>
              <td>{formatCount(v.results)}</td>
              <td>{formatPercent(v.rate)}</td>
              <td>{formatMinor(v.spendMinor, detail.campaign.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function BudgetEditor({ detail }: { readonly detail: AdCampaignDetail }) {
  const c = detail.campaign;
  const update = useUpdateAdBudget(c.id);
  const [daily, setDaily] = useState(minorToMajorInput(c.dailyCapMinor, c.currency));
  const [total, setTotal] = useState(minorToMajorInput(c.totalCapMinor, c.currency));
  const [confirming, setConfirming] = useState(false);
  const dailyMinor = parseMajorToMinor(daily, c.currency);
  const totalMinor = parseMajorToMinor(total, c.currency);
  const valid = dailyMinor !== null && totalMinor !== null && dailyMinor <= totalMinor;
  const raises = valid && (dailyMinor > c.dailyCapMinor || totalMinor > c.totalCapMinor);
  const needsConfirmation = c.status === "ACTIVE" && raises;

  function save() {
    if (!valid) return;
    if (needsConfirmation) setConfirming(true);
    else update.mutate({ dailyCapMinor: dailyMinor, totalCapMinor: totalMinor });
  }

  const key =
    update.error === null
      ? null
      : (reasonKey(reasonOf(update.error)) ?? "ads.error.generic");
  return (
    <section className="flex flex-col gap-2" aria-label={tw("ads.budget.title")}>
      <h2 className="text-base font-semibold">{tw("ads.budget.title")}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {tw("ads.budget.daily", { currency: c.currency })}
          <Input
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {tw("ads.budget.total", { currency: c.currency })}
          <Input
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <Button variant="secondary" onClick={save} disabled={!valid || update.isPending}>
          {tw("ads.budget.save")}
        </Button>
      </div>
      {!valid && (
        <p className="text-sm text-danger">{tw("ads.reason.dailyExceedsTotal")}</p>
      )}
      {needsConfirmation && (
        <p className="text-xs text-text-muted">{tw("ads.budget.needsConfirmation")}</p>
      )}
      {key !== null && (
        <p role="alert" className="text-sm text-danger">
          {tw(key)}
        </p>
      )}
      {valid && (
        <ConfirmSpendDialog
          campaignId={c.id}
          open={confirming}
          onClose={() => setConfirming(false)}
          action="budget_increase"
          caps={{ dailyCapMinor: dailyMinor, totalCapMinor: totalMinor }}
          onConfirm={(token) =>
            update.mutateAsync({
              dailyCapMinor: dailyMinor,
              totalCapMinor: totalMinor,
              confirmationToken: token,
            })
          }
        />
      )}
    </section>
  );
}

/** `/ads/<id>`: estado, activar/pausar con confirmación, topes, métricas, A/B, auditoría. */
export function CampaignDetail({ campaignId }: { readonly campaignId: string }) {
  const query = useAdCampaign(campaignId);
  const activate = useActivateCampaign(campaignId);
  const pause = usePauseCampaign(campaignId);
  const [confirming, setConfirming] = useState(false);

  if (query.isPending)
    return (
      <div
        className="flex flex-col gap-3"
        aria-busy="true"
        aria-label={tw("common.loading")}
      >
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  if (query.isError)
    return (
      <ErrorState
        title={tw(
          query.error.status === 404 ? "ads.detail.notFound" : "ads.detail.error",
        )}
        onRetry={() => void query.refetch()}
      />
    );
  const d = query.data;
  const c = d.campaign;
  const pauseKey =
    pause.error === null
      ? null
      : (reasonKey(reasonOf(pause.error)) ?? "ads.error.generic");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/ads" className="text-sm text-text-muted">
          ← {tw("ads.title")}
        </Link>
        <h1 className="text-xl font-semibold">{c.name}</h1>
        <Badge tone={campaignStatusTone(c)}>{tw(campaignStatusKey(c))}</Badge>
        <div className="ml-auto flex gap-2">
          {c.status === "PAUSED" && (
            <Button onClick={() => setConfirming(true)}>{tw("ads.activate")}</Button>
          )}
          {c.status === "ACTIVE" && (
            <Button
              variant="secondary"
              onClick={() => pause.mutate()}
              disabled={pause.isPending}
            >
              {pause.isPending ? <Spinner size="sm" aria-hidden="true" /> : null}
              {tw("ads.pause")}
            </Button>
          )}
        </div>
      </div>
      {pauseKey !== null && (
        <p role="alert" className="text-sm text-danger">
          {tw(pauseKey)}
        </p>
      )}
      {(c.pausedReason === "daily_cap" || c.pausedReason === "total_cap") && (
        <Card>
          <CardContent className="p-3 text-sm">{tw("ads.detail.capPaused")}</CardContent>
        </Card>
      )}
      <p className="text-sm text-text-muted">
        {tw("ads.detail.caps", {
          today: formatMinor(c.spentTodayMinor, c.currency),
          daily: formatMinor(c.dailyCapMinor, c.currency),
          total: formatMinor(c.spentTotalMinor, c.currency),
          cap: formatMinor(c.totalCapMinor, c.currency),
        })}{" "}
        {tw("ads.detail.guard", { minutes: String(d.guardIntervalMinutes) })}
      </p>

      <MetricGrid metrics={d.metrics} currency={c.currency} />
      <Experiment detail={d} />
      <BudgetEditor detail={d} />

      <section className="flex flex-col gap-2" aria-label={tw("ads.detail.ads")}>
        <h2 className="text-base font-semibold">{tw("ads.detail.ads")}</h2>
        <ul className="flex flex-col gap-2">
          {d.ads.map((ad) => (
            <li
              key={ad.id}
              className="flex items-center gap-3 rounded-lg border border-border p-2"
            >
              {ad.thumbnailUrl !== null && (
                // Miniatura de nuestra propia pieza.
                <img
                  src={ad.thumbnailUrl}
                  alt=""
                  className="h-12 w-9 rounded object-cover"
                />
              )}
              <span className="flex-1 text-sm">{ad.name}</span>
              <span className="text-sm text-text-muted">
                {formatMinor(ad.metrics.spendMinor, c.currency)} ·{" "}
                {formatPercent(ad.metrics.ctr)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2" aria-label={tw("ads.detail.history")}>
        <h2 className="text-base font-semibold">{tw("ads.detail.history")}</h2>
        {d.actions.length === 0 ? (
          <p className="text-sm text-text-muted">{tw("ads.detail.noHistory")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {d.actions.map((a, i) => (
              <li key={`${String(a.createdAt)}-${String(i)}`} className="text-text-muted">
                {new Date(a.createdAt).toLocaleString()} · {a.kind}
                {a.reason === null ? "" : ` (${a.reason})`}
                {a.maxSpendMinor === null
                  ? ""
                  : ` · ${tw("ads.detail.maxShown", { max: formatMinor(a.maxSpendMinor, c.currency) })}`}
                {a.actor === "guard" ? ` · ${tw("ads.detail.byGuard")}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmSpendDialog
        campaignId={c.id}
        open={confirming}
        onClose={() => setConfirming(false)}
        action="activate"
        onConfirm={(token) => activate.mutateAsync(token)}
      />
    </div>
  );
}
