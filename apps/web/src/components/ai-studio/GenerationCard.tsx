"use client";

import type { GenAspectRatio, Generation } from "@fastgram/contracts";
import { Badge, Skeleton, buttonVariants, cn } from "@fastgram/ui";
import Link from "next/link";
import { LibraryIcon, ZapIcon } from "@/icons";
import {
  GENERATION_ERROR_COPY,
  GENERATION_STATUS_COPY,
  GENERATION_STATUS_TONE,
  isInFlight,
  isSlow,
} from "@/lib/ai-studio/form";
import { tw } from "@/lib/i18n/t";
import { formatUsd } from "@/lib/models/budget";
import { ROUTES } from "@/lib/nav/routes";

/** `aspect-ratio` de CSS para cada relación. */
const CSS_RATIO: Readonly<Record<GenAspectRatio, string>> = {
  "1:1": "1 / 1",
  "4:5": "4 / 5",
  "3:4": "3 / 4",
  "4:3": "4 / 3",
  "9:16": "9 / 16",
  "16:9": "16 / 9",
};

export interface GenerationCardProps {
  readonly generation: Generation;
}

/**
 * Una generación en la galería: la media (ya en **nuestro** storage), su
 * estado y qué hacer con ella. Lo listo ya está en el Media Bank; «Use in
 * Blitz» lleva a crear una pieza desde un prompt, que elige media del banco.
 */
export function GenerationCard({ generation: g }: GenerationCardProps) {
  const ratio = CSS_RATIO[g.aspectRatio];
  const first = g.media[0];
  return (
    <article
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition-shadow hover:shadow-md"
      aria-label={g.prompt === "" ? g.model : g.prompt}
      data-testid="generation-card"
      data-status={g.status}
    >
      <div className="relative bg-surface-sunken" style={{ aspectRatio: ratio }}>
        {g.status === "ready" && first !== undefined ? (
          first.mediaType === "video" ? (
            <video
              src={first.url}
              className="absolute inset-0 h-full w-full object-cover"
              muted
              loop
              playsInline
              controls
              preload="metadata"
            />
          ) : (
            <img
              src={first.url}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
            />
          )
        ) : isInFlight(g) ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
            <Skeleton className="absolute inset-0 h-full w-full" />
            <span className="relative text-xs text-text-muted" role="status">
              {tw("aiStudio.card.working")}
              {/* ERR-L09: la galería se vuelve a pedir mientras algo está en
                  vuelo, así que este `Date.now()` se refresca solo. */}
              {isSlow(g, Date.now()) && (
                <span className="mt-1 block">{tw("loading.aiStudioSlow")}</span>
              )}
            </span>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
            <p className="m-0 text-sm text-text-muted">
              {g.error === null
                ? tw(GENERATION_STATUS_COPY[g.status])
                : tw(GENERATION_ERROR_COPY[g.error.code])}
            </p>
          </div>
        )}
        <div className="absolute left-3 top-3 flex gap-2">
          <Badge tone={GENERATION_STATUS_TONE[g.status]} size="sm">
            {tw(GENERATION_STATUS_COPY[g.status])}
          </Badge>
          {g.media.length > 1 && (
            <Badge tone="neutral" size="sm">
              ×{g.media.length}
            </Badge>
          )}
        </div>
      </div>

      {g.media.length > 1 && (
        <div className="flex gap-1 overflow-x-auto p-2">
          {g.media
            .slice(1)
            .map((m) =>
              m.mediaType === "image" ? (
                <img
                  key={m.mediaId}
                  src={m.url}
                  alt=""
                  loading="lazy"
                  className="h-12 w-12 flex-none rounded-md object-cover"
                />
              ) : null,
            )}
        </div>
      )}

      <div className="flex flex-1 flex-col gap-2 p-4">
        <p className="m-0 line-clamp-2 text-sm text-text">{g.prompt}</p>
        <p className="m-0 text-xs text-text-subtle">
          {g.model}
          {" · "}
          {tw("aiStudio.card.cost", { cost: formatUsd(g.estimate.usd) })}
        </p>
        {g.status === "ready" && (
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            <Link
              href={ROUTES.library}
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1")}
            >
              <LibraryIcon size={14} />
              {tw("aiStudio.card.inMediaBank")}
            </Link>
            <Link
              href={`${ROUTES.blitz}#create`}
              className={cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
                "gap-1",
              )}
            >
              <ZapIcon size={14} />
              {tw("aiStudio.card.useInBlitz")}
            </Link>
          </div>
        )}
      </div>
    </article>
  );
}
