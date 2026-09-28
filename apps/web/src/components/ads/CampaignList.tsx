"use client";

import { Badge, EmptyState, ErrorState, Skeleton } from "@fastgram/ui";
import type { AdCampaignSummary } from "@fastgram/contracts";
import Link from "next/link";
import { PlusIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { useAdCampaigns } from "./api";
import { formatMinor } from "./money";
import { campaignStatusKey, campaignStatusTone, spendRatio } from "./present";

export const adCampaignHref = (id: string): string => `/ads/${encodeURIComponent(id)}`;

function SpendBar({
  label,
  spent,
  cap,
  currency,
}: {
  readonly label: string;
  readonly spent: number;
  readonly cap: number;
  readonly currency: string;
}) {
  const ratio = spendRatio(spent, cap);
  return (
    <div className="flex min-w-40 flex-1 flex-col gap-1">
      <div className="flex justify-between text-xs text-text-muted">
        <span>{label}</span>
        <span>
          {formatMinor(spent, currency)} / {formatMinor(cap, currency)}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(spent, cap)}
      >
        <div
          className={
            ratio >= 1
              ? "h-full bg-danger"
              : ratio >= 0.8
                ? "h-full bg-warning"
                : "h-full bg-accent"
          }
          style={{ width: `${String(Math.round(ratio * 100))}%` }}
        />
      </div>
    </div>
  );
}

export function NewCampaignButton() {
  return (
    <Link href="/ads/new" className="fg-btn fg-btn--primary fg-btn--md">
      <PlusIcon size={16} />
      {tw("ads.new")}
    </Link>
  );
}

function Row({ c }: { readonly c: AdCampaignSummary }) {
  return (
    <Link
      href={adCampaignHref(c.id)}
      className="flex flex-col gap-3 rounded-xl border border-border p-4 hover:bg-surface-sunken"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{c.name}</span>
        <Badge tone={campaignStatusTone(c)}>{tw(campaignStatusKey(c))}</Badge>
        {c.isTest && <Badge tone="outline">{tw("ads.testReel")}</Badge>}
        {c.hasExperiment && <Badge tone="accent">{tw("ads.ab.badge")}</Badge>}
        {c.lastSyncError !== null && <Badge tone="warning">{tw("ads.syncIssue")}</Badge>}
      </div>
      <div className="flex flex-wrap gap-4">
        <SpendBar
          label={tw("ads.spend.today")}
          spent={c.spentTodayMinor}
          cap={c.dailyCapMinor}
          currency={c.currency}
        />
        <SpendBar
          label={tw("ads.spend.total")}
          spent={c.spentTotalMinor}
          cap={c.totalCapMinor}
          currency={c.currency}
        />
      </div>
    </Link>
  );
}

/** Las campañas de la marca con estado y gasto contra tope. */
export function CampaignList() {
  const list = useAdCampaigns();
  if (list.isPending)
    return (
      <div
        className="flex flex-col gap-3"
        aria-busy="true"
        aria-label={tw("common.loading")}
      >
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  if (list.isError)
    return (
      <ErrorState title={tw("ads.list.error")} onRetry={() => void list.refetch()} />
    );
  if (list.data.length === 0)
    return (
      <EmptyState
        title={tw("ads.empty.title")}
        description={tw("ads.empty.description")}
        action={<NewCampaignButton />}
      />
    );
  return (
    <ul className="flex flex-col gap-3" aria-label={tw("ads.list.label")}>
      {list.data.map((c) => (
        <li key={c.id}>
          <Row c={c} />
        </li>
      ))}
    </ul>
  );
}
