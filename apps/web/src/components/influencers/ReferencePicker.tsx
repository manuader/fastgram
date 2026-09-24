"use client";

import {
  INFLUENCER_REFERENCES_MAX,
  INFLUENCER_REFERENCES_MIN,
} from "@fastgram/contracts";
import { Button, Skeleton, buttonVariants, cn } from "@fastgram/ui";
import Link from "next/link";
import { CheckIcon } from "@/icons";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw } from "@/lib/i18n/t";
import { flattenMediaPages, useMediaList } from "@/lib/media/media";
import { ROUTES } from "@/lib/nav/routes";

export interface ReferencePickerProps {
  readonly selected: readonly string[];
  readonly onToggle: (mediaId: string) => void;
}

/**
 * Paso 2 del wizard: elegir 4–20 fotos del Media Bank. Sólo imágenes `ready`
 * (las que la API acepta); para subir nuevas se va a la Library, que ya tiene
 * la subida con sus validaciones (FR-100).
 */
export function ReferencePicker({ selected, onToggle }: ReferencePickerProps) {
  const media = useMediaList({ type: "image", limit: 60 });
  const items = flattenMediaPages(media.data).filter((m) => m.status === "ready");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="m-0 text-sm text-text-muted">
          {tw("influencers.wizard.photos.hint", {
            min: INFLUENCER_REFERENCES_MIN,
            max: INFLUENCER_REFERENCES_MAX,
          })}
        </p>
        <span
          className="shrink-0 text-sm font-medium tabular-nums text-text"
          aria-live="polite"
        >
          {tw("influencers.wizard.photos.count", { count: selected.length })}
        </span>
      </div>
      {media.isError ? (
        <ApiErrorState
          error={media.error}
          onRetry={() => {
            void media.refetch();
          }}
        />
      ) : media.isPending ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" aria-busy="true">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="aspect-square rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border-strong p-4">
          <p className="m-0 text-sm text-text-muted">
            {tw("influencers.wizard.photos.empty")}
          </p>
          <Link
            href={ROUTES.library}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            {tw("influencers.wizard.photos.upload")}
          </Link>
        </div>
      ) : (
        <>
          <ul
            className="m-0 grid max-h-80 list-none grid-cols-3 gap-2 overflow-y-auto p-0 sm:grid-cols-5"
            aria-label={tw("influencers.wizard.photos.title")}
          >
            {items.map((m) => {
              const on = selected.includes(m.mediaId);
              return (
                <li key={m.mediaId}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      onToggle(m.mediaId);
                    }}
                    className={cn(
                      "relative block aspect-square w-full overflow-hidden rounded-lg border-2",
                      on ? "border-accent" : "border-transparent",
                    )}
                  >
                    <img
                      src={m.r2Url}
                      alt={m.filename}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                    {on && (
                      <span className="absolute right-1 top-1 rounded-full bg-accent p-0.5 text-white">
                        <CheckIcon size={12} />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center gap-3">
            {media.hasNextPage && (
              <Button
                variant="ghost"
                size="sm"
                loading={media.isFetchingNextPage}
                onClick={() => {
                  void media.fetchNextPage();
                }}
              >
                {tw("influencers.wizard.photos.more")}
              </Button>
            )}
            <Link
              href={ROUTES.library}
              className="text-xs text-text-subtle hover:text-text"
            >
              {tw("influencers.wizard.photos.upload")}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
