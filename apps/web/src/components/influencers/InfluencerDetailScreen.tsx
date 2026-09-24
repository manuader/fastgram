"use client";

import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  buttonVariants,
  cn,
} from "@fastgram/ui";
import Link from "next/link";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { ChevronLeftIcon, UserIcon, WandIcon } from "@/icons";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import {
  useInfluencer,
  useInfluencerGenerations,
  useInfluencerSetup,
} from "@/lib/influencers/api";
import {
  FAILURE_COPY,
  STATUS_COPY,
  isInFlight,
  traitsLine,
  type InfluencerView,
} from "@/lib/influencers/form";
import { ROUTES } from "@/lib/nav/routes";
import { useState } from "react";
import { AnimateDialog } from "./AnimateDialog";
import { ConfigurationPanel } from "./ConfigurationPanel";
import { ImageComposer } from "./ImageComposer";
import { NewInfluencerWizard } from "./NewInfluencerWizard";

function Gallery({
  influencer,
  kind,
  onAnimate,
}: {
  readonly influencer: InfluencerView;
  readonly kind: "image" | "video";
  readonly onAnimate?: ((m: { mediaId: string; url: string }) => void) | undefined;
}) {
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
  const items = generations.data.filter((g) => g.kind === kind);
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<WandIcon size={20} />}
        title={tw(
          kind === "image" ? "influencers.images.empty" : "influencers.videos.empty",
        )}
      />
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
              {tw(
                kind === "image"
                  ? "influencers.images.pending"
                  : "influencers.videos.pending",
              )}
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
          <li
            key={m.mediaId}
            className="group relative overflow-hidden rounded-xl bg-surface-sunken"
          >
            {m.mediaType === "video" ? (
              <video
                src={m.url}
                className="aspect-[9/16] h-full w-full object-cover"
                controls
                muted
                playsInline
                preload="metadata"
              />
            ) : (
              <img
                src={m.url}
                alt={g.prompt}
                loading="lazy"
                className="aspect-[9/16] h-full w-full object-cover"
              />
            )}
            {m.mediaType === "image" && onAnimate !== undefined && (
              <Button
                size="sm"
                variant="secondary"
                className="absolute bottom-2 left-1/2 -translate-x-1/2 opacity-90 group-hover:opacity-100"
                onClick={() => {
                  onAnimate({ mediaId: m.mediaId, url: m.url });
                }}
              >
                {tw("influencers.animate.action")}
              </Button>
            )}
          </li>
        ));
      })}
    </ul>
  );
}

/**
 * `/influencers/:id` — FR-081 adaptado (`PU-LATER-004`): cabecera con estado,
 * avance del entrenamiento o motivo del fallo; con el personaje activo, la
 * barra para generar imágenes y la galería. Sprint 7: tabs `Images` ·
 * `Videos` · `Configuration` (FR-081…FR-083), «Animate» sobre cada imagen
 * (image-to-video de Higgsfield) y «Regenerate» = persona nueva (F-093).
 * Talking Head no está: ningún proveedor documenta lip-sync por API.
 */
export function InfluencerDetailScreen({
  influencerId,
}: {
  readonly influencerId: string;
}) {
  const query = useInfluencer(influencerId);
  const setup = useInfluencerSetup();
  const [animating, setAnimating] = useState<{ mediaId: string; url: string } | null>(
    null,
  );
  const [regenerating, setRegenerating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
        <div className="ml-auto flex items-center gap-2">
          {setup.data !== undefined && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setRegenerating(true);
              }}
            >
              {tw("influencers.regenerate.action")}
            </Button>
          )}
          <Link
            href={ROUTES.blitzSettings}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
          >
            {tw("influencers.detail.blitz")}
          </Link>
        </div>
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
        <Tabs defaultValue="images">
          <TabsList>
            <TabsTrigger value="images">{tw("influencers.tabs.images")}</TabsTrigger>
            <TabsTrigger value="videos">{tw("influencers.tabs.videos")}</TabsTrigger>
            <TabsTrigger value="configuration">
              {tw("influencers.tabs.configuration")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="images">
            <div className="mt-4 flex flex-col gap-6">
              <ImageComposer influencerId={inf._id} gender={inf.gender} />
              <section
                aria-labelledby="influencer-images"
                className="flex flex-col gap-3"
              >
                <h2
                  id="influencer-images"
                  className="m-0 text-lg font-semibold text-text"
                >
                  {tw("influencers.images.title")}
                </h2>
                <p className="m-0 text-xs text-text-subtle">
                  {tw("influencers.detail.blitzHint")}
                </p>
                <Gallery influencer={inf} kind="image" onAnimate={setAnimating} />
              </section>
            </div>
          </TabsContent>
          <TabsContent value="videos">
            <section className="mt-4 flex flex-col gap-3">
              <p className="m-0 text-xs text-text-subtle">
                {tw("influencers.videos.hint")}
              </p>
              {notice !== null && <p className="m-0 text-sm text-success">{notice}</p>}
              <Gallery influencer={inf} kind="video" />
            </section>
          </TabsContent>
          <TabsContent value="configuration">
            <div className="mt-4">
              <ConfigurationPanel influencerId={inf._id} />
            </div>
          </TabsContent>
        </Tabs>
      )}
      <AnimateDialog
        influencerId={inf._id}
        source={animating}
        models={setup.data?.videoModels ?? []}
        onClose={() => {
          setAnimating(null);
        }}
        onStarted={() => {
          setNotice(tw("influencers.animate.started"));
        }}
      />
      {setup.data !== undefined && (
        <NewInfluencerWizard
          open={regenerating}
          onClose={() => {
            setRegenerating(false);
          }}
          setup={setup.data}
          regeneratedFromId={inf._id}
          initial={{
            name: inf.name,
            gender:
              inf.gender === "female" || inf.gender === "male" || inf.gender === "other"
                ? inf.gender
                : "",
            age: inf.age ?? null,
            ethnicity: inf.ethnicity ?? "",
          }}
        />
      )}
    </div>
  );
}
