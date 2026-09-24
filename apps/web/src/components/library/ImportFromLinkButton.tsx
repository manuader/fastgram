"use client";

import {
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
} from "@fastgram/ui";
import {
  videoMediaCategorySchema,
  type MediaCategory,
  type MediaImport,
  type VideoMediaCategory,
} from "@fastgram/contracts";
import { useId, useState } from "react";
import { CategoryChips } from "./CategoryChips";
import { presentError } from "@/lib/api/error-presentation";
import { tw } from "@/lib/i18n/t";
import { toggleCategory } from "@/lib/media/categories";
import {
  IMPORT_BACKGROUND_COPY,
  IMPORT_TAGGING_COPY,
  importStateCopy,
  isImportSettled,
  useMediaImportStatus,
  useStartMediaImport,
} from "@/lib/media/import";

type Kind = "video" | "audio";

const VIDEO_CATEGORIES: readonly string[] = videoMediaCategorySchema.options;
const isVideoCategory = (c: MediaCategory): c is VideoMediaCategory =>
  VIDEO_CATEGORIES.includes(c);

/**
 * `Import from link` — `PU-MEME-001` (D-12).
 *
 * Pegás un link, elegís video o audio y, para video, cómo se va a usar. El
 * worker lo baja con `yt-dlp`, lo sube al Media Bank, detecta si es pantalla
 * verde (o le recorta el fondo con fal si está configurado) y le pone
 * etiquetas con el modelo de visión. El diálogo muestra el progreso por
 * polling y los errores con el código estable que devuelve la API.
 *
 * El aviso de derechos es corto y va siempre: D-12 dice que el dueño asume la
 * responsabilidad por lo que publica.
 */
export function ImportFromLinkButton({ size = "sm" }: { readonly size?: "sm" | "lg" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size={size}
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
      >
        {tw("mediaImport.open")}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        size="sm"
      >
        {open && (
          <ImportBody
            onClose={() => {
              setOpen(false);
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function ImportBody({ onClose }: { readonly onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<Kind>("video");
  const [categories, setCategories] = useState<readonly MediaCategory[]>([]);
  const [importId, setImportId] = useState<string | null>(null);
  const start = useStartMediaImport();
  const status = useMediaImportStatus(importId);
  const urlId = useId();
  const errorId = useId();

  const reset = (): void => {
    setImportId(null);
    setUrl("");
    start.reset();
  };

  const submit = (): void => {
    start.mutate(
      {
        url: url.trim(),
        kind,
        ...(kind === "video" && categories.length > 0
          ? { categories: categories.filter(isVideoCategory) }
          : {}),
      },
      {
        onSuccess: (created) => {
          setImportId(created.importId);
        },
      },
    );
  };

  if (importId !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{tw("mediaImport.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ImportProgress
            status={status.data}
            loading={status.isPending}
            checkFailed={status.isError}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={reset}>
            {tw("mediaImport.another")}
          </Button>
          <Button onClick={onClose}>{tw("mediaImport.close")}</Button>
        </DialogFooter>
      </>
    );
  }

  const requestError = start.isError ? presentError(start.error) : null;
  // La URL rechazada al encolar (`400` con `details.reason`): el copy propio
  // dice qué link sí sirve; cualquier otro error, el de la presentación común.
  const unsupported =
    start.isError &&
    start.error.status === 400 &&
    start.error.details?.["reason"] === "unsupported_url";
  const canSubmit = url.trim().length > 0 && !start.isPending;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{tw("mediaImport.title")}</DialogTitle>
        <DialogDescription>{tw("mediaImport.description")}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1" htmlFor={urlId}>
            <span className="text-sm font-medium">{tw("mediaImport.urlLabel")}</span>
            <Input
              id={urlId}
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://"
              value={url}
              invalid={requestError !== null}
              aria-describedby={requestError !== null ? errorId : undefined}
              onChange={(event) => {
                setUrl(event.target.value);
              }}
            />
          </label>

          <div
            role="radiogroup"
            aria-label={tw("mediaImport.kindLabel")}
            className="flex gap-2"
          >
            {(["video", "audio"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={kind === value ? "primary" : "secondary"}
                role="radio"
                aria-checked={kind === value}
                onClick={() => {
                  setKind(value);
                }}
              >
                {tw(
                  value === "video" ? "mediaImport.kind.video" : "mediaImport.kind.audio",
                )}
              </Button>
            ))}
          </div>

          {kind === "video" && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {tw("mediaImport.categoriesLabel")}
              </span>
              <CategoryChips
                mediaType="video"
                value={categories}
                label={tw("mediaImport.categoriesLabel")}
                disabled={start.isPending}
                onToggle={(category) => {
                  setCategories((current) => toggleCategory("video", current, category));
                }}
              />
              <p className="text-xs text-text-muted">
                {tw("mediaImport.foregroundHint")}
              </p>
            </div>
          )}
          {kind === "audio" && (
            <p className="text-xs text-text-muted">{tw("mediaImport.audioHint")}</p>
          )}

          {requestError !== null && (
            <p id={errorId} role="alert" className="text-sm text-danger">
              {unsupported
                ? tw("mediaImport.error.unsupportedUrl")
                : tw(requestError.titleKey, requestError.titleVars)}
            </p>
          )}

          <p className="text-xs text-text-muted">{tw("mediaImport.rights")}</p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button
          type="button"
          variant="secondary"
          onClick={onClose}
          disabled={start.isPending}
        >
          {tw("common.cancel")}
        </Button>
        <Button type="submit" loading={start.isPending} disabled={!canSubmit}>
          {tw("mediaImport.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ImportProgress({
  status,
  loading,
  checkFailed,
}: {
  readonly status: MediaImport | undefined;
  readonly loading: boolean;
  readonly checkFailed: boolean;
}) {
  if (status === undefined) {
    if (checkFailed) {
      return (
        <p role="alert" className="text-sm text-danger">
          {tw("mediaImport.statusCheckFailed")}
        </p>
      );
    }
    return loading ? <Spinner /> : null;
  }
  const settled = isImportSettled(status);
  const failed = status.state === "failed";
  const background =
    status.background === undefined
      ? undefined
      : IMPORT_BACKGROUND_COPY[status.background];
  const tagging =
    status.tagging === undefined ? undefined : IMPORT_TAGGING_COPY[status.tagging];

  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <p
        role={failed ? "alert" : "status"}
        className={failed ? "text-sm text-danger" : "flex items-center gap-2 text-sm"}
      >
        {!settled && !failed && <Spinner aria-hidden="true" />}
        {tw(importStateCopy(status))}
      </p>
      {background !== undefined && (
        <p className="text-xs text-text-muted">{tw(background)}</p>
      )}
      {tagging !== undefined && <p className="text-xs text-text-muted">{tw(tagging)}</p>}
      {status.tags !== undefined && (
        <p className="text-xs">
          {tw("mediaImport.tagsLine", {
            emotion: status.tags.emotion,
            tags: status.tags.tags.join(", "),
          })}
        </p>
      )}
      {checkFailed && (
        <p className="text-xs text-text-muted">{tw("mediaImport.statusCheckFailed")}</p>
      )}
    </div>
  );
}
