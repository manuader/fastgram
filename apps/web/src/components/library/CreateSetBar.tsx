"use client";

import {
  mediaSetKindSchema,
  type CreateMediaSetRequest,
  type MediaSetKind,
} from "@fastgram/contracts";
import { Button, Input, Select } from "@fastgram/ui";
import { useState } from "react";
import { presentError } from "@/lib/api/error-presentation";
import { tw } from "@/lib/i18n/t";
import { canSaveSet, setProgress, useCreateMediaSet } from "@/lib/media/sets";
import { SET_KIND_COPY } from "./MediaSetsRow";

/**
 * Barra inferior fija del modo `CREATING SET` (PRD:1648-1654, `P2-MEDIA-006`):
 * izquierda, la etiqueta y `<N> selected (need <M> more)`; centro, el nombre
 * (`Set name (e.g. 'Bedroom shots')`); derecha, `✕ Cancel` y `✓ Save`, que
 * queda deshabilitado hasta el mínimo de 5 y un nombre.
 */
export function CreateSetBar({
  selectedIds,
  onCancel,
  onSaved,
}: {
  readonly selectedIds: readonly string[];
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MediaSetKind>("CURATED");
  const create = useCreateMediaSet();
  const progress = setProgress(selectedIds.length);

  return (
    <div
      role="region"
      aria-label={tw("mediaBank.sets.creating")}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface px-4 py-3 shadow-lg"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <span className="text-xs font-semibold uppercase tracking-wide">
            {tw("mediaBank.sets.creating")}
          </span>
          <span className="text-xs text-text-muted" aria-live="polite">
            {progress.enough
              ? tw("mediaBank.sets.selected", { count: progress.selected })
              : tw("mediaBank.sets.selectedNeed", {
                  count: progress.selected,
                  missing: progress.missing,
                })}
          </span>
        </div>
        <Input
          value={name}
          maxLength={80}
          placeholder={tw("mediaBank.sets.namePlaceholder")}
          aria-label={tw("mediaBank.sets.nameLabel")}
          onChange={(e) => setName(e.target.value)}
          wrapperClassName="min-w-[12rem] flex-1"
        />
        <Select
          value={kind}
          aria-label={tw("mediaBank.sets.kindLabel")}
          onChange={(e) => {
            const next = mediaSetKindSchema.safeParse(e.target.value);
            if (next.success) setKind(next.data);
          }}
          options={mediaSetKindSchema.options.map((k) => ({
            value: k,
            label: tw(SET_KIND_COPY[k]),
          }))}
        />
        <Button variant="ghost" onClick={onCancel} disabled={create.isPending}>
          {tw("mediaBank.sets.cancel")}
        </Button>
        <Button
          disabled={!canSaveSet(name, selectedIds.length)}
          loading={create.isPending}
          onClick={() => {
            create.mutate(
              {
                name: name.trim(),
                kind,
                // Los ids vienen de `GET /media`: la marca de tipo es sólo de
                // compilación (`ids.ts`), la API los valida igual.
                mediaIds: [...selectedIds] as CreateMediaSetRequest["mediaIds"],
              },
              { onSuccess: onSaved },
            );
          }}
        >
          {tw("mediaBank.sets.save")}
        </Button>
        {create.isError && (
          <p role="alert" className="w-full text-xs text-danger">
            {tw(presentError(create.error).titleKey)}
          </p>
        )}
      </div>
    </div>
  );
}
