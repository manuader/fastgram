"use client";

import { Button, cn } from "@fastgram/ui";
import type { MediaStatus } from "@fastgram/contracts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CategoryChips } from "./CategoryChips";
import { presentError } from "@/lib/api/error-presentation";
import { tw } from "@/lib/i18n/t";
import { sizeInMb } from "@/lib/media/upload/policy";
import {
  applyToAllTargets,
  isBusyItem,
  isSettled,
  MEDIA_MAX_MB,
  type MediaUploadQueue,
  type UploadItem,
} from "@/lib/media/upload/queue";

export interface UploadQueueProps {
  readonly queue: MediaUploadQueue;
  /**
   * El estado **vivo** de cada asset subido, leído del listado (que hace
   * polling mientras haya videos en `processing`). La fila de la cola nace con
   * el `status` de la finalización y no se entera sola de la normalización.
   */
  readonly liveStatus: ReadonlyMap<string, MediaStatus>;
}

/**
 * La cola de subida: una fila por archivo, con su progreso, su fallo y —al
 * terminar— el selector de categorías.
 */
export function UploadQueue({ queue, liveStatus }: UploadQueueProps) {
  const reduceMotion = useReducedMotion() === true;
  const { items } = queue;
  if (items.length === 0) return null;

  const uploaded = items.filter((item) => item.phase === "done").length;
  const countable = items.filter(
    (item) => item.phase !== "rejected" && item.phase !== "cancelled",
  ).length;
  const canClear = items.some(isSettled);

  return (
    <section
      aria-labelledby="fgw-upload-queue-title"
      className="rounded-xl border border-border bg-surface p-4 shadow-xs"
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 id="fgw-upload-queue-title" className="text-sm font-semibold text-text">
            {tw("mediaUpload.queue.title")}
          </h2>
          <span className="text-xs text-text-muted" aria-live="polite">
            {tw("mediaUpload.queue.progress", { done: uploaded, total: countable })}
          </span>
        </div>
        {canClear && (
          <Button variant="ghost" size="sm" onClick={queue.clearSettled}>
            {tw("mediaUpload.queue.clear")}
          </Button>
        )}
      </header>

      <ul className="flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.li
              key={item.id}
              layout={!reduceMotion}
              initial={reduceMotion ? false : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              className="fgw-upload-row rounded-lg border border-border bg-surface-raised p-3"
              data-phase={item.phase}
            >
              <UploadRow
                item={item}
                queue={queue}
                liveStatus={
                  item.media === null ? undefined : liveStatus.get(item.media.mediaId)
                }
              />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

interface UploadRowProps {
  readonly item: UploadItem;
  readonly queue: MediaUploadQueue;
  readonly liveStatus: MediaStatus | undefined;
}

function UploadRow({ item, queue, liveStatus }: UploadRowProps) {
  const busy = isBusyItem(item);
  const canCancel =
    item.phase === "queued" || item.phase === "reserving" || item.phase === "uploading";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <KindIcon kind={item.mediaType} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text" title={item.name}>
            {item.name}
          </p>
          <p className="text-xs text-text-muted">
            <StatusLine item={item} liveStatus={liveStatus} />
          </p>
        </div>

        {item.phase === "failed" && item.resume !== "none" && (
          <Button
            variant="secondary"
            size="sm"
            aria-label={tw("mediaUpload.retryAria", { name: item.name })}
            onClick={() => {
              queue.retry(item.id);
            }}
          >
            {tw("mediaUpload.retry")}
          </Button>
        )}
        {canCancel && (
          <IconButton
            label={tw("mediaUpload.cancelAria", { name: item.name })}
            onClick={() => {
              queue.cancel(item.id);
            }}
          />
        )}
        {!busy && item.categoriesState !== "saving" && (
          <IconButton
            label={tw("mediaUpload.dismissAria", { name: item.name })}
            onClick={() => {
              queue.dismiss(item.id);
            }}
          />
        )}
      </div>

      {(item.phase === "uploading" || item.phase === "finalizing") && (
        <ProgressBar item={item} />
      )}

      {item.phase === "done" && item.media !== null && (
        <CategoryStep item={item} queue={queue} />
      )}
    </div>
  );
}

function StatusLine({
  item,
  liveStatus,
}: {
  readonly item: UploadItem;
  readonly liveStatus: MediaStatus | undefined;
}) {
  const size = sizeInMb(item.sizeBytes);
  switch (item.phase) {
    case "queued":
      return <>{`${size} MB · ${tw("mediaUpload.phase.queued")}`}</>;
    case "reserving":
      return <>{`${size} MB · ${tw("mediaUpload.phase.reserving")}`}</>;
    case "uploading":
      return (
        <>
          {`${size} MB · `}
          {item.percent === null
            ? tw("mediaUpload.phase.uploadingUnknown")
            : tw("mediaUpload.phase.uploading", { percent: item.percent })}
        </>
      );
    case "finalizing":
      return <>{`${size} MB · ${tw("mediaUpload.phase.finalizing")}`}</>;
    case "cancelled":
      return <>{tw("mediaUpload.phase.cancelled")}</>;
    case "rejected":
      return <span className="text-danger">{rejectionCopy(item)}</span>;
    case "failed":
      return <span className="text-danger">{failureCopy(item)}</span>;
    case "done": {
      const status = liveStatus ?? item.media?.status;
      if (status === "processing") return <>{tw("mediaUpload.phase.processing")}</>;
      if (status === "failed") {
        return (
          <span className="text-danger">{tw("mediaUpload.phase.processingFailed")}</span>
        );
      }
      return <>{`${size} MB · ${tw("mediaUpload.phase.done")}`}</>;
    }
  }
}

function rejectionCopy(item: UploadItem): string {
  switch (item.rejection) {
    case "empty":
      return tw("mediaUpload.rejected.empty");
    case "too_large":
      return item.mediaType === null
        ? tw("mediaUpload.rejected.unsupported")
        : tw("mediaUpload.rejected.tooLarge", {
            size: sizeInMb(item.sizeBytes),
            kind: tw(
              item.mediaType === "image"
                ? "mediaUpload.kind.image"
                : "mediaUpload.kind.video",
            ),
            max: MEDIA_MAX_MB[item.mediaType],
          });
    case "extension_mismatch":
      return tw("mediaUpload.rejected.extensionMismatch");
    case "unsupported_type":
    case null:
      return tw("mediaUpload.rejected.unsupported");
  }
}

function failureCopy(item: UploadItem): string {
  // Sin `error`: falló el PUT y respondió el storage. Copy propia en vez de
  // traducir un código que no es del contrato (ver `transport.ts`).
  if (item.error === null) return tw("mediaUpload.failed.transfer");
  const presentation = presentError(item.error);
  const title = tw(presentation.titleKey, presentation.titleVars);
  return item.step === "finalize" && item.resume === "finalize"
    ? `${tw("mediaUpload.failed.finalize")} ${title}`
    : title;
}

function ProgressBar({ item }: { readonly item: UploadItem }) {
  const finalizing = item.phase === "finalizing";
  const percent = finalizing ? 100 : item.percent;
  return (
    <div
      role="progressbar"
      aria-label={tw("mediaUpload.progressLabel", { name: item.name })}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent === null ? {} : { "aria-valuenow": percent })}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
    >
      <div
        className={cn(
          "h-full rounded-full bg-accent transition-[width] duration-200 ease-out",
          (percent === null || finalizing) && "animate-pulse",
        )}
        style={{ width: `${String(percent ?? 100)}%` }}
      />
    </div>
  );
}

