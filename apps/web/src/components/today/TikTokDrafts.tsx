"use client";

import { Button, useToast } from "@fastgram/ui";
import type { CalendarItem } from "@fastgram/contracts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { BrandAvatar } from "@/components/brands/BrandAvatar";
import { CheckIcon, InboxIcon } from "@/icons";
import { copyKeyForError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { useMarkPosted } from "@/lib/today/data";
import { formatShortDate } from "@/lib/today/today";
import { ItemThumb } from "./ItemThumb";
import { libraryHref } from "./TodayTimeline";
import { useEnsureBrand } from "./use-brand-switch";

export interface TikTokDraftsProps {
  readonly drafts: readonly CalendarItem[];
  /** Pendientes que quedaron fuera de la ventana (ver `olderDrafts`). */
  readonly older: number;
  readonly timeZone: string;
}

/**
 * "Terminá estos en la app de TikTok" · `PU-UI-002`, FR-060 (PRD:1410).
 *
 * Un borrador `IN_USER_INBOX` no está publicado: TikTok lo dejó en la app y la
 * API no avisa cuando el usuario lo publica. Por eso el botón **"Mark as
 * posted"** existe: es la única forma de que FastGram se entere. Llama a
 * `POST /posts/:id/mark-posted` con la marca del post en el cuerpo, así funciona
 * sin cambiar la marca activa.
 *
 * Tono `warning` y no `danger`: es trabajo pendiente del usuario, no un error.
 */
export function TikTokDrafts({ drafts, older, timeZone }: TikTokDraftsProps) {
  const reduce = useReducedMotion();
  const { toast } = useToast();
  const ensureBrand = useEnsureBrand();
  const markPosted = useMarkPosted();
  const pendingId = markPosted.isPending ? markPosted.variables.postId : null;

  if (drafts.length === 0 && older === 0) return null;

  return (
    <section
      aria-labelledby="today-drafts-title"
      className="rounded-xl border p-5"
      style={{
        borderColor: "color-mix(in srgb, var(--fg-color-warning) 45%, transparent)",
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--fg-color-warning) 12%, var(--fg-color-surface)), var(--fg-color-surface) 60%)",
      }}
    >
      <header className="mb-4 flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-warning"
          style={{
            background: "color-mix(in srgb, var(--fg-color-warning) 18%, transparent)",
          }}
        >
          <InboxIcon size={18} />
        </span>
        <div className="min-w-0">
          <h2 id="today-drafts-title" className="text-lg font-semibold text-text">
            {tw("today.drafts.title")}
          </h2>
          <p className="text-sm text-text-muted">{tw("today.drafts.body")}</p>
        </div>
      </header>

      <ol className="mb-4 grid gap-2 text-sm text-text sm:grid-cols-3">
        {(
          ["today.drafts.step1", "today.drafts.step2", "today.drafts.step3"] as const
        ).map((key, i) => (
          <li
            key={key}
            className="flex items-start gap-2 rounded-lg bg-surface-sunken p-2"
          >
            <span
              aria-hidden="true"
              className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-surface-raised font-mono text-xs text-text-muted"
            >
              {i + 1}
            </span>
            <span>{tw(key)}</span>
          </li>
        ))}
      </ol>

      <ul className="flex flex-col gap-2" aria-label={tw("today.drafts.title")}>
        <AnimatePresence initial={false}>
          {drafts.map((item) => {
            const busy = pendingId === item.id;
            return (
              <motion.li
                key={item.id}
                data-testid="today-draft"
                layout={reduce !== true}
                initial={reduce === true ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce === true ? { opacity: 0 } : { opacity: 0, x: 24 }}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3"
              >
                <Link
                  href={libraryHref(item.contentId)}
                  onClick={() => {
                    ensureBrand(item.brandId);
                  }}
                  className="fg-focusable flex min-w-0 flex-1 items-center gap-3 rounded-md"
                >
                  <ItemThumb item={item} />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex items-center gap-2 text-sm font-medium text-text">
                      <BrandAvatar id={item.brandId} name={item.brandName} size="xs" />
                      <span className="truncate">{item.brandName}</span>
                    </span>
                    <span className="text-xs text-text-muted">
                      {tw("today.drafts.since", {
                        date: formatShortDate(item.at, timeZone),
                      })}
                    </span>
                  </span>
                </Link>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  aria-busy={busy}
                  onClick={() => {
                    markPosted.mutate(
                      { postId: item.id, brandId: item.brandId },
                      {
                        onSuccess: () => {
                          toast({
                            title: tw("today.drafts.marked"),
                            tone: "success",
                            duration: 2500,
                          });
                        },
                        onError: (error) => {
                          toast({
                            title: tw("today.drafts.markFailed"),
                            description: tw(copyKeyForError(error)),
                            tone: "danger",
                          });
                        },
                      },
                    );
                  }}
                >
                  <CheckIcon size={14} />
                  <span className="ml-1">
                    {busy ? tw("today.drafts.marking") : tw("today.drafts.markPosted")}
                  </span>
                </Button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      {older > 0 && (
        <p className="mt-3 text-xs text-text-muted">
          <Link href={ROUTES.calendar} className="fg-focusable hover:underline">
            {tw("today.drafts.older", { count: older })}
          </Link>
        </p>
      )}
    </section>
  );
}
