"use client";

import { Badge, EmptyState, ErrorState, Select, Skeleton } from "@fastgram/ui";
import Link from "next/link";
import { useState } from "react";
import { tw } from "@/lib/i18n/t";
import { useAdsDashboard } from "./api";
import { MetricGrid } from "./CampaignDetail";
import { adCampaignHref } from "./CampaignList";
import { formatCount, formatMinor, formatPercent } from "./money";

type Days = 7 | 30 | 90;

/**
 * Dashboard de marketing de la marca: orgánico (lo mismo que Analytics) +
 * pago, por período, y el resultado de cada A/B.
 */
export function MarketingDashboard() {
  const [days, setDays] = useState<Days>(30);
  const q = useAdsDashboard(days);

  const picker = (
    <label className="flex items-center gap-2 text-sm">
      {tw("ads.dashboard.period")}
      <Select
        value={String(days)}
        onChange={(e) => setDays(Number(e.target.value) as Days)}
        options={[7, 30, 90].map((d) => ({
          value: String(d),
          label: tw("ads.dashboard.days", { days: String(d) }),
        }))}
      />
    </label>
  );

  if (q.isPending)
    return (
      <div
        className="flex flex-col gap-3"
        aria-busy="true"
        aria-label={tw("common.loading")}
      >
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  if (q.isError)
    return (
      <ErrorState title={tw("ads.dashboard.error")} onRetry={() => void q.refetch()} />
    );

  const d = q.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {picker}
        <span className="text-xs text-text-muted">
          {d.range.from} → {d.range.to}
        </span>
        {d.demo && <Badge tone="info">{tw("ads.demo.badge")}</Badge>}
      </div>

      <section className="flex flex-col gap-2" aria-label={tw("ads.dashboard.organic")}>
        <h2 className="text-base font-semibold">{tw("ads.dashboard.organic")}</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {(
            [
              [tw("ads.dashboard.posts"), formatCount(d.organic.posts)],
              [tw("ads.dashboard.views"), formatCount(d.organic.views)],
              [tw("ads.dashboard.likes"), formatCount(d.organic.likes)],
              [tw("ads.dashboard.comments"), formatCount(d.organic.comments)],
              [tw("ads.dashboard.shares"), formatCount(d.organic.shares)],
              [tw("ads.dashboard.engagement"), formatPercent(d.organic.engagementRate)],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border p-3">
              <dt className="text-xs text-text-muted">{label}</dt>
              <dd className="text-lg font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="flex flex-col gap-2" aria-label={tw("ads.dashboard.paid")}>
        <h2 className="text-base font-semibold">{tw("ads.dashboard.paid")}</h2>
        {d.connection === "none" && d.paid.campaigns.length === 0 ? (
          <EmptyState
            bordered
            title={tw("ads.dashboard.noPaidTitle")}
            description={tw("ads.dashboard.noPaidDescription")}
          />
        ) : (
          <>
            <MetricGrid metrics={d.paid.metrics} currency={d.currency} />
            {d.paid.byDay.length > 0 && (
              <table className="w-full text-sm" aria-label={tw("ads.dashboard.byDay")}>
                <thead>
                  <tr className="text-left text-text-muted">
                    <th className="py-1">{tw("ads.dashboard.day")}</th>
                    <th>{tw("ads.metric.spend")}</th>
                    <th>{tw("ads.metric.impressions")}</th>
                    <th>{tw("ads.metric.clicks")}</th>
                    <th>{tw("ads.metric.results")}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.paid.byDay.map((p) => (
                    <tr key={p.date} className="border-t border-border">
                      <td className="py-1">{p.date}</td>
                      <td>{formatMinor(p.spendMinor, d.currency)}</td>
                      <td>{formatCount(p.impressions)}</td>
                      <td>{formatCount(p.clicks)}</td>
                      <td>{formatCount(p.results)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <ul className="flex flex-col gap-1 text-sm">
              {d.paid.campaigns.map((c) => (
                <li key={c.id}>
                  <Link href={adCampaignHref(c.id)} className="text-accent">
                    {c.name}
                  </Link>{" "}
                  · {formatMinor(c.metrics.spendMinor, d.currency)} ·{" "}
                  {formatPercent(c.metrics.ctr)} CTR
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-label={tw("ads.ab.title")}>
        <h2 className="text-base font-semibold">{tw("ads.ab.title")}</h2>
        {d.experiments.length === 0 ? (
          <p className="text-sm text-text-muted">{tw("ads.dashboard.noExperiments")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {d.experiments.map((e) => (
              <li key={e.campaignId}>
                <Link href={adCampaignHref(e.campaignId)} className="text-accent">
                  {e.campaignName}
                </Link>{" "}
                ·{" "}
                {e.status === "winner"
                  ? tw("ads.ab.winner", { label: e.winnerLabel ?? "" })
                  : e.status === "no_winner_yet"
                    ? tw("ads.ab.noWinner")
                    : tw("ads.ab.insufficient")}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
