"use client";

import type { Media, MediaCategory, MediaType } from "@fastgram/contracts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
  cn,
} from "@fastgram/ui";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { tw } from "@/lib/i18n/t";
import { MEDIA_CATEGORY_COPY, flattenMediaPages, useMediaList } from "@/lib/media/media";
import { ROUTES } from "@/lib/nav/routes";
import type { StudioPick } from "@/lib/studio/studio";

export interface StudioMediaPickerProps {
  readonly open: boolean;
  readonly type: MediaType;
  readonly title: string;
  /** Categoría sugerida: el filtro arranca puesto en ella (se puede quitar). */
  readonly preferred: MediaCategory | null;
  /** `> 1` = selección múltiple, en orden de click (slides). */
  readonly max: number;
  readonly initial: readonly StudioPick[];
  readonly onCancel: () => void;
  readonly onPick: (picks: StudioPick[]) => void;
}

const SEARCH_DEBOUNCE_MS = 300;
const PAGE = 24;

/**
 * El selector del Studio: `GET /media` con tipo, búsqueda (`q`) y categoría
 * (sprint 7, `P2-MEDIA-007` — «Search your images» del PRD). Sólo ofrece
 * assets `ready`: uno en `processing` no tiene archivo que el render pueda
 * leer, y `POST /content/studio` lo rechazaría.
 *
 * Con `max > 1` el orden de selección es el orden de los slides.
 */
export function StudioMediaPicker(props: StudioMediaPickerProps) {
  return (
    <Dialog open={props.open} onClose={props.onCancel} size="xl">
      {props.open && <PickerBody {...props} />}
    </Dialog>
  );
}

function PickerBody({
  type,
  title,
  preferred,
  max,
  initial,
  onCancel,
  onPick,
}: StudioMediaPickerProps) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<MediaCategory | null>(preferred);
  const [picked, setPicked] = useState<StudioPick[]>([...initial]);

  useEffect(() => {
    const id = window.setTimeout(() => setQ(search), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [search]);

  const query = useMediaList({
    type,
    q: q === "" ? undefined : q,
    category: category ?? undefined,
    limit: PAGE,
  });
  const items = useMemo(
    () => flattenMediaPages(query.data).filter((m) => m.status === "ready"),
    [query.data],
  );

  const toggle = (m: Media) => {
    setPicked((prev) => {
      const at = prev.findIndex((p) => p.mediaId === m.mediaId);
      if (at !== -1) return prev.filter((_, i) => i !== at);
      const next = { mediaId: m.mediaId, url: m.r2Url, mediaType: m.mediaType };
      if (max === 1) return [next];
      return prev.length >= max ? prev : [...prev, next];
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input
            type="search"
            value={search}
            placeholder={tw("studio.picker.search")}
            aria-label={tw("studio.picker.search")}
            onChange={(e) => setSearch(e.target.value)}
            wrapperClassName="min-w-[12rem] flex-1"
          />
          {preferred !== null && (
            <button
              type="button"
              aria-pressed={category !== null}
              className={cn(
                "fg-focusable rounded-full border px-2.5 py-1 text-xs",
                category !== null
                  ? "border-accent bg-accent-subtle text-text"
                  : "border-border text-text-muted",
              )}
              onClick={() => setCategory((c) => (c === null ? preferred : null))}
            >
              {tw(MEDIA_CATEGORY_COPY[preferred])}
            </button>
          )}
        </div>

        {query.isPending ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="aspect-[9/16] w-full" />
            ))}
          </div>
        ) : query.isError && items.length === 0 ? (
          <EmptyState
            bordered
            title={tw("studio.picker.error")}
            action={
              <Button variant="secondary" onClick={() => void query.refetch()}>
                {tw("studio.retry")}
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            bordered
            // P5-ERR-001: ERR-E06 (`No available images.`, literal) cuando se
            // eligen imágenes sin filtro; para video no hay copy en el PRD.
            title={tw(
              q !== "" || category !== null
                ? "studio.picker.filteredEmpty"
                : type === "image"
                  ? "empty.imagePicker.title"
                  : "studio.picker.empty",
            )}
            {...(q === "" && category === null && type === "image"
              ? { description: tw("studio.picker.empty") }
              : {})}
            action={
              q !== "" || category !== null ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch("");
                    setQ("");
                    setCategory(null);
                  }}
                >
                  {tw("studio.picker.clearFilters")}
                </Button>
              ) : (
                <Link href={ROUTES.library} className="text-accent underline">
                  {tw("studio.picker.goToLibrary")}
                </Link>
              )
            }
          />
        ) : (
          <>
            <ul
              className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-4"
              aria-label={title}
            >
              {items.map((m) => {
                const order = picked.findIndex((p) => p.mediaId === m.mediaId);
                return (
                  <li key={m.mediaId}>
                    <button
                      type="button"
                      aria-pressed={order !== -1}
                      aria-label={m.filename}
                      className={cn(
                        "fg-focusable relative block aspect-[9/16] w-full overflow-hidden rounded-lg border-2 bg-surface-sunken",
                        order !== -1
                          ? "border-accent"
                          : "border-transparent hover:border-border-strong",
                      )}
                      onClick={() => toggle(m)}
                    >
                      {m.mediaType === "image" ? (
                        <img
                          src={m.r2Url}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <video
                          src={m.r2Url}
                          muted
                          playsInline
                          preload="metadata"
                          className="h-full w-full object-cover"
                        />
                      )}
                      {order !== -1 && (
                        <span
                          aria-hidden
                          className="absolute right-1.5 top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs text-white"
                        >
                          {max > 1 ? String(order + 1) : "✓"}
                        </span>
                      )}
                      <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1.5 py-0.5 text-left text-[10px] text-white">
                        {m.filename}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {query.hasNextPage && (
              <div className="mt-3 flex justify-center">
                <Button
                  variant="ghost"
                  loading={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {tw("media.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <span className="mr-auto text-xs text-text-muted" aria-live="polite">
          {max > 1
            ? tw("studio.picker.selectedCount", { count: picked.length, max })
            : ""}
        </span>
        <Button variant="ghost" onClick={onCancel}>
          {tw("studio.cancel")}
        </Button>
        <Button disabled={picked.length === 0} onClick={() => onPick(picked)}>
          {tw("studio.picker.use")}
        </Button>
      </DialogFooter>
    </>
  );
}