function CategoryStep({
  item,
  queue,
}: {
  readonly item: UploadItem;
  readonly queue: MediaUploadQueue;
}) {
  const media = item.media;
  if (media === null) return null;

  if (item.categoriesState === "saved") {
    return (
      <p className="text-xs text-success">
        {tw("mediaUpload.categories.saved")}
        {item.categories.length === 0
          ? ` — ${tw("mediaUpload.categories.noneHint")}`
          : ""}
      </p>
    );
  }
  if (item.categoriesState === "skipped") {
    return (
      <p className="text-xs text-text-muted">{tw("mediaUpload.categories.skipped")}</p>
    );
  }

  const saving = item.categoriesState === "saving";
  const batch = applyToAllTargets(queue.items, item);

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-text-muted">
          {tw("mediaUpload.categories.label")}
        </span>
        <CategoryChips
          mediaType={media.mediaType}
          value={item.categories}
          disabled={saving}
          label={tw("mediaUpload.categories.groupLabel", { name: item.name })}
          onToggle={(category) => {
            queue.toggleCategory(item.id, category);
          }}
        />
      </div>
      {item.categories.length === 0 && (
        <p className="text-xs text-text-muted">{tw("mediaUpload.categories.noneHint")}</p>
      )}
      {item.categoriesState === "failed" && (
        <p role="alert" className="text-xs text-danger">
          {tw("mediaUpload.categories.saveFailed")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          loading={saving}
          onClick={() => {
            queue.confirmCategories(item.id);
          }}
        >
          {tw("mediaUpload.categories.save")}
        </Button>
        {batch.length > 1 && (
          <Button
            size="sm"
            variant="secondary"
            disabled={saving}
            onClick={() => {
              queue.applyToAll(item.id);
            }}
          >
            {tw(
              media.mediaType === "image"
                ? "mediaUpload.categories.applyToAll.image"
                : "mediaUpload.categories.applyToAll.video",
              { count: batch.length },
            )}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => {
            queue.skipCategories(item.id);
          }}
        >
          {tw("mediaUpload.categories.skip")}
        </Button>
      </div>
    </div>
  );
}

function KindIcon({ kind }: { readonly kind: UploadItem["mediaType"] }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-text-muted"
    >
      <svg
        viewBox="0 0 20 20"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        {kind === "video" ? (
          <>
            <rect x="2.5" y="4.5" width="11" height="11" rx="2" />
            <path d="M13.5 8.5l4-2.5v8l-4-2.5" strokeLinejoin="round" />
          </>
        ) : (
          <>
            <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
            <circle cx="7" cy="8" r="1.5" />
            <path d="M3 14l4.5-4 3.5 3 2.5-2 3.5 3" strokeLinejoin="round" />
          </>
        )}
      </svg>
    </span>
  );
}

function IconButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
        <path
          d="M4 4l8 8M12 4l-8 8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </Button>
  );
}
