"use client";

import { Button, Skeleton, useToast } from "@fastgram/ui";
import { useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw } from "@/lib/i18n/t";
import {
  useDiscoverNow,
  useEngagementOverview,
  useRefreshBanMeter,
} from "@/lib/engagement/api";
import { reasonKey, reasonOf } from "@/lib/engagement/present";
import { BanMeterCard } from "./BanMeterCard";
import { LeadDetail } from "./LeadDetail";
import { LeadList } from "./LeadList";
import { SetupPanel } from "./SetupPanel";

/** Lo que trae la query al volver del OAuth (`lib/engagement/callback.ts`). */
export interface RedditNotice {
  readonly reddit?: string | undefined;
  readonly username?: string | undefined;
  readonly reason?: string | undefined;
}

/**
 * Engagement → Actions — `FR-140`, `F-190…F-201`. La cola de leads a la
 * izquierda y el lead elegido a la derecha; la configuración arriba, abierta
 * mientras no haya nada configurado.
 */
export function EngagementScreen({ notice }: { readonly notice?: RedditNotice }) {
  const overview = useEngagementOverview();
  const discover = useDiscoverNow();
  const refresh = useRefreshBanMeter();
  const { toast } = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState<boolean | null>(null);

  if (overview.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton height={96} />
        <Skeleton height={320} />
      </div>
    );
  }
  if (overview.isError) {
    return (
      <ApiErrorState error={overview.error} onRetry={() => void overview.refetch()} />
    );
  }
  const o = overview.data;
  const showSetup = setupOpen ?? !o.configured;
  const discovery = o.discovery;

  return (
    <div className="flex flex-col gap-6" data-testid="engagement-screen">
      {notice?.reddit === "connected" && notice.username !== undefined ? (
        <p className="m-0 rounded-md bg-surface p-3 text-sm text-success" role="status">
          {tw("engagement.connected", { username: notice.username })}
        </p>
      ) : null}
      {notice?.reddit === "error" ? (
        <p className="m-0 rounded-md bg-surface p-3 text-sm text-danger" role="alert">
          {tw(reasonKey(notice.reason ?? null))}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,22rem)]">
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-sm">
          <span className="font-medium text-text">
            {o.account === null
              ? tw("engagement.noConnection")
              : tw("engagement.connectedAs", { username: o.account.username })}
          </span>
          <span className="text-text-muted" data-testid="discovery-status">
            {discovery.pausedUntil !== null &&
            new Date(discovery.pausedUntil) > new Date()
              ? tw("engagement.discovery.rateLimited", {
                  when: new Date(discovery.pausedUntil).toLocaleTimeString(),
                })
              : discovery.available
                ? discovery.lastRunAt === null
                  ? tw("engagement.discovery.queued")
                  : tw("engagement.discovery.lastRun", {
                      when: new Date(discovery.lastRunAt).toLocaleString(),
                    })
                : tw("engagement.discovery.needsSetup")}
          </span>
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSetupOpen(!showSetup)}
              aria-expanded={showSetup}
            >
              {tw("engagement.settings.subredditsTitle")}
            </Button>
          </div>
        </div>
        <BanMeterCard
          meter={o.banMeter}
          refreshing={refresh.isPending}
          onRefresh={() => refresh.mutate()}
        />
      </div>

      {showSetup ? <SetupPanel overview={o} /> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_1fr]">
        <LeadList
          selectedId={selected}
          onSelect={setSelected}
          canDiscover={discovery.available}
          discovering={discover.isPending}
          onDiscover={() =>
            discover.mutate(undefined, {
              onSuccess: () =>
                toast({ title: tw("engagement.discovery.queued"), tone: "info" }),
              onError: (e) =>
                toast({ title: tw(reasonKey(reasonOf(e))), tone: "danger" }),
            })
          }
        />
        <div>
          {selected === null ? (
            <p className="m-0 rounded-lg border border-dashed border-border p-6 text-sm text-text-muted">
              {tw("engagement.selectLead")}
            </p>
          ) : (
            <LeadDetail
              key={selected}
              leadId={selected}
              username={o.account?.status === "active" ? o.account.username : null}
              onClose={() => setSelected(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
