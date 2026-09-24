"use client";

import { buttonVariants, Skeleton } from "@fastgram/ui";
import type { CalendarItem } from "@fastgram/contracts";
import Link from "next/link";
import { BrandAvatar } from "@/components/brands/BrandAvatar";
import { CloseIcon } from "@/icons";
import { NETWORK_LABEL } from "@/lib/calendar/board";
import { tw } from "@/lib/i18n/t";
import type { PostDetail } from "@/lib/today/data";
import { formatShortDate } from "@/lib/today/today";
import { libraryHref } from "./TodayTimeline";
import { useEnsureBrand } from "./use-brand-switch";

export interface FailedCardProps {
  readonly failed: readonly CalendarItem[] | undefined;
  readonly details: ReadonlyMap<string, PostDetail> | undefined;
  readonly timeZone: string;
}

/**
 * Fallidos de los últimos 7 días · `PU-UI-002`.
 *
 * El motivo es `errorMessage`, que FR-060 declara *"siempre seguro de mostrar"*
 * (el mismo criterio de `PostCard`). Sólo llega para la marca activa —el
 * calendario no lo trae, ver `lib/today/data.ts`—; para las otras, un texto que
 * manda a la pieza.
 *
 * La acción es **"Open"** y no "Retry": no hay endpoint para reintentar un post
 * fallido (y reprogramar a ciegas uno de TikTok puede duplicarlo, NFR-015). El
 * detalle de la pieza es donde se decide qué hacer.
 */
export function FailedCard({ failed, details, timeZone }: FailedCardProps) {
  const ensureBrand = useEnsureBrand();

  return (
    <section
      aria-labelledby="today-failed-title"
      className="rounded-xl border border-border bg-surface p-5"
    >
      <h2
        id="today-failed-title"
        className="mb-3 flex items-center gap-2 text-base font-semibold text-text"
      >
        <span aria-hidden="true" className="text-danger">
          <CloseIcon size={16} />
        </span>
        {tw("today.failed.title")}
      </h2>
      {failed === undefined ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      ) : failed.length === 0 ? (
        <p className="text-sm text-text-muted">{tw("today.failed.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {failed.map((item) => {
            const reason =
              details?.get(item.id)?.errorMessage ?? tw("today.failedFallback");
            return (
              <li
                key={`${item.kind}:${item.id}`}
                data-testid="today-failed-item"
                className="flex items-start gap-3 rounded-lg p-2"
              >
                <BrandAvatar id={item.brandId} name={item.brandName} size="xs" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium text-text">
                    {item.brandName} · {NETWORK_LABEL[item.network]} ·{" "}
                    <span className="font-normal text-text-muted">
                      {formatShortDate(item.at, timeZone)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-xs text-danger">{reason}</span>
                </div>
                <Link
                  href={libraryHref(item.contentId)}
                  onClick={() => {
                    ensureBrand(item.brandId);
                  }}
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  {tw("today.failed.open")}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
