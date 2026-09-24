"use client";

import { Badge, cn } from "@fastgram/ui";
import Link from "next/link";
import { UserIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import {
  FAILURE_COPY,
  STATUS_COPY,
  isInFlight,
  traitsLine,
  type InfluencerView,
} from "@/lib/influencers/form";
import { ROUTES } from "@/lib/nav/routes";

/** Tarjeta de la grilla de `/influencers` (F-090): portada, nombre, estado, rasgos. */
export function InfluencerCard({ influencer }: { readonly influencer: InfluencerView }) {
  const traits = traitsLine(influencer);
  const tone =
    influencer.status === "ready"
      ? "success"
      : influencer.status === "failed"
        ? "danger"
        : influencer.status === "inactive"
          ? "neutral"
          : "info";
  return (
    <Link
      href={`${ROUTES.influencers}/${influencer._id}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition hover:border-border-strong"
      data-testid="influencer-card"
    >
      <div className="relative aspect-[3/4] w-full bg-surface-sunken">
        {influencer.baseImageUrl === undefined ? (
          <div className="flex h-full items-center justify-center text-text-subtle">
            <UserIcon size={32} />
          </div>
        ) : (
          <img
            src={influencer.baseImageUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        )}
        {isInFlight(influencer) && (
          <div
            className="absolute inset-x-0 bottom-0 h-1.5 bg-surface/60"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={influencer.progress}
            aria-label={tw(STATUS_COPY[influencer.status])}
          >
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${String(influencer.progress)}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-semibold text-text">{influencer.name}</span>
          <Badge tone={tone} size="sm">
            {tw(STATUS_COPY[influencer.status])}
            {isInFlight(influencer) &&
              ` · ${tw("influencers.progress", { progress: influencer.progress })}`}
          </Badge>
        </div>
        {influencer.modelId !== undefined && (
          // Sprint 8 (K): la fila representa un modelo de la biblioteca del dueño.
          <span className="self-start">
            <Badge tone="accent" size="sm">
              {tw("charModels.fromLibrary")}
            </Badge>
          </span>
        )}
        {traits !== "" && <span className="text-xs text-text-muted">{traits}</span>}
        {influencer.failure !== undefined && (
          <span className={cn("text-xs text-danger")}>
            {tw(FAILURE_COPY[influencer.failure.code])}
          </span>
        )}
      </div>
    </Link>
  );
}
