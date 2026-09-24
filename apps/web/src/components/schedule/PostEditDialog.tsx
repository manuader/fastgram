"use client";

import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
  useToast,
} from "@fastgram/ui";
import type { Post } from "@fastgram/contracts";
import { useEffect, useId, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { presentError } from "@/lib/api/error-presentation";
import { isApiRequestError } from "@/lib/api/errors";
import { NETWORK_LABEL } from "@/lib/calendar/board";
import { tw } from "@/lib/i18n/t";
import { POST_STATUS_COPY, POST_STATUS_TONE } from "@/lib/library/posts";
import {
  CANCELLABLE,
  EDITABLE,
  PLATFORM_LIMITS,
  UNCERTAIN_FAILURE_CODES,
  draftProblems,
  needsPublishConfirmation,
  useCancelPosts,
  useGetPost,
  useRetryPost,
  useUpdatePost,
  utcToZoned,
  zonedToUtc,
} from "@/lib/posts/schedule";
import { CaptionField } from "./ScheduleDialog";

export interface PostEditDialogProps {
  readonly open: boolean;
  /** `null` = cerrado. */
  readonly postId: string | null;
  /** La marca del post, si no es la activa (vista "All brands"). */
  readonly brandId?: string;
  /** Zona horaria en la que se muestra y se elige la hora (la de la marca). */
  readonly timeZone: string;
  readonly onClose: () => void;
}

/**
 * Un post ya programado o fallido — sprint 7 (publish-flow).
 *
 * - **Programado** (`SCHEDULED`/`BUILDING`/`AWAITING_RECONNECT`): editar la
 *   caption (y la descripción en TikTok/YouTube) y la hora con
 *   `PATCH /posts/:id` —mover recrea el post, igual que arrastrarlo en el
 *   calendario— o cancelarlo.
 * - **Fallido**: `Retry now` (ahora + margen) o `Reschedule` a la hora elegida,
 *   con `POST /posts/:id/retry`. Si el fallo fue una entrega incierta, pide
 *   confirmar que la plataforma no lo publicó (`NFR-015`: reintentar a ciegas
 *   puede duplicarlo).
 * - Cualquier otro estado: sólo se muestra.
 *
 * `GET /posts/:id` lee con la marca activa: un post de otra marca da 404 y se
 * dice que hay que cambiar de marca para editarlo.
 */
export function PostEditDialog({
  open,
  postId,
  brandId,
  timeZone,
  onClose,
}: PostEditDialogProps) {
  const query = useGetPost(open ? postId : null);
  return (
    <Dialog open={open && postId !== null} onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>{tw("postEdit.title")}</DialogTitle>
        <DialogDescription className="sr-only">
          {tw("postEdit.description")}
        </DialogDescription>
      </DialogHeader>
      {query.isPending ? (
        <DialogBody>
          <div aria-busy="true" className="flex flex-col gap-3">
            <Skeleton height={32} />
            <Skeleton height={96} />
          </div>
        </DialogBody>
      ) : query.isError ? (
        <DialogBody>
          {isApiRequestError(query.error) && query.error.code === "not_found" ? (
            <p className="text-sm text-text-muted">{tw("postEdit.otherBrand")}</p>
          ) : (
            <ApiErrorState
              error={query.error}
              onRetry={() => {
                void query.refetch();
              }}
            />
          )}
        </DialogBody>
      ) : (
        <PostEditForm
          key={query.data._id}
          post={query.data}
          timeZone={timeZone}
          onClose={onClose}
          {...(brandId === undefined ? {} : { brandId })}
        />
      )}
    </Dialog>
  );
}

interface PostEditFormProps {
  readonly post: Post;
  readonly brandId?: string;
  readonly timeZone: string;
  readonly onClose: () => void;
}

function PostEditForm({ post, brandId, timeZone, onClose }: PostEditFormProps) {
  const { toast } = useToast();
  const inPastId = useId();
  const update = useUpdatePost();
  const retry = useRetryPost();
  const cancel = useCancelPosts();
  const editable = EDITABLE.has(post.status) && post.cancellationPending !== true;
  const failed = post.status === "FAILED";
  const limits = PLATFORM_LIMITS[post.platform];
  const titled = limits.description !== null;

  const initial = utcToZoned(
    failed ? Math.max(post.scheduledAtUtc, Date.now() + 3_600_000) : post.scheduledAtUtc,
    timeZone,
  );
  const [caption, setCaption] = useState(post.caption);
  const [description, setDescription] = useState(post.description);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [confirmed, setConfirmed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const atMs = zonedToUtc(date, time, timeZone);
  const inPast = atMs === null || atMs <= nowMs;
  const uncertain =
    post.errorCode !== undefined && UNCERTAIN_FAILURE_CODES.has(post.errorCode);
  const tooLong =
    draftProblems([
      {
        network: post.platform,
        selected: true,
        connectionId: "x",
        caption,
        description,
        instagramSlideshowFormat: "carousel",
        aiContentDisclaimer: false,
        tiktokPrivacy: null,
      },
    ]).length > 0;
  const brand = brandId === undefined ? {} : { brandId };
  const busy = update.isPending || retry.isPending || cancel.isPending;
  const error = update.error ?? retry.error ?? cancel.error;
  const failure =
    error === null ? null : needsPublishConfirmation(error) ? null : presentError(error);

  const done = (
    key: "postEdit.toast.saved" | "postEdit.toast.retried" | "postEdit.toast.cancelled",
  ) => {
    toast({ title: tw(key), tone: "success" });
    onClose();
  };

  const save = () => {
    if (atMs === null) return;
    update.mutate(
      {
        postId: post._id,
        ...brand,
        ...(caption !== post.caption ? { caption } : {}),
        ...(titled && description !== post.description ? { description } : {}),
        ...(atMs !== post.scheduledAtUtc && !inPast ? { scheduledAtUtc: atMs } : {}),
      },
      {
        onSuccess: () => {
          done("postEdit.toast.saved");
        },
      },
    );
  };

  const doRetry = (at: number | undefined) => {
    retry.mutate(
      {
        postId: post._id,
        ...brand,
        ...(at === undefined ? {} : { scheduledAtUtc: at }),
        ...(confirmed ? { confirmNotPublished: true } : {}),
      },
      {
        onSuccess: () => {
          done("postEdit.toast.retried");
        },
      },
    );
  };

  return (
    <>
      <DialogBody>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Badge tone={post.platform} size="sm">
              {NETWORK_LABEL[post.platform]}
            </Badge>
            <Badge tone={POST_STATUS_TONE[post.status]} size="sm" dot>
              {tw(POST_STATUS_COPY[post.status])}
            </Badge>
            {post.connectionUsername !== undefined && (
              <span className="text-xs text-text-muted">@{post.connectionUsername}</span>
            )}
          </div>

          {failed && post.errorMessage !== undefined && (
            <p className="text-sm text-danger">{post.errorMessage}</p>
          )}

          {editable ? (
            <>
              <CaptionField
                contentId={post.contentId}
                network={post.platform}
                field="caption"
                label={titled ? tw("schedule.titleField") : tw("schedule.captionField")}
                value={caption}
                max={limits.caption}
                singleLine={titled}
                onChange={setCaption}
              />
              {titled && (
                <CaptionField
                  contentId={post.contentId}
                  network={post.platform}
                  field="description"
                  label={tw("schedule.descriptionField")}
                  value={description}
                  max={limits.description}
                  singleLine={false}
                  onChange={setDescription}
                />
              )}
            </>
          ) : (
            !failed && (
              <p className="whitespace-pre-wrap text-sm text-text">
                {post.publishedCaption ?? post.caption}
              </p>
            )
          )}

          {(editable || failed) && (
            <fieldset className="flex flex-wrap items-end gap-3">
              <legend className="mb-1 text-sm font-medium text-text">
                {tw("schedule.when", { timezone: timeZone })}
              </legend>
              <label className="flex flex-col gap-1 text-xs text-text-muted">
                {tw("schedule.date")}
                <Input
                  type="date"
                  value={date}
                  invalid={inPast}
                  aria-describedby={inPast ? inPastId : undefined}
                  onChange={(e) => {
                    setDate(e.target.value);
                  }}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-text-muted">
                {tw("schedule.time")}
                <Input
                  type="time"
                  value={time}
                  invalid={inPast}
                  aria-describedby={inPast ? inPastId : undefined}
                  onChange={(e) => {
                    setTime(e.target.value);
                  }}
                />
              </label>
            </fieldset>
          )}
          {/* P5-A11Y-001: el borde rojo solo no dice por qué (WCAG 3.3.1). Y
              `save` descarta en silencio una hora pasada: acá se avisa. */}
          <div aria-live="polite">
            {editable && tooLong && (
              <p className="text-xs text-danger">
                {tw("schedule.problem.tooLong", {
                  network: NETWORK_LABEL[post.platform],
                })}
              </p>
            )}
          </div>
          {(editable || failed) && inPast && (
            <p id={inPastId} role="status" className="text-xs text-danger">
              {tw("schedule.inPast")}
            </p>
          )}

          {failed && uncertain && (
            <Checkbox
              label={tw("postEdit.confirmNotPublished")}
              description={tw("postEdit.confirmNotPublishedHint")}
              checked={confirmed}
              onChange={(e) => {
                setConfirmed(e.target.checked);
              }}
            />
          )}
          {error !== null && needsPublishConfirmation(error) && (
            <p role="alert" className="text-sm text-danger">
              {tw("postEdit.needsConfirmation")}
            </p>
          )}
          {failure !== null && (
            <p role="alert" className="text-sm text-danger">
              {tw(failure.titleKey, failure.titleVars)}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        {CANCELLABLE.has(post.status) && post.cancellationPending !== true && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              cancel.mutate([post._id], {
                onSuccess: () => {
                  done("postEdit.toast.cancelled");
                },
              });
            }}
          >
            {tw("postEdit.cancelPost")}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {tw("schedule.cancel")}
        </Button>
        {editable && (
          <Button onClick={save} loading={update.isPending} disabled={busy || tooLong}>
            {tw("postEdit.save")}
          </Button>
        )}
        {failed && (
          <>
            <Button
              variant="secondary"
              disabled={busy || inPast || (uncertain && !confirmed)}
              onClick={() => {
                if (atMs !== null) doRetry(atMs);
              }}
            >
              {tw("postEdit.reschedule")}
            </Button>
            <Button
              loading={retry.isPending}
              disabled={busy || (uncertain && !confirmed)}
              onClick={() => {
                doRetry(undefined);
              }}
            >
              {tw("postEdit.retryNow")}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
