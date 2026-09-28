"use client";

/**
 * Editor por capas del reel (`PU-S9-010`).
 *
 *  · izquierda: capas con su tiempo (timeline con barras arrastrables);
 *  · centro: la preview = la composición HTML del motor en un iframe;
 *  · derecha: el inspector de la capa elegida y Guardar.
 *
 * Guardar manda el spec entero con `PUT /content/:id/reel` y la `revision` que
 * el usuario está viendo (concurrencia optimista de `FR-051`); la pieza pasa a
 * `BUILDING` y el polling de `useContentItem` la sigue hasta `CREATED`.
 */
import type { ReelLayer, ReelSpec } from "@fastgram/contracts";
import { Button, EmptyState, Skeleton, SkeletonText, cn } from "@fastgram/ui";
import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import type { LibraryContent } from "@/lib/library/content";
import { AudioPickerDialog } from "../AudioPickerDialog";
import { MediaPickerDialog } from "../MediaPickerDialog";
import { useEditableReel, useReelPreview, useSaveReel } from "./api";
import { LayerInspector } from "./LayerInspector";
import { ReelPreview, type PreviewCue } from "./ReelPreview";
import { KIND_COPY, ReelTimeline } from "./ReelTimeline";
import { initialReelState, isDirty, reelEditorReducer } from "./state";

/** Espera después del último cambio antes de pedir otra preview. */
export const PREVIEW_DEBOUNCE_MS = 700;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface ReelEditorProps {
  readonly content: LibraryContent;
  readonly back: ReactNode;
  readonly className?: string;
}

export function ReelEditor({ content, back, className }: ReelEditorProps) {
  const editable = useEditableReel(content._id);

  if (editable.isPending) {
    return (
      <div className={cn("grid gap-4", className)} aria-busy="true">
        {back}
        <div className="grid gap-4 lg:grid-cols-[280px_1fr_300px]">
          <SkeletonText lines={6} />
          <Skeleton className="mx-auto aspect-[9/16] w-[360px] max-w-full" />
          <SkeletonText lines={8} />
        </div>
      </div>
    );
  }
  if (editable.isError) {
    return (
      <div className={cn("grid gap-4", className)}>
        {back}
        <EmptyState
          bordered
          title={
            isApiRequestError(editable.error) && editable.error.status === 422
              ? tw("editor.reel.notReel")
              : tw("editor.reel.previewError")
          }
        />
      </div>
    );
  }
  return (
    <LoadedReelEditor
      key={editable.data.revision}
      content={content}
      revision={editable.data.revision}
      spec={editable.data.reel}
      back={back}
      onReload={() => void editable.refetch()}
      {...(className === undefined ? {} : { className })}
    />
  );
}

type Picker =
  | {
      readonly kind: "media";
      readonly layerId: string;
      readonly type: "image" | "video";
      readonly current: string;
    }
  | { readonly kind: "audio"; readonly layerId: string; readonly current: string }
  | null;

