"use client";

import type { Media, MediaCategory, MediaType } from "@fastgram/contracts";
import { imageMediaCategorySchema, videoMediaCategorySchema } from "@fastgram/contracts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@fastgram/ui";
import { useMemo, useState } from "react";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { flattenItems, useMediaPicker } from "@/lib/editor/api";

export interface MediaPickerDialogProps {
  readonly open: boolean;
  readonly type: MediaType;
  readonly title: string;
  /** La URL vigente, marcada como seleccionada al abrir. */
  readonly currentUrl?: string | undefined;
  readonly onCancel: () => void;
  readonly onPick: (url: string) => void;
}

const CATEGORY_COPY: Readonly<Record<MediaCategory, CopyKey>> = {
  "slideshow-image": "editor.picker.category.slideshowImage",
  "green-screen-background": "editor.picker.category.greenScreenBackground",
  "background-video": "editor.picker.category.backgroundVideo",
  "hook-video": "editor.picker.category.hookVideo",
  "green-screen-video": "editor.picker.category.greenScreenVideo",
};

/**
 * `Select Video` (FR-052) y `Swap image for slide N` (FR-071), un mismo modal
 * sobre `GET /media?type=`.
 *
 * Diferencias con el PRD, todas por lo que existe hoy:
 *
 * - **`Library` / `Theme Images` va vacío.** El catálogo compartido de
 *   Fastlane no existe en este producto (ver la cabecera de
 *   `routes/v1/content.ts`): la pestaña está, con su estado vacío, para que el
 *   usuario sepa que no se perdió nada.
 * - **Los filtros son las categorías del Media Bank**, no `Activity` /
 *   `Reaction` / `Man` / `Woman`: esas etiquetas no están en el modelo
 *   (DATA-010). Mismo comportamiento: OR dentro de la fila, `Clear` resetea.
 * - **`Load more` en vez de `Page X of Y`**: la API pagina por cursor y no
 *   devuelve el total.
 *
 * Sólo se ofrecen piezas `ready`: una en `processing` no tiene archivo que el
 * render pueda leer, y la API la rechazaría igual.
 */
export function MediaPickerDialog({
  open,
  type,
  title,
  currentUrl,
  onCancel,
  onPick,
}: MediaPickerDialogProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<ReadonlySet<MediaCategory>>(new Set());
  const query = useMediaPicker(type, open);
  const categories: readonly MediaCategory[] =
    type === "image"
      ? imageMediaCategorySchema.options
      : videoMediaCategorySchema.options;

  const items = useMemo(
    () =>
      flattenItems(query.data).filter(
        (m) =>
          m.status === "ready" &&
          (filters.size === 0 || m.categories.some((c) => filters.has(c))),
      ),
    [query.data, filters],
  );

  const close = () => {
    setSelected(null);
    onCancel();
  };
  const chosen = selected !== null && selected !== currentUrl ? selected : null;

  return (
    <Dialog open={open} onClose={close} size="xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <Tabs defaultValue="mine">
          <TabsList>
            <TabsTrigger value="mine">
              {tw(type === "image" ? "editor.picker.myImages" : "editor.picker.myVideos")}
            </TabsTrigger>
            <TabsTrigger value="library">{tw("editor.picker.library")}</TabsTrigger>
          </TabsList>

          <TabsContent value="mine">
            <div className="my-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-text-muted">{tw("editor.picker.filter")}</span>
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={filters.has(c)}
                  className={cn(
                    "fg-focusable rounded-full border px-2.5 py-1",
                    filters.has(c)
                      ? "border-accent bg-accent-subtle text-text"
                      : "border-border text-text-muted hover:border-border-strong",
                  )}
                  onClick={() =>
                    setFilters((prev) => {
                      const next = new Set(prev);
                      if (next.has(c)) next.delete(c);
                      else next.add(c);
                      return next;
                    })
                  }
                >
                  {tw(CATEGORY_COPY[c])}
                </button>
              ))}
              {filters.size > 0 && (
                <button
                  type="button"
                  className="fg-focusable text-accent underline"
                  onClick={() => setFilters(new Set())}
                >
                  {tw("editor.picker.clear")}
                </button>
              )}
            </div>

            {query.isPending ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className="aspect-[9/16] w-full" />
                ))}
              </div>
            ) : query.isError ? (
              <EmptyState
                bordered
                title={tw("editor.picker.error")}
                action={
                  <Button variant="secondary" onClick={() => void query.refetch()}>
                    {tw("editor.picker.retry")}
                  </Button>
                }
              />
            ) : items.length === 0 ? (
              <EmptyState
                bordered
                // P5-ERR-001: ERR-E06 literal para imágenes sin filtro.
                title={tw(
                  filters.size > 0
                    ? "editor.picker.filteredEmpty"
                    : type === "image"
                      ? "empty.imagePicker.title"
                      : "editor.picker.empty",
                )}
                {...(filters.size === 0 && type === "image"
                  ? { description: tw("editor.picker.empty") }
                  : {})}
              />
            ) : (
              <>
                <ul
                  className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-4"
                  aria-label={title}
                >
                  {items.map((m) => (
                    <MediaTile
                      key={m.mediaId}
                      media={m}
                      selected={(selected ?? currentUrl) === m.r2Url}
                      onSelect={() => setSelected(m.r2Url)}
                    />
                  ))}
                </ul>
                {query.hasNextPage && (
                  <div className="mt-3 flex justify-center">
                    <Button
                      variant="ghost"
                      loading={query.isFetchingNextPage}
                      onClick={() => void query.fetchNextPage()}
                    >
                      {tw("editor.picker.loadMore")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="library">
            <div className="mt-3">
              <EmptyState bordered title={tw("editor.picker.libraryEmpty")} />
            </div>
          </TabsContent>
        </Tabs>
      </DialogBody>
      <DialogFooter>
        <span className="mr-auto text-xs text-text-muted" aria-live="polite">
          {chosen !== null ? tw("editor.picker.selected") : ""}
        </span>
        <Button variant="ghost" onClick={close}>
          {tw("editor.picker.cancel")}
        </Button>
        <Button
          disabled={chosen === null}
          onClick={() => {
            if (chosen === null) return;
            setSelected(null);
            onPick(chosen);
          }}
        >
          {tw("editor.picker.swap")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function MediaTile({
  media,
  selected,
  onSelect,
}: {
  readonly media: Media;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={media.filename}
        className={cn(
          "fg-focusable relative block aspect-[9/16] w-full overflow-hidden rounded-lg border-2 bg-surface-sunken",
          selected ? "border-accent" : "border-transparent hover:border-border-strong",
        )}
        onClick={onSelect}
      >
        {media.mediaType === "image" ? (
          <img
            src={media.r2Url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <video
            src={media.r2Url}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        )}
        {selected && (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-xs text-white"
          >
            ✓
          </span>
        )}
      </button>
    </li>
  );
}
