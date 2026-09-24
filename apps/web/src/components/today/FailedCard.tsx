"use client";

import { Button, buttonVariants, Skeleton, useToast } from "@fastgram/ui";
import type { CalendarItem } from "@fastgram/contracts";
import Link from "next/link";
import { useState } from "react";
import { BrandAvatar } from "@/components/brands/BrandAvatar";
import { PostEditDialog } from "@/components/schedule/PostEditDialog";
import { presentError } from "@/lib/api/error-presentation";
import { UNCERTAIN_FAILURE_CODES, useRetryPost } from "@/lib/posts/schedule";
import { CloseIcon } from "@/icons";
import { NETWORK_LABEL } from "@/lib/calendar/board";
import { tw } from "@/lib/i18n/t";
import { failureReason } from "@/lib/today/failure";
import { formatShortDate } from "@/lib/today/today";
import { libraryHref } from "./TodayTimeline";
import { useEnsureBrand } from "./use-brand-switch";

export interface FailedCardProps {
  readonly failed: readonly CalendarItem[] | undefined;
  readonly timeZone: string;
}

/**
 * Fallidos de los últimos 7 días · `PU-UI-002`.
 *
 * El motivo sale del `errorCode`/`errorMessage` que el calendario trae para
 * cualquier marca; el orden está en `lib/today/failure.ts`.
 *
 * Acciones (sprint 7): **Retry** re-encola el mismo post ya
 * (`POST /posts/:id/retry`, con su `brandId`: Today mezcla marcas);
 * **Reschedule** abre el diálogo del post para elegir la hora; **Open** va a la
 * pieza. Un fallo de entrega incierta (`delivery_unconfirmed`,
 * `platform_processing_timeout`) no se reintenta con un click: abre el diálogo,
 * que pide confirmar que la plataforma no lo publicó (NFR-015).
 */
export function FailedCard({ failed, timeZone }: FailedCardProps) {
  const ensureBrand = useEnsureBrand();
  const retry = useRetryPost();
  const { toast } = useToast();
  const [editing, setEditing] = useState<CalendarItem | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const openEditor = (item: CalendarItem) => {
    ensureBrand(item.brandId);
    setEditing(item);
  };

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
            const reason = failureReason(item);
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
                {item.kind === "post" && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={retry.isPending && retrying === item.id}
                      disabled={retry.isPending}
                      onClick={() => {
                        if (
                          item.errorCode !== undefined &&
                          UNCERTAIN_FAILURE_CODES.has(item.errorCode)
                        ) {
                          openEditor(item);
                          return;
                        }
                        setRetrying(item.id);
                        retry.mutate(
                          { postId: item.id, brandId: item.brandId },
                          {
                            onSuccess: () => {
                              toast({
                                title: tw("postEdit.toast.retried"),
                                tone: "success",
                              });
                            },
                            onError: (error) => {
                              const p = presentError(error);
                              toast({
                                title: tw(p.titleKey, p.titleVars),
                                tone: "danger",
                              });
                            },
                            onSettled: () => {
                              setRetrying(null);
                            },
                          },
                        );
                      }}
                    >
                      {tw("today.failed.retry")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        openEditor(item);
                      }}
                    >
                      {tw("today.failed.reschedule")}
                    </Button>
                  </>
                )}
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
      <PostEditDialog
        open={editing !== null}
        postId={editing?.id ?? null}
        timeZone={timeZone}
        onClose={() => {
          setEditing(null);
        }}
        {...(editing === null ? {} : { brandId: editing.brandId })}
      />
    </section>
  );
}