function LoadedReelEditor({
  content,
  revision,
  spec: loaded,
  back,
  onReload,
  className,
}: {
  readonly content: LibraryContent;
  readonly revision: number;
  readonly spec: ReelSpec;
  readonly back: ReactNode;
  readonly onReload: () => void;
  readonly className?: string;
}) {
  const [state, dispatch] = useReducer(reelEditorReducer, loaded, initialReelState);
  const [cue, setCue] = useState<PreviewCue | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [pending, setPending] = useState<number | null>(null);
  const save = useSaveReel(content._id);

  const previewSpec = useDebounced(state.spec, PREVIEW_DEBOUNCE_MS);
  const preview = useReelPreview(previewSpec);
  const previewError =
    preview.error === null
      ? null
      : isApiRequestError(preview.error) && preview.error.status === 503
        ? "unavailable"
        : "failed";

  const selected = useMemo(
    () => state.spec.layers.find((l) => l.id === state.selectedId) ?? null,
    [state.spec, state.selectedId],
  );
  const building = content.status === "BUILDING";
  const dirty = isDirty(state);

  // Terminó el rebuild que pedimos: se recarga el spec guardado (nueva revisión).
  useEffect(() => {
    if (
      pending !== null &&
      content.status !== "BUILDING" &&
      content.revision >= pending
    ) {
      setPending(null);
      onReload();
    }
  }, [pending, content.status, content.revision, onReload]);

  function select(layer: ReelLayer): void {
    dispatch({ type: "select", id: layer.id });
    if (layer.kind !== "audio")
      setCue({ time: layer.start, play: false, nonce: Date.now() });
  }

  function swap(layer: ReelLayer): void {
    if (layer.kind === "audio") {
      setPicker({ kind: "audio", layerId: layer.id, current: layer.url });
    } else if (layer.kind === "clip") {
      setPicker({ kind: "media", layerId: layer.id, type: "video", current: layer.url });
    } else if (layer.kind === "image") {
      setPicker({ kind: "media", layerId: layer.id, type: "image", current: layer.url });
    } else if (
      layer.kind === "background" &&
      (layer.fill.type === "image" || layer.fill.type === "video")
    ) {
      setPicker({
        kind: "media",
        layerId: layer.id,
        type: layer.fill.type,
        current: layer.fill.url,
      });
    }
  }

  function picked(url: string): void {
    if (picker === null) return;
    const id = picker.layerId;
    dispatch({
      type: "update",
      id,
      patch: (l) => {
        if (l.kind === "clip" || l.kind === "image" || l.kind === "audio")
          return { ...l, url };
        if (
          l.kind === "background" &&
          (l.fill.type === "image" || l.fill.type === "video")
        ) {
          return { ...l, fill: { ...l.fill, url } };
        }
        return l;
      },
    });
    setPicker(null);
  }

  function onSave(): void {
    save.mutate(
      { revision, reel: state.spec },
      {
        onSuccess: (updated) => {
          dispatch({ type: "commit" });
          setPending(updated.revision);
        },
      },
    );
  }

  const stale =
    save.error !== null &&
    isApiRequestError(save.error) &&
    save.error.code === "stale_revision";

  return (
    <div className={cn("grid gap-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <h1 className="text-lg font-semibold text-text">{tw("editor.reel.title")}</h1>
      </div>

      {(building || pending !== null) && (
        <p
          role="status"
          className="rounded-lg bg-accent-subtle px-3 py-2 text-sm text-text"
        >
          {tw(pending !== null ? "editor.reel.rebuilding" : "editor.reel.building")}
        </p>
      )}
      {save.isError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-lg border border-danger px-3 py-2 text-sm text-danger"
        >
          <span>{stale ? tw("editor.stale") : save.error.message}</span>
          {stale && (
            <Button size="sm" variant="secondary" onClick={onReload}>
              {tw("editor.reload")}
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
        <ReelTimeline
          spec={state.spec}
          selectedId={state.selectedId}
          dispatch={dispatch}
          onSelect={select}
        />

        <div className="grid content-start gap-4">
          <ReelPreview
            html={preview.data?.html ?? null}
            loading={preview.isFetching}
            error={previewError}
            durationSec={state.spec.durationSec}
            cue={cue}
            onRetry={() => void preview.refetch()}
          />
          {content.files[0] !== undefined && (
            <details className="mx-auto w-full max-w-[360px] text-sm text-text-muted">
              <summary className="cursor-pointer">{tw("editor.reel.rendered")}</summary>
              <video
                src={content.files[0]}
                controls
                playsInline
                className="mt-2 w-full rounded-lg"
                {...(content.thumbnailUrl === undefined
                  ? {}
                  : { poster: content.thumbnailUrl })}
              />
            </details>
          )}
        </div>

        <aside className="grid content-start gap-4">
          <LayerInspector
            spec={state.spec}
            layer={selected}
            disabled={building || save.isPending}
            onTiming={(start, end) =>
              selected !== null &&
              dispatch({ type: "timing", id: selected.id, start, end })
            }
            onChange={(patch) =>
              selected !== null && dispatch({ type: "update", id: selected.id, patch })
            }
            onSwap={swap}
            onPreviewAnimation={(layer) =>
              setCue({
                time: Math.max(0, layer.start - 0.1),
                play: true,
                nonce: Date.now(),
              })
            }
          />
          <div className="grid gap-2 border-t border-border pt-4">
            {dirty && (
              <p className="text-xs text-text-muted">{tw("editor.reel.dirty")}</p>
            )}
            <Button
              variant="primary"
              onClick={onSave}
              loading={save.isPending}
              disabled={!dirty || building || save.isPending}
            >
              {tw("editor.reel.save")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => dispatch({ type: "discard" })}
              disabled={!dirty || save.isPending}
            >
              {tw("editor.reel.discard")}
            </Button>
          </div>
        </aside>
      </div>

      {picker?.kind === "media" && (
        <MediaPickerDialog
          open
          type={picker.type}
          title={tw("editor.reel.swap", {
            kind: tw(
              KIND_COPY[
                state.spec.layers.find((l) => l.id === picker.layerId)?.kind ?? "clip"
              ],
            ),
          })}
          currentUrl={picker.current}
          onCancel={() => setPicker(null)}
          onPick={picked}
        />
      )}
      {picker?.kind === "audio" && (
        <AudioPickerDialog
          open
          format="reel"
          currentUrl={picker.current}
          onCancel={() => setPicker(null)}
          onPick={(url) => (url === null ? setPicker(null) : picked(url))}
        />
      )}
    </div>
  );
}
