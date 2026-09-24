"use client";

import type { MediaSet, MediaSetKind } from "@fastgram/contracts";
import { Badge, Button, Skeleton } from "@fastgram/ui";
import { presentError } from "@/lib/api/error-presentation";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { useDeleteMediaSet, useMediaSets } from "@/lib/media/sets";

export const SET_KIND_COPY: Readonly<Record<MediaSetKind, CopyKey>> = {
  SLIDESHOW: "mediaBank.sets.kind.slideshow",
  VIDEO: "mediaBank.sets.kind.video",
  CURATED: "mediaBank.sets.kind.curated",
};

/**
 * Fila `YOUR SETS` del Media Bank (PRD:1620, `F-127`, `P2-MEDIA-005`):
 * tile `+ New set` y una tarjeta por set con su badge de tipo y su nombre.
 * Los cuatro estados: loading (skeleton), error (con reintento, sin tapar la
 * grid de abajo), vacío (sólo el tile) y datos.
 */
export function MediaSetsRow({
  creating,
  onNewSet,
}: {
  readonly creating: boolean;
  readonly onNewSet: () => void;
}) {
  const query = useMediaSets();
  const remove = useDeleteMediaSet();
  // `Array.isArray` y no `?? []`: la fila es secundaria y no puede tumbar el
  // Media Bank entero si la respuesta llega con otra forma.
  const sets: readonly MediaSet[] = Array.isArray(query.data) ? query.data : [];

  return (
    <section aria-labelledby="media-sets-title" className="mb-4">
      <h3
        id="media-sets-title"
        className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted"
      >
        {tw("mediaBank.sets.title")}
      </h3>
      {/* `div`/`span` y no `ul`/`li`: la grid de assets de abajo es la lista
          de la pantalla, y los sets son una fila de acciones. */}
      <div className="flex flex-wrap gap-2">
        <span>
          <Button variant="secondary" size="sm" disabled={creating} onClick={onNewSet}>
            {tw("mediaBank.sets.new")}
          </Button>
        </span>
        {query.isPending &&
          Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-8 w-32" />)}
        {sets.map((set) => (
          <span
            key={set.id}
            className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs"
          >
            <Badge tone="neutral" size="sm">
              {tw(SET_KIND_COPY[set.kind])}
            </Badge>
            <span className="max-w-[12rem] truncate" title={set.name}>
              {set.name}
            </span>
            <span className="text-text-muted">
              {tw("mediaBank.sets.count", { count: set.mediaIds.length })}
            </span>
            <button
              type="button"
              className="fg-focusable text-text-muted hover:text-danger"
              aria-label={tw("mediaBank.sets.deleteAria", { name: set.name })}
              disabled={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(tw("mediaBank.sets.deleteConfirm", { name: set.name }))
                )
                  remove.mutate(set.id);
              }}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      {query.isError && (
        <p className="mt-2 text-xs text-danger">
          {tw("mediaBank.sets.loadError")}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void query.refetch()}
          >
            {tw("studio.retry")}
          </button>
        </p>
      )}
      {remove.isError && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {tw(presentError(remove.error).titleKey)}
        </p>
      )}
    </section>
  );
}
