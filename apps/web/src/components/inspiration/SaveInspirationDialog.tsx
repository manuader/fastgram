"use client";

import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
  cn,
} from "@fastgram/ui";
import { INSPIRATION_MAX_TAGS } from "@fastgram/contracts";
import { useId, useState } from "react";
import { presentError } from "@/lib/api/error-presentation";
import { tw } from "@/lib/i18n/t";
import { parseTags, useSaveInspiration } from "@/lib/inspiration/inspiration";
import { flattenMediaPages, useMediaList } from "@/lib/media/media";

type Mode = "link" | "media";

/**
 * «Save inspiration» — pegar un link (TikTok/IG/X/YouTube, o cualquier página
 * que lea `yt-dlp`) o elegir un clip ya subido al Media Bank.
 *
 * La lectura de la página pasa en el worker: el diálogo cierra en cuanto la
 * referencia existe (`pending`) y la tarjeta muestra el progreso por polling.
 * El aviso de derechos va siempre (D-12).
 */
export function SaveInspirationDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} size="sm">
      {open && <SaveBody onClose={onClose} />}
    </Dialog>
  );
}

function SaveBody({ onClose }: { readonly onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("link");
  const [url, setUrl] = useState("");
  const [tags, setTags] = useState("");
  const [saveClip, setSaveClip] = useState(false);
  const [mediaId, setMediaId] = useState<string | null>(null);
  const save = useSaveInspiration();
  const urlId = useId();
  const tagsId = useId();
  const tagsHintId = useId();
  const errorId = useId();

  const requestError = save.isError ? presentError(save.error) : null;
  const unsupported =
    save.isError &&
    save.error.status === 400 &&
    save.error.details?.["reason"] === "unsupported_url";
  const canSubmit =
    !save.isPending && (mode === "link" ? url.trim().length > 0 : mediaId !== null);

  const submit = (): void => {
    const parsedTags = parseTags(tags);
    save.mutate(
      mode === "link"
        ? { url, tags: parsedTags, saveClip }
        : { mediaId: mediaId ?? "", tags: parsedTags },
      { onSuccess: onClose },
    );
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{tw("inspiration.saveDialog.title")}</DialogTitle>
        <DialogDescription>{tw("inspiration.saveDialog.description")}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-4">
          <div
            role="radiogroup"
            aria-label={tw("inspiration.saveDialog.title")}
            className="flex gap-2"
          >
            {(["link", "media"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={mode === value ? "primary" : "secondary"}
                role="radio"
                aria-checked={mode === value}
                onClick={() => {
                  setMode(value);
                  save.reset();
                }}
              >
                {tw(
                  value === "link"
                    ? "inspiration.saveDialog.fromLink"
                    : "inspiration.saveDialog.fromMediaBank",
                )}
              </Button>
            ))}
          </div>

          {mode === "link" ? (
            <>
              <label className="flex flex-col gap-1" htmlFor={urlId}>
                <span className="text-sm font-medium">
                  {tw("inspiration.saveDialog.urlLabel")}
                </span>
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
              <Checkbox
                checked={saveClip}
                onChange={(event) => {
                  setSaveClip(event.target.checked);
                }}
                label={tw("inspiration.saveDialog.saveClip")}
              />
            </>
          ) : (
            <MediaPicker selected={mediaId} onSelect={setMediaId} />
          )}

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor={tagsId}>
              {tw("inspiration.saveDialog.tagsLabel")}
            </label>
            <Input
              id={tagsId}
              autoComplete="off"
              value={tags}
              placeholder="hooks, pov"
              aria-describedby={tagsHintId}
              onChange={(event) => {
                setTags(event.target.value);
              }}
            />
            <span id={tagsHintId} className="text-xs text-text-muted">
              {tw("inspiration.saveDialog.tagsHint", { max: INSPIRATION_MAX_TAGS })}
            </span>
          </div>

          <p className="text-xs text-text-muted">{tw("inspiration.saveDialog.rights")}</p>

          {requestError !== null && (
            <p id={errorId} role="alert" className="text-sm text-danger">
              {unsupported
                ? tw("inspiration.saveDialog.unsupportedUrl")
                : tw(requestError.titleKey, requestError.titleVars)}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {tw("common.cancel")}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {save.isPending ? (
            <span className="inline-flex items-center gap-2">
              <Spinner size="xs" aria-hidden="true" />
              {tw("inspiration.saveDialog.saving")}
            </span>
          ) : (
            tw("inspiration.saveDialog.submit")
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Los clips ya subidos (primera página del Media Bank), para elegir uno. */
function MediaPicker({
  selected,
  onSelect,
}: {
  readonly selected: string | null;
  readonly onSelect: (mediaId: string) => void;
}) {
  const list = useMediaList({ limit: 24 });
  const items = flattenMediaPages(list.data).filter((m) => m.status === "ready");
  if (list.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner size="md" />
      </div>
    );
  }
  if (list.isError) {
    return (
      <p role="alert" className="text-sm text-danger">
        {tw("inspiration.error")}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="text-sm text-text-muted">{tw("inspiration.saveDialog.mediaEmpty")}</p>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label={tw("inspiration.saveDialog.pickClip")}
      className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto"
    >
      {items.map((m) => (
        <button
          key={m.mediaId}
          type="button"
          role="radio"
          aria-checked={selected === m.mediaId}
          aria-label={m.filename}
          title={m.filename}
          onClick={() => {
            onSelect(m.mediaId);
          }}
          className={cn(
            "fg-focusable aspect-[9/16] overflow-hidden rounded-md border-2 bg-surface-sunken",
            selected === m.mediaId ? "border-accent" : "border-transparent",
          )}
        >
          {m.mediaType === "image" ? (
            <img
              src={m.r2Url}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <video
              src={m.r2Url}
              muted
              preload="metadata"
              className="h-full w-full object-cover"
            />
          )}
        </button>
      ))}
    </div>
  );
}
