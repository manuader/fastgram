"use client";

import type { AudioExtraction, Media } from "@fastgram/contracts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
  Spinner,
  cn,
} from "@fastgram/ui";
import { useState } from "react";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { flattenMediaPages, formatDuration, useMediaList } from "@/lib/media/media";
import {
  AUDIO_EXTRACT_MAX_MINUTES,
  isExtractionSettled,
  useAudioExtraction,
  useStartAudioExtraction,
  withinExtractLimit,
} from "./extract-api";

const ERROR_COPY: Readonly<Record<NonNullable<AudioExtraction["error"]>, CopyKey>> = {
  media_not_found: "audio.extract.error.media_not_found",
  no_audio: "audio.extract.error.no_audio",
  too_long: "audio.extract.error.too_long",
  too_large: "audio.extract.error.too_large",
  extract_failed: "audio.extract.error.extract_failed",
};

/**
 * "Extract from a video" de Library → Audio (sprint 7, segunda tanda, H).
 *
 * Elige un video del Media Bank; el worker saca su audio con FFmpeg y lo suma
 * a la biblioteca (`origin: "extracted"`). Tope: {@link AUDIO_EXTRACT_MAX_MINUTES}
 * minutos; un video más largo se muestra deshabilitado y el servidor lo
 * rechaza igual.
 */
export function ExtractFromVideoButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {tw("audio.extract.open")}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="sm">
        {open && <ExtractBody onClose={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function ExtractBody({ onClose }: { readonly onClose: () => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Media | null>(null);
  const [extractionId, setExtractionId] = useState<string | null>(null);
  const videos = useMediaList({ type: "video", q });
  const start = useStartAudioExtraction();
  const status = useAudioExtraction(extractionId);
  const items = flattenMediaPages(videos.data);
  const minutes = AUDIO_EXTRACT_MAX_MINUTES;

  if (extractionId !== null) {
    const data = status.data;
    const failed = data?.state === "failed" || status.isError;
    return (
      <>
        <DialogHeader>
          <DialogTitle>{tw("audio.extract.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {failed ? (
            <p role="alert" className="m-0 text-sm text-danger">
              {tw(
                data?.error === undefined
                  ? "audio.extract.error.extract_failed"
                  : ERROR_COPY[data.error],
                { minutes },
              )}
            </p>
          ) : data === undefined || !isExtractionSettled(data) ? (
            <p className="m-0 flex items-center gap-2 text-sm" aria-live="polite">
              <Spinner size="sm" /> {tw("audio.extract.running")}
            </p>
          ) : (
            <p className="m-0 text-sm" aria-live="polite">
              {tw("audio.extract.done")}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{tw("audio.extract.close")}</Button>
        </DialogFooter>
      </>
    );
  }

  const searching = q.trim() !== "";

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tw("audio.extract.title")}</DialogTitle>
        <DialogDescription>
          {tw("audio.extract.description", { minutes })}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-3 text-sm">
          <Input
            type="search"
            aria-label={tw("audio.extract.search")}
            placeholder={tw("audio.extract.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />

          {videos.isPending && (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-busy="true">
              {Array.from({ length: 3 }, (_, i) => (
                <li key={i}>
                  <Skeleton className="h-10 w-full" />
                </li>
              ))}
            </ul>
          )}

          {videos.isError && (
            <EmptyState
              bordered
              title={tw("audio.extract.loadError")}
              action={
                <Button variant="secondary" onClick={() => void videos.refetch()}>
                  {tw("audio.extract.retry")}
                </Button>
              }
            />
          )}

          {videos.isSuccess && items.length === 0 && (
            <EmptyState
              bordered
              title={
                searching
                  ? tw("audio.extract.noMatches", { q: q.trim() })
                  : tw("audio.extract.empty")
              }
            />
          )}

          {items.length > 0 && (
            <ul
              className="m-0 flex max-h-72 list-none flex-col gap-1 overflow-y-auto p-0"
              aria-label={tw("audio.extract.search")}
            >
              {items.map((video) => {
                const fits = withinExtractLimit(video.videoDurationSec);
                const selected = picked?.mediaId === video.mediaId;
                return (
                  <li key={video.mediaId}>
                    <button
                      type="button"
                      disabled={!fits}
                      aria-pressed={selected}
                      onClick={() => setPicked(video)}
                      className={cn(
                        "fg-focusable flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left",
                        selected ? "border-accent" : "border-border",
                        fits ? "" : "cursor-not-allowed opacity-60",
                      )}
                    >
                      <span className="min-w-0 truncate">{video.filename}</span>
                      <span className="shrink-0 text-xs text-text-muted">
                        {fits
                          ? video.videoDurationSec === undefined
                            ? ""
                            : formatDuration(video.videoDurationSec)
                          : tw("audio.extract.tooLong", { minutes })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {videos.hasNextPage && (
            <Button
              variant="ghost"
              size="sm"
              loading={videos.isFetchingNextPage}
              onClick={() => void videos.fetchNextPage()}
            >
              {tw("audio.panel.loadMore")}
            </Button>
          )}

          {start.isError && (
            <p role="alert" className="m-0 text-danger">
              {tw("audio.extract.error.start")}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {tw("audio.panel.cancel")}
        </Button>
        <Button
          disabled={picked === null}
          loading={start.isPending}
          onClick={() => {
            if (picked === null) return;
            start.mutate(
              { mediaId: picked.mediaId },
              { onSuccess: (created) => setExtractionId(created.id) },
            );
          }}
        >
          {tw("audio.extract.start")}
        </Button>
      </DialogFooter>
    </>
  );
}
