"use client";

import { Badge, Skeleton } from "@fastgram/ui";
import type { CalendarItem } from "@fastgram/contracts";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { BrandAvatar } from "@/components/brands/BrandAvatar";
import { ExternalLinkIcon } from "@/icons";
import { NETWORK_CHIP_COLOR, NETWORK_LABEL } from "@/lib/calendar/board";
import { formatChipTime } from "@/lib/calendar/calendar";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import type { PostDetail } from "@/lib/today/data";
import { ItemThumb } from "./ItemThumb";
import { statusOf } from "./status";
import { useEnsureBrand } from "./use-brand-switch";

export interface TodayTimelineProps {
  readonly items: readonly CalendarItem[] | undefined;
  readonly details: ReadonlyMap<string, PostDetail> | undefined;
  readonly timeZone: string;
  /** Para no repetir la marca en cada fila cuando hay una sola. */
  readonly multiBrand: boolean;
}

export const libraryHref = (contentId: string): string =>
  `${ROUTES.library}/${encodeURIComponent(contentId)}`;

/**
 * El timeline de hoy, todas las marcas · `PU-UI-002`.
 *
 * Cada fila es un enlace al detalle de la pieza (el `<a>` envuelve sólo la parte
 * informativa; el "View post" es otro enlace, afuera, porque dos enlaces
 * anidados no son HTML válido). Entran con un resorte corto, escalonado; con
 * `prefers-reduced-motion` aparecen sin moverse.
 */
export function TodayTimeline({
  items,
  details,
  timeZone,
  multiBrand,
}: TodayTimelineProps) {
  const reduce = useReducedMotion();
  const ensureBrand = useEnsureBrand();

  if (items === undefined) {
    return (
      <ul className="flex flex-col gap-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            className="flex items-center gap-3 rounded-lg border border-border p-3"
          >
            <Skeleton width={36} height={48} />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton width="40%" height={14} />
              <Skeleton width="25%" height={12} />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (items.length === 0) {
    return <p className="text-sm text-text-muted">{tw("today.timeline.empty")}</p>;
  }

  return (
    <ol className="flex flex-col gap-2" aria-label={tw("today.timeline.title")}>
      {items.map((item, index) => {
        const status = statusOf(item.status);
        const detail = item.kind === "post" ? details?.get(item.id) : undefined;
        const time = formatChipTime(item.at, timeZone);
        const network = NETWORK_LABEL[item.network];
        const reason =
          item.status === "FAILED"
            ? (detail?.errorMessage ?? tw("today.failedFallback"))
            : undefined;
        return (
          <motion.li
            key={`${item.kind}:${item.id}`}
            data-testid="today-timeline-item"
            data-status={item.status}
            initial={reduce === true ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              type: "spring",
              stiffness: 420,
              damping: 34,
              delay: Math.min(index, 10) * 0.035,
            }}
            className="group flex items-center gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-border-strong"
            style={{ borderLeft: `3px solid ${NETWORK_CHIP_COLOR[item.network]}` }}
          >
            <Link
              href={libraryHref(item.contentId)}
              onClick={() => {
                ensureBrand(item.brandId);
              }}
              className="fg-focusable flex min-w-0 flex-1 items-center gap-3 rounded-md"
              aria-label={tw("today.timeline.itemLabel", {
                brand: item.brandName,
                network,
                time,
                status: tw(status.key),
              })}
            >
              <time
                dateTime={new Date(item.at).toISOString()}
                className="w-16 flex-none font-mono text-sm tabular-nums text-text-muted"
              >
                {time}
              </time>
              <ItemThumb item={item} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-text">
                  <BrandAvatar id={item.brandId} name={item.brandName} size="xs" />
                  {multiBrand && <span className="truncate">{item.brandName}</span>}
                  <span
                    className="inline-flex items-center gap-1 text-text-muted"
                    style={{ color: NETWORK_CHIP_COLOR[item.network] }}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: NETWORK_CHIP_COLOR[item.network] }}
                    />
                    {network}
                  </span>
                </span>
                {reason !== undefined && (
                  <span className="line-clamp-2 text-xs text-danger">{reason}</span>
                )}
              </span>
            </Link>
            <span className="flex flex-none flex-col items-end gap-1">
              <Badge tone={status.tone} size="sm">
                {tw(status.key)}
              </Badge>
              {item.status === "POSTED" && detail?.postUrl !== undefined && (
                <a
                  href={detail.postUrl}
                  target="_blank"
                  rel="noopener"
                  className="fg-focusable inline-flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  {tw("today.viewPost")}
                  <ExternalLinkIcon size={12} />
                </a>
              )}
            </span>
          </motion.li>
        );
      })}
    </ol>
  );
}
