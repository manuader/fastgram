"use client";

import { Skeleton } from "@fastgram/ui";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw } from "@/lib/i18n/t";
import { useEngagementOverview, useRefreshBanMeter } from "@/lib/engagement/api";
import { BanMeterCard } from "./BanMeterCard";

/**
 * Engagement → Insights. El medidor con su explicación: el modelo sólo
 * etiqueta cada respuesta; el porcentaje y el nivel los cuenta FastGram
 * (`DP-003`).
 */
export function EngagementInsights() {
  const overview = useEngagementOverview();
  const refresh = useRefreshBanMeter();
  if (overview.isPending) {
    return (
      <div aria-busy="true">
        <Skeleton height={200} />
      </div>
    );
  }
  if (overview.isError) {
    return (
      <ApiErrorState error={overview.error} onRetry={() => void overview.refetch()} />
    );
  }
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <section className="flex flex-col gap-1">
        <h2 className="m-0 text-lg font-semibold text-text">
          {tw("engagement.insights.title")}
        </h2>
        <p className="m-0 text-sm text-text-muted">{tw("engagement.insights.body")}</p>
      </section>
      <BanMeterCard
        meter={overview.data.banMeter}
        refreshing={refresh.isPending}
        onRefresh={() => refresh.mutate()}
      />
    </div>
  );
}
