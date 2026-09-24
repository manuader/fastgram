"use client";

import type { BanMeter } from "@fastgram/contracts";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@fastgram/ui";
import { tw } from "@/lib/i18n/t";
import {
  BAN_LEVEL_TONE,
  banLevelKey,
  banRecommendationKey,
  percent,
} from "@/lib/engagement/present";

export interface BanMeterCardProps {
  readonly meter: BanMeter;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}

/**
 * Ban risk meter — `F-197`, `F-200`. **Muestra** lo que la API calculó en
 * código (`DP-003`): el nivel, el ratio y los conteos. Ningún número de acá
 * sale de un modelo.
 */
export function BanMeterCard({ meter, onRefresh, refreshing }: BanMeterCardProps) {
  const pct = percent(meter.promoRatio);
  return (
    <Card data-testid="ban-meter">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{tw("engagement.banMeter.title")}</CardTitle>
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
          {tw("engagement.banMeter.refresh")}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={BAN_LEVEL_TONE[meter.level]} data-testid="ban-level">
            {tw(banLevelKey(meter.level))}
          </Badge>
          {pct === null ? null : (
            <span className="text-sm text-text-muted">
              {tw("engagement.banMeter.promoRatio", { percent: pct })}
            </span>
          )}
        </div>
        <p className="m-0 text-sm text-text">{tw(banRecommendationKey(meter.level))}</p>
        <p className="m-0 text-xs text-text-muted">
          {tw("engagement.banMeter.counts", {
            days: meter.windowDays,
            value: meter.counts.valueAdd,
            subtle: meter.counts.subtle,
            direct: meter.counts.direct,
          })}
        </p>
        {meter.counts.unlabeled > 0 ? (
          <p className="m-0 text-xs text-warning">
            {tw("engagement.banMeter.unlabeled", { count: meter.counts.unlabeled })}
          </p>
        ) : null}
        {meter.smallSample && meter.sampleSize > 0 ? (
          <p className="m-0 text-xs text-text-muted">
            {tw("engagement.banMeter.smallSample")}
          </p>
        ) : null}
        <p className="m-0 text-xs text-text-muted">
          {tw("engagement.banMeter.ratio")} {tw("engagement.banMeter.perPromo")}
        </p>
      </CardContent>
    </Card>
  );
}
