"use client";

import { BRAND_AUDIO_MAX_MB, type BrandAudioTrack } from "@fastgram/contracts";
import { Button, EmptyState, Input, Skeleton, cn } from "@fastgram/ui";
import { useRef, useState } from "react";
import {
  AUDIO_ACCEPT,
  audioReservationFor,
  formatDuration,
  useBrandAudio,
  useDeleteBrandAudio,
  useUpdateBrandAudio,
  useUploadBrandAudio,
} from "@/lib/audio/api";
import { useAudioPreview } from "@/lib/audio/preview";
import { flattenItems } from "@/lib/editor/api";
import { tw } from "@/lib/i18n/t";

/**
 * La biblioteca de audio de la marca en la Library (sprint 7): ver, buscar,
 * escuchar, subir, renombrar, sacar del sorteo de Blitz y borrar.
 *
 * Es un panel suelto y no una pestaña: `LibraryTabs.tsx` es de otro agente y
 * el coordinador agrega la línea que lo monta. Lo importado por link
 * (`Import from link → Audio`) aparece acá solo, porque el worker crea la fila.
 */
export function BrandAudioPanel() {
  const [q, setQ] = useState("");
  const query = useBrandAudio(q);
  const tracks = flattenItems(query.data);
  const preview = useAudioPreview();
  const upload = useUploadBrandAudio();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

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
      { onError: () => setUploadError(tw("audio.upload.error.failed")) },
    );
  };

  const searching = q.trim() !== "";

  return (
    <section aria-labelledby="brand-audio-title" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="brand-audio-title" className="m-0 text-lg font-semibold">
            {tw("audio.panel.title")}
          </h2>
          <p className="m-0 text-sm text-text-muted">{tw("audio.panel.description")}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <input
            ref={fileRef}
            type="file"
            accept={AUDIO_ACCEPT}
            className="hidden"
            data-testid="brand-audio-file"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button loading={upload.isPending} onClick={() => fileRef.current?.click()}>
            {upload.isPending ? tw("audio.uploading") : tw("audio.upload")}
          </Button>
          <span className="text-xs text-text-muted">
            {tw("audio.upload.formats", { max: BRAND_AUDIO_MAX_MB })}
          </span>
        </div>
      </header>

      {uploadError !== null && (
        <p role="alert" className="m-0 text-sm text-danger">
          {uploadError}
        </p>
      )}

      <Input
        type="search"
        aria-label={tw("audio.picker.search")}
        placeholder={tw("audio.picker.search")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <p className="m-0 text-xs text-text-muted">{tw("audio.panel.autoUseHint")}</p>

      {query.isPending && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i}>
              <Skeleton className="h-14 w-full" />
            </li>
          ))}
        </ul>
      )}

      {query.isError && (
        <EmptyState
          bordered
          title={tw("audio.picker.error")}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {tw("audio.panel.retry")}
            </Button>
          }
        />
      )}

      {query.isSuccess && tracks.length === 0 && (
        <EmptyState
          bordered
          title={
            searching
              ? tw("audio.picker.noMatches", { q: q.trim() })
              : tw("audio.panel.emptyTitle")
          }
          {...(searching ? {} : { description: tw("audio.panel.emptyBody") })}
        />
      )}

      {tracks.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {tracks.map((track) => (
            <li key={track.id}>
              <TrackRow
                track={track}
                playing={preview.playingId === track.id}
                failed={preview.failedId === track.id}
                onTogglePreview={() => preview.toggle(track.id, track.url)}
                onBeforeDelete={() => {
                  if (preview.playingId === track.id) preview.stop();
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {tw("audio.panel.loadMore")}
          </Button>
        </div>
      )}
    </section>
  );
}

function TrackRow({
  track,
  playing,
  failed,
  onTogglePreview,
  onBeforeDelete,
}: {
  readonly track: BrandAudioTrack;
  readonly playing: boolean;
  readonly failed: boolean;
  readonly onTogglePreview: () => void;
  readonly onBeforeDelete: () => void;
}) {
  const update = useUpdateBrandAudio();
  const remove = useDeleteBrandAudio();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(track.title);
  const [actionError, setActionError] = useState(false);
  const duration = formatDuration(track.durationSec);
  const onError = () => setActionError(true);

  const save = () => {
    const title = draft.trim();
    if (title === "" || title === track.title) {
      setRenaming(false);
      setDraft(track.title);
      return;
    }
    setActionError(false);
    update.mutate(
      { id: track.id, title },
      { onSuccess: () => setRenaming(false), onError },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2">
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

      <div className="min-w-0 flex-1">
        {renaming ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <Input
              aria-label={tw("audio.panel.renameLabel")}
              value={draft}
              maxLength={200}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              wrapperClassName="flex-1"
            />
            <Button type="submit" size="sm" loading={update.isPending}>
              {tw("audio.panel.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setRenaming(false);
                setDraft(track.title);
              }}
            >
              {tw("audio.panel.cancel")}
            </Button>
          </form>
        ) : (
          <>
            <p className="m-0 truncate text-sm font-medium">{track.title}</p>
            <p className="m-0 text-xs text-text-muted">
              {[
                tw(
                  track.origin === "import"
                    ? "audio.panel.origin.import"
                    : "audio.panel.origin.upload",
                ),
                duration,
                `${track.sizeMb.toFixed(1)} MB`,
              ]
                .filter((part): part is string => part !== null)
                .join(" · ")}
            </p>
          </>
        )}
        {actionError && (
          <p role="alert" className="m-0 text-xs text-danger">
            {tw("audio.panel.actionFailed")}
          </p>
        )}
      </div>

      {!renaming && (
        <div className="flex shrink-0 items-center gap-2">
          <label
            className={cn(
              "flex items-center gap-1 text-xs",
              update.isPending ? "opacity-60" : "",
            )}
          >
            <input
              type="checkbox"
              checked={track.autoUse}
              disabled={update.isPending}
              onChange={(e) => {
                setActionError(false);
                update.mutate({ id: track.id, autoUse: e.target.checked }, { onError });
              }}
            />
            {tw("audio.panel.autoUse")}
          </label>
          <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
            {tw("audio.panel.rename")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={remove.isPending}
            onClick={() => {
              if (
                !window.confirm(tw("audio.panel.confirmDelete", { title: track.title }))
              ) {
                return;
              }
              setActionError(false);
              onBeforeDelete();
              remove.mutate(track.id, { onError });
            }}
          >
            {tw("audio.panel.delete")}
          </Button>
        </div>
      )}
    </div>
  );
}
