"use client";

import {
  Button,
  ErrorState,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@fastgram/ui";
import { useSearchParams } from "next/navigation";
import { tw } from "@/lib/i18n/t";
import { reasonOf, useAdsConnection, useSyncAds } from "./api";
import { CampaignList, NewCampaignButton } from "./CampaignList";
import { ConnectAds, ConnectedAccount, PickAdAccount } from "./ConnectionPanel";
import { MarketingDashboard } from "./MarketingDashboard";
import { reasonKey } from "./present";

/**
 * `/ads`: la conexión de anuncios de la marca y, con cuenta, las campañas y el
 * dashboard de marketing. Sin cuenta publicitaria, el dashboard igual muestra
 * lo orgánico.
 */
export function AdsHome() {
  const connection = useAdsConnection();
  const sync = useSyncAds();
  const params = useSearchParams();
  const callbackError = params.get("connect") === "error" ? params.get("reason") : null;

  if (connection.isPending)
    return (
      <Skeleton className="h-40 w-full rounded-xl" aria-label={tw("common.loading")} />
    );
  if (connection.isError)
    return (
      <ErrorState
        title={tw("ads.connection.error")}
        onRetry={() => void connection.refetch()}
      />
    );
  const c = connection.data;
  const syncKey =
    sync.error === null ? null : (reasonKey(reasonOf(sync.error)) ?? "ads.error.generic");

  const campaigns =
    c.status === "active" ? (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <ConnectedAccount connection={c} />
          <div className="ml-auto flex gap-2">
            <Button
              variant="secondary"
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
            >
              {sync.isPending ? <Spinner size="sm" aria-hidden="true" /> : null}
              {tw("ads.sync")}
            </Button>
            <NewCampaignButton />
          </div>
        </div>
        {sync.data !== undefined && (
          <p className="text-sm text-text-muted" role="status">
            {tw("ads.sync.result", {
              synced: String(sync.data.synced),
              paused: String(sync.data.paused),
            })}
          </p>
        )}
        {syncKey !== null && (
          <p role="alert" className="text-sm text-danger">
            {tw(syncKey)}
          </p>
        )}
        <CampaignList />
      </div>
    ) : c.status === "pending" ? (
      <PickAdAccount />
    ) : (
      <ConnectAds connection={c} />
    );

  return (
    <div className="flex flex-col gap-4">
      {callbackError !== null && (
        <p role="alert" className="text-sm text-danger">
          {tw(reasonKey(callbackError) ?? "ads.error.connect")}
        </p>
      )}
      <Tabs defaultValue="campaigns">
        <TabsList>
          <TabsTrigger value="campaigns">{tw("ads.tab.campaigns")}</TabsTrigger>
          <TabsTrigger value="dashboard">{tw("ads.tab.dashboard")}</TabsTrigger>
        </TabsList>
        <TabsContent value="campaigns" className="pt-4">
          {campaigns}
        </TabsContent>
        <TabsContent value="dashboard" className="pt-4">
          <MarketingDashboard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
