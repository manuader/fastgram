"use client";

import {
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fastgram/ui";
import type { Media, MediaCategory } from "@fastgram/contracts";
import { useState } from "react";
import { CategoryChips } from "./CategoryChips";
import { presentError } from "@/lib/api/error-presentation";
import { tw } from "@/lib/i18n/t";
import { toggleCategory } from "@/lib/media/categories";
import { useDeleteMedia, useUpdateMediaCategories } from "@/lib/media/mutations";

function errorText(error: unknown): string {
  const presentation = presentError(error);
  return tw(presentation.titleKey, presentation.titleVars);
}

export interface EditCategoriesDialogProps {
  /** `null` = cerrado. */
  readonly item: Media | null;
  readonly onClose: () => void;
}

/**
 * Editar las categorías de un asset existente · `PATCH /media/:id`.
 *
 * Reemplazo total (PRD:1634): lo que se guarda es exactamente lo que queda
 * marcado, y quitar todas es válido — el asset sale de los pools de Blitz, y
 * se dice en pantalla para que no sea una sorpresa.
 */
export function EditCategoriesDialog({ item, onClose }: EditCategoriesDialogProps) {
  return (
    <Dialog open={item !== null} onClose={onClose} size="sm">
      {item !== null && (
        <EditCategoriesBody key={item.mediaId} item={item} onClose={onClose} />
      )}
    </Dialog>
  );
}

function EditCategoriesBody({
  item,
  onClose,
}: {
  readonly item: Media;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState<readonly MediaCategory[]>(item.categories);
  const mutation = useUpdateMediaCategories();

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tw("mediaUpload.edit.title")}</DialogTitle>
        <DialogDescription>
          {tw("mediaUpload.edit.description", { name: item.filename })}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-3">
          <CategoryChips
            mediaType={item.mediaType}
            value={draft}
            disabled={mutation.isPending}
            label={tw("mediaUpload.categories.groupLabel", { name: item.filename })}
            onToggle={(category) => {
              setDraft((current) => toggleCategory(item.mediaType, current, category));
            }}
          />
          {draft.length === 0 && (
            <p className="text-xs text-text-muted">
              {tw("mediaUpload.categories.noneHint")}
            </p>
          )}
          {mutation.isError && (
            <p role="alert" className="text-sm text-danger">
              {errorText(mutation.error)}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
          {tw("common.cancel")}
        </Button>
        <Button
          loading={mutation.isPending}
          onClick={() => {
            mutation.mutate(
              { mediaId: item.mediaId, categories: draft },
              { onSuccess: onClose },
            );
          }}
        >
          {tw("mediaUpload.edit.save")}
        </Button>
      </DialogFooter>
    </>
  );
}

export interface DeleteMediaDialogProps {
  readonly item: Media | null;
  readonly onClose: () => void;
}

/**
 * Borrar un asset · `DELETE /media/:id`.
 *
 * FR-100 lo rechaza con `409 media_in_use` si el asset sigue referenciado, y el
 * copy de §19.10 (`error.mediaInUse.title`) dice qué hacer. Hoy la API no lo
 * devuelve nunca (ver `lib/media/mutations.ts`); la pantalla ya lo trata.
 */
export function DeleteMediaDialog({ item, onClose }: DeleteMediaDialogProps) {
  return (
    <Dialog open={item !== null} onClose={onClose} size="sm">
      {item !== null && (
        <DeleteMediaBody key={item.mediaId} item={item} onClose={onClose} />
      )}
    </Dialog>
  );
}

function DeleteMediaBody({
  item,
  onClose,
}: {
  readonly item: Media;
  readonly onClose: () => void;
}) {
  const mutation = useDeleteMedia();

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {tw("mediaUpload.delete.title", { name: item.filename })}
        </DialogTitle>
        <DialogDescription>{tw("mediaUpload.delete.body")}</DialogDescription>
      </DialogHeader>
      {mutation.isError && (
        <DialogBody>
          <p role="alert" className="text-sm text-danger">
            {errorText(mutation.error)}
          </p>
        </DialogBody>
      )}
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
          {tw("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={mutation.isPending}
          onClick={() => {
            mutation.mutate(item.mediaId, { onSuccess: onClose });
          }}
        >
          {tw("mediaUpload.delete.confirm")}
        </Button>
      </DialogFooter>
    </>
  );
}
