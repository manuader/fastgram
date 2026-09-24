"use client";

import {
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  Spinner,
  Textarea,
  buttonVariants,
} from "@fastgram/ui";
import {
  BLITZ_PROMPT_MAX_CHARS,
  BLITZ_PROMPT_MIN_CHARS,
  INSPIRATION_REMIX_DEFAULT_COUNT,
  blitzContentTypeSchema,
  type BlitzContentType,
  type InspirationItem,
} from "@fastgram/contracts";
import Link from "next/link";
import { useId, useState } from "react";
import { presentError } from "@/lib/api/error-presentation";
import { newIdempotencyKey } from "@/lib/api/idempotency-key";
import { td } from "@/lib/blitz/deck/copy";
import {
  PROMPT_COUNTS,
  isOpenPrompt,
  promptFailureView,
  useBlitzPromptStatus,
} from "@/lib/blitz/deck/prompt";
import { tw } from "@/lib/i18n/t";
import { remixNoteError, useRemixInspiration } from "@/lib/inspiration/inspiration";
import { CONTENT_TYPE_COPY } from "@/lib/library/content";
import { ROUTES } from "@/lib/nav/routes";

/**
 * «Remix this» — F-042 adaptado a la cola de Blitz.
 *
 * No abre el Studio (FR-040 original): genera sugerencias en Blitz, adaptadas
 * a la marca activa, con el mismo pipeline de «crear desde prompt». Por eso el
 * estado y los fallos son los del deck (`useBlitzPromptStatus`,
 * `promptFailureView`): sin modelo → Settings → Models; sin media → Library.
 */
export function RemixDialog({
  item,
  onClose,
}: {
  readonly item: InspirationItem | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={item !== null} onClose={onClose} size="sm">
      {item !== null && <RemixBody key={item.id} item={item} onClose={onClose} />}
    </Dialog>
  );
}

function RemixBody({
  item,
  onClose,
}: {
  readonly item: InspirationItem;
  readonly onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [contentType, setContentType] = useState<BlitzContentType | null>(null);
  const [count, setCount] = useState(INSPIRATION_REMIX_DEFAULT_COUNT);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [requestId, setRequestId] = useState<string | null>(null);
  const remix = useRemixInspiration();
  const status = useBlitzPromptStatus(requestId);
  const noteId = useId();
  const formatId = useId();
  const countId = useId();

  if (requestId !== null) {
    const data = status.data;
    const open = data === undefined || isOpenPrompt(data);
    const failure =
      data?.status === "failed" ? promptFailureView(data.failureReason) : null;
    return (
      <>
        <DialogHeader>
          <DialogTitle>{tw("inspiration.remix.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div role="status" className="flex items-center gap-2 text-sm">
            {status.isError ? (
              <span className="text-danger">
                {tw(
                  presentError(status.error).titleKey,
                  presentError(status.error).titleVars,
                )}
              </span>
            ) : open ? (
              <>
                <Spinner size="sm" aria-hidden="true" />
                {tw("inspiration.remix.running")}
              </>
            ) : failure !== null ? (
              <span className="text-danger">
                {td(failure.message)}{" "}
                {failure.link !== undefined && (
                  <Link href={failure.link.href} className="underline">
                    {td(failure.link.label)}
                  </Link>
                )}
              </span>
            ) : (
              <span>{tw("inspiration.remix.done")}</span>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {tw("common.close")}
          </Button>
          {data?.status === "done" && (
            <Link href={ROUTES.blitz} className={buttonVariants({ variant: "primary" })}>
              {tw("inspiration.remix.openBlitz")}
            </Link>
          )}
        </DialogFooter>
      </>
    );
  }

  const noteError = remixNoteError(note);
  const requestError = remix.isError ? presentError(remix.error) : null;
  const canSubmit = noteError === null && !remix.isPending;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        remix.mutate(
          { itemId: item.id, prompt: note, contentType, count, idempotencyKey },
          { onSuccess: setRequestId },
        );
      }}
    >
      <DialogHeader>
        <DialogTitle>{tw("inspiration.remix.title")}</DialogTitle>
        <DialogDescription>{tw("inspiration.remix.description")}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-4">
          <p className="line-clamp-2 text-sm text-text-muted">
            {item.title ?? item.caption ?? tw("inspiration.card.untitled")}
          </p>
          <label className="flex flex-col gap-1" htmlFor={noteId}>
            <span className="text-sm font-medium">
              {tw("inspiration.remix.noteLabel")}
            </span>
            <Textarea
              id={noteId}
              rows={2}
              maxLength={BLITZ_PROMPT_MAX_CHARS}
              placeholder={tw("inspiration.remix.notePlaceholder")}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
            {noteError !== null && (
              <span role="alert" className="text-xs text-danger">
                {tw("inspiration.remix.noteTooShort", { min: BLITZ_PROMPT_MIN_CHARS })}
              </span>
            )}
          </label>
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1" htmlFor={formatId}>
              <span className="text-sm font-medium">
                {tw("inspiration.remix.formatLabel")}
              </span>
              <Select
                id={formatId}
                value={contentType ?? ""}
                onChange={(event) => {
                  const v = blitzContentTypeSchema.safeParse(event.target.value);
                  setContentType(v.success ? v.data : null);
                }}
                options={[
                  { value: "", label: tw("inspiration.remix.formatAuto") },
                  ...blitzContentTypeSchema.options.map((t) => ({
                    value: t,
                    label: tw(CONTENT_TYPE_COPY[t]),
                  })),
                ]}
              />
            </label>
            <label className="flex flex-col gap-1" htmlFor={countId}>
              <span className="text-sm font-medium">
                {tw("inspiration.remix.countLabel")}
              </span>
              <Select
                id={countId}
                value={String(count)}
                onChange={(event) => {
                  setCount(Number(event.target.value));
                }}
                options={PROMPT_COUNTS.map((n) => ({
                  value: String(n),
                  label: String(n),
                }))}
              />
            </label>
          </div>
          {requestError !== null && (
            <p role="alert" className="text-sm text-danger">
              {tw(requestError.titleKey, requestError.titleVars)}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {tw("common.cancel")}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {remix.isPending ? <Spinner size="xs" /> : tw("inspiration.remix.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
