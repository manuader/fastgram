"use client";

import type { BrandAudioTrack, ContentType } from "@fastgram/contracts";
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
import { useRef, useState } from "react";
import { tw } from "@/lib/i18n/t";
import { flattenItems } from "@/lib/editor/api";
import {
  AUDIO_ACCEPT,
  audioReservationFor,
  formatDuration,
  useBrandAudio,
  useUploadBrandAudio,
} from "@/lib/audio/api";
import { BRAND_AUDIO_MAX_MB } from "@fastgram/contracts";
import { useAudioPreview } from "@/lib/audio/preview";

export interface AudioPickerDialogProps {
  readonly open: boolean;
  /** El formato de la pieza: decide la nota de cómo suena (mezcla o no). */
  readonly format: ContentType;
  /** `null` = la pieza va sin audio. */
  readonly currentUrl: string | null;
  readonly onCancel: () => void;
  readonly onPick: (url: string | null) => void;
}

/**
 * `Select Audio` (FR-053): **`No audio` siempre primero** (FR-053.1), después
 * la biblioteca de audio **de la marca** (sprint 7) con búsqueda y preview.
 *
 * Elegir aplica y cierra, como en el original (sólo `Cancel`, sin `Swap`). El
 * catálogo global del PRD (`GET /audio?for=`) no se lista: está vacío y el
 * render sólo autoriza la biblioteca de la marca. Subir desde acá sube a esa
 * misma biblioteca y elige la pista nueva.
 */
export function AudioPickerDialog({
  open,
  format,
  currentUrl,
  onCancel,
  onPick,
}: AudioPickerDialogProps) {
  const [q, setQ] = useState("");
  const query = useBrandAudio(q, open);
  const tracks = flattenItems(query.data);
  const preview = useAudioPreview();
  const upload = useUploadBrandAudio();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const close = () => {
    preview.stop();
    onCancel();
  };
  const pick = (url: string | null) => {
    preview.stop();
    onPick(url);
  };

  const onFile = (file: File | undefined) => {
    if (file === undefined) return;
    const check = audioReservationFor(file);
    if (!check.ok) {
      setUploadError(
        tw(`audio.upload.error.${check.reason}`, { max: BRAND_AUDIO_MAX_MB }),
      );
      return;
    }
    setUploadError(null);
    upload.mutate(
      { file },
      {
        onSuccess: (track) => pick(track.url),
        onError: () => setUploadError(tw("audio.upload.error.failed")),
      },
    );
  };

  const searching = q.trim() !== "";

  return (
    <Dialog open={open} onClose={close} size="md">
      <DialogHeader>
        <DialogTitle>{tw("editor.audio.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <div className="mb-3 flex items-center gap-2">
          <Input
            type="search"
            aria-label={tw("audio.picker.search")}
            placeholder={tw("audio.picker.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            wrapperClassName="flex-1"
          />
          <input
            ref={fileRef}
            type="file"
            accept={AUDIO_ACCEPT}
            className="hidden"
            data-testid="audio-picker-file"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button
            variant="secondary"
            loading={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            {upload.isPending ? tw("audio.uploading") : tw("audio.upload")}
          </Button>
        </div>
        {uploadError !== null && (
          <p role="alert" className="mb-2 text-xs text-danger">
            {uploadError}
          </p>
        )}
        <ul className="grid max-h-[50vh] grid-cols-2 gap-2 overflow-y-auto">
          <li>
            <AudioOption
              label={tw("editor.assets.noAudio")}
              icon="∅"
              selected={currentUrl === null}
              onSelect={() => pick(null)}
            />
          </li>
          {query.isPending
            ? Array.from({ length: 5 }, (_, i) => (
                <li key={i}>
                  <Skeleton className="h-12 w-full" />
                </li>
              ))
            : tracks.map((t) => (
                <li key={t.id}>
                  <TrackOption
                    track={t}
                    selected={currentUrl === t.url}
                    playing={preview.playingId === t.id}
                    failed={preview.failedId === t.id}
                    onSelect={() => pick(t.url)}
                    onTogglePreview={() => preview.toggle(t.id, t.url)}
                  />
                </li>
              ))}
        </ul>
        {query.hasNextPage && (
          <div className="mt-2 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {tw("audio.panel.loadMore")}
            </Button>
          </div>
        )}
        {query.isError && (
          <div className="mt-3">
            <EmptyState
              bordered
              title={tw("audio.picker.error")}
              action={
                <Button variant="secondary" onClick={() => void query.refetch()}>
                  {tw("editor.picker.retry")}
                </Button>
              }
            />
          </div>
        )}
        {query.isSuccess && tracks.length === 0 && (
          <p className="mt-3 text-xs text-text-muted">
            {searching
              ? tw("audio.picker.noMatches", { q: q.trim() })
              : tw("audio.picker.empty")}
          </p>
        )}
        <p className="mt-3 text-xs text-text-muted">
          {format === "green-screen"
            ? tw("audio.picker.hintGreenScreen")
            : tw("audio.picker.hint")}
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={close}>
          {tw("editor.picker.cancel")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function TrackOption({
  track,
  selected,
  playing,
  failed,
  onSelect,
  onTogglePreview,
}: {
  readonly track: BrandAudioTrack;
  readonly selected: boolean;
  readonly playing: boolean;
  readonly failed: boolean;
  readonly onSelect: () => void;
  readonly onTogglePreview: () => void;
}) {
  const duration = formatDuration(track.durationSec);
  return (
    <div
      className={cn(
        "flex w-full items-center gap-1 rounded-lg border-2 pr-1",
        selected ? "border-accent" : "border-border hover:border-border-strong",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        className="fg-focusable flex min-w-0 flex-1 items-center gap-2 px-3 py-3 text-left text-sm"
        onClick={onSelect}
      >
        <span aria-hidden className="text-text-muted">
          ♪
        </span>
        <span className="min-w-0 flex-1 truncate">{track.title}</span>
        {duration !== null && (
          <span className="shrink-0 text-xs text-text-muted">{duration}</span>
        )}
      </button>
      <button
        type="button"
        className="fg-focusable shrink-0 rounded-md px-2 py-1 text-sm text-text-muted hover:text-text"
        aria-label={tw(playing ? "audio.preview.pause" : "audio.preview.play", {
          title: track.title,
        })}
        title={failed ? tw("audio.preview.failed") : undefined}
        onClick={onTogglePreview}
      >
        <span aria-hidden>{failed ? "!" : playing ? "❚❚" : "▶"}</span>
      </button>
    </div>
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
