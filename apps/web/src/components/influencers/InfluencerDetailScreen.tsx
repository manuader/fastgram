"use client";

import { Badge, EmptyState, Skeleton, buttonVariants, cn } from "@fastgram/ui";
import Link from "next/link";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { ChevronLeftIcon, UserIcon, WandIcon } from "@/icons";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import { useInfluencer, useInfluencerGenerations } from "@/lib/influencers/api";
import {
  FAILURE_COPY,
  STATUS_COPY,
  isInFlight,
  traitsLine,
  type InfluencerView,
} from "@/lib/influencers/form";
import { ROUTES } from "@/lib/nav/routes";
import { ImageComposer } from "./ImageComposer";

function Gallery({ influencer }: { readonly influencer: InfluencerView }) {
  const generations = useInfluencerGenerations(influencer._id, true);
  if (generations.isError) {
    return (
      <ApiErrorState
        error={generations.error}
        onRetry={() => {
          void generations.refetch();
        }}
      />
    );
  }
  if (generations.isPending) {
    return (
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5"
        aria-busy="true"
      >
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="aspect-[9/16] rounded-xl" />
        ))}
      </div>
    );
  }
  const items = generations.data;
  if (items.length === 0) {
    return (
      <EmptyState icon={<WandIcon size={20} />} title={tw("influencers.images.empty")} />
    );
  }
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 xl:grid-cols-5">
      {items.flatMap((g) => {
        if (g.status === "queued" || g.status === "generating") {
          return [
            <li
              key={g.id}
              className="flex aspect-[9/16] items-center justify-center rounded-xl border border-dashed border-border-strong p-3 text-center text-xs text-text-muted"
            >
              {tw("influencers.images.pending")}
            </li>,
          ];
        }
        if (g.status !== "ready") {
          return [
            <li
              key={g.id}
              className="flex aspect-[9/16] flex-col items-center justify-center gap-1 rounded-xl border border-border p-3 text-center text-xs text-danger"
            >
              <span className="line-clamp-3 text-text-muted">{g.prompt}</span>
              <span>{g.error?.message ?? tw("influencers.images.failedToStart")}</span>
            </li>,
          ];
        }
        return g.media.map((m) => (
          <li key={m.mediaId} className="overflow-hidden rounded-xl bg-surface-sunken">
            <img
              src={m.url}
              alt={g.prompt}
              loading="lazy"
              className="aspect-[9/16] h-full w-full object-cover"
            />
          </li>
        ));
      })}
    </ul>
  );
}

/**
 * `/influencers/:id` — FR-081 adaptado (`PU-LATER-004`): cabecera con estado,
 * avance del entrenamiento o motivo del fallo; con el personaje activo, la
 * barra para generar imágenes y la galería. Video y Talking Head no están: la
 * API de Higgsfield no documenta video con personaje.
 */
export function InfluencerDetailScreen({
  influencerId,
}: {
  readonly influencerId: string;
}) {
  const query = useInfluencer(influencerId);

  const back = (
    <Link
      href={ROUTES.influencers}
      className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted hover:text-text"
    >
      <ChevronLeftIcon size={16} />
      {tw("influencers.detail.back")}
    </Link>
  );

  if (query.isError) {
    const notFound = isApiRequestError(query.error) && query.error.status === 404;
    return (
      <div className="fgw-page">
        {back}
        {notFound ? (
          <EmptyState
            icon={<UserIcon size={20} />}
            title={tw("influencers.detail.notFound")}
          />
        ) : (
          <ApiErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        )}
      </div>
    );
  }

  if (query.isPending) {
    return (
      <div className="fgw-page" aria-busy="true">
        {back}
        <Skeleton shape="text" width="30%" />
        <Skeleton height={120} className="mt-4" />
      </div>
    );
  }

  const inf = query.data;
  const traits = traitsLine(inf);
  return (
    <div className="fgw-page">
      {back}
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <div className="h-20 w-16 overflow-hidden rounded-xl bg-surface-sunken">
          {inf.baseImageUrl !== undefined && (
            <img src={inf.baseImageUrl} alt="" className="h-full w-full object-cover" />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="m-0 truncate text-2xl font-semibold text-text">{inf.name}</h1>
            <Badge
              tone={
                inf.status === "ready"
                  ? "success"
                  : inf.status === "failed"
                    ? "danger"
                    : "info"
              }
              size="sm"
            >
              {tw(STATUS_COPY[inf.status])}
            </Badge>
          </div>
          {traits !== "" && <span className="text-sm text-text-muted">{traits}</span>}
        </div>
        <Link
          href={ROUTES.blitzSettings}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "ml-auto")}
        >
          {tw("influencers.detail.blitz")}
        </Link>
      </header>

      {isInFlight(inf) && (
        <div className="mb-6 flex flex-col gap-2 rounded-2xl border border-border bg-surface p-5">
          <p className="m-0 text-sm text-text">{tw("influencers.detail.training")}</p>
          <div
            className="h-2 overflow-hidden rounded-full bg-surface-sunken"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={inf.progress}
            aria-label={tw(STATUS_COPY[inf.status])}
          >
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${String(inf.progress)}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-text-muted">
            {tw(STATUS_COPY[inf.status])} ·{" "}
            {tw("influencers.progress", { progress: inf.progress })}
          </span>
        </div>
      )}

      {inf.status === "failed" && (
        <p className="mb-6 text-sm text-danger" role="alert">
          {inf.failure === undefined
            ? tw("influencers.failure.training_failed")
            : `${tw(FAILURE_COPY[inf.failure.code])} ${inf.failure.message}`}
        </p>
      )}

      {inf.status === "ready" && (
        <div className="flex flex-col gap-6">
          <ImageComposer influencerId={inf._id} gender={inf.gender} />
          <section aria-labelledby="influencer-images" className="flex flex-col gap-3">
            <h2 id="influencer-images" className="m-0 text-lg font-semibold text-text">
              {tw("influencers.images.title")}
            </h2>
            <p className="m-0 text-xs text-text-subtle">
              {tw("influencers.detail.blitzHint")}
            </p>
            <Gallery influencer={inf} />
          </section>
        </div>
      )}
    </div>
  );
}
