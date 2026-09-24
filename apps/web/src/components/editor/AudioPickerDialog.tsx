"use client";

import type { AudioLibrary } from "@fastgram/contracts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
  cn,
} from "@fastgram/ui";
import { tw } from "@/lib/i18n/t";
import { flattenItems, useAudioPicker } from "@/lib/editor/api";

export interface AudioPickerDialogProps {
  readonly open: boolean;
  readonly library: AudioLibrary;
  /** `null` = la pieza va sin audio. */
  readonly currentUrl: string | null;
  readonly onCancel: () => void;
  readonly onPick: (url: string | null) => void;
}

/**
 * `Select Audio` (FR-053): dos columnas, **`No audio` siempre primero**
 * (FR-053.1), la pista vigente resaltada.
 *
 * Elegir aplica y cierra, como en el original (no hay botón `Swap` en el
 * modal de audio: sólo `Cancel`). El preview de la pista no se reproduce acá:
 * el catálogo compartido hoy está vacío y el render rechaza cualquier pista
 * (`audio_fuera_de_libreria`, cabecera de `apps/worker/src/content/
 * media-authorization.ts`). `No audio` es lo único que llega al video.
 */
export function AudioPickerDialog({
  open,
  library,
  currentUrl,
  onCancel,
  onPick,
}: AudioPickerDialogProps) {
  const query = useAudioPicker(library, open);
  const tracks = flattenItems(query.data);

  return (
    <Dialog open={open} onClose={onCancel} size="md">
      <DialogHeader>
        <DialogTitle>{tw("editor.audio.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <ul className="grid max-h-[55vh] grid-cols-2 gap-2 overflow-y-auto">
          <li>
            <AudioOption
              label={tw("editor.assets.noAudio")}
              icon="∅"
              selected={currentUrl === null}
              onSelect={() => onPick(null)}
            />
          </li>
          {query.isPending
            ? Array.from({ length: 5 }, (_, i) => (
                <li key={i}>
                  <Skeleton className="h-12 w-full" />
                </li>
              ))
            : tracks.map((t) => (
                <li key={t.audioId}>
                  <AudioOption
                    label={t.description}
                    icon="♪"
                    selected={currentUrl === t.url}
                    onSelect={() => onPick(t.url)}
                  />
                </li>
              ))}
        </ul>
        {query.isError && (
          <div className="mt-3">
            <EmptyState
              bordered
              title={tw("editor.audio.error")}
              action={
                <Button variant="secondary" onClick={() => void query.refetch()}>
                  {tw("editor.picker.retry")}
                </Button>
              }
            />
          </div>
        )}
        {query.isSuccess && tracks.length === 0 && (
          <p className="mt-3 text-xs text-text-muted">{tw("editor.audio.empty")}</p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          {tw("editor.picker.cancel")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function AudioOption({
  label,
  icon,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly icon: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "fg-focusable flex w-full items-center gap-2 rounded-lg border-2 px-3 py-3 text-left text-sm",
        selected ? "border-accent" : "border-border hover:border-border-strong",
      )}
      onClick={onSelect}
    >
      <span aria-hidden className="text-text-muted">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}
