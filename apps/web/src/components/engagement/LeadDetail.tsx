"use client";

import type { LeadDetail as LeadDetailData } from "@fastgram/contracts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
  Textarea,
  useToast,
} from "@fastgram/ui";
import { useEffect, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import {
  useDeleteLead,
  useGenerateReply,
  useLead,
  useMarkSeen,
  useMarkSent,
  useSaveDraft,
  useSendReply,
  useSyncLead,
} from "@/lib/engagement/api";
import {
  blockedKey,
  issueKey,
  reasonKey,
  reasonOf,
  strongSignals,
} from "@/lib/engagement/present";

export interface LeadDetailProps {
  readonly leadId: string;
  /** Usuario de Reddit conectado, para el diálogo de confirmación. */
  readonly username: string | null;
  readonly onClose: () => void;
}

/** Detalle del lead (`F-194`), respuesta (`F-195`) y envío (`D-11`). */
export function LeadDetail({ leadId, username, onClose }: LeadDetailProps) {
  const query = useLead(leadId);
  const markSeen = useMarkSeen();
  const { mutate: seen } = markSeen;

  useEffect(() => {
    if (
      query.data !== undefined &&
      (!query.data.lead.seen || query.data.lead.newActivity)
    ) {
      seen(leadId);
    }
    // Una vez por lead abierto: `seen` es estable.
  }, [leadId, query.data?.lead.id]);

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <p className="m-0 text-sm text-text-muted">{tw("loading.lead")}</p>
        <Skeleton height={120} />
        <Skeleton height={200} />
      </div>
    );
  }
  if (query.isError) {
    if (isApiRequestError(query.error) && query.error.status === 404) {
      return (
        <EmptyState
          title={tw("engagement.detail.notFoundTitle")}
          description={tw("engagement.detail.notFoundBody")}
          action={
            <Button variant="secondary" onClick={onClose}>
              {tw("engagement.detail.back")}
            </Button>
          }
          bordered
        />
      );
    }
    return <ApiErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <LeadDetailView detail={query.data} username={username} onClose={onClose} />;
}

function LeadDetailView({
  detail,
  username,
  onClose,
}: {
  readonly detail: LeadDetailData;
  readonly username: string | null;
  readonly onClose: () => void;
}) {
  const { lead } = detail;
  const del = useDeleteLead();
  const sync = useSyncLead();
  const { toast } = useToast();

  return (
    <div className="flex flex-col gap-4" data-testid="lead-detail">
      <Card>
        <CardHeader className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="link" size="sm" onClick={onClose}>
              {tw("engagement.detail.back")}
            </Button>
            <Badge tone="reddit" size="sm">
              r/{lead.subreddit}
            </Badge>
          </div>
          <CardTitle>{lead.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <span className="sr-only">{tw("engagement.detail.title")}</span>
          {lead.body === null || lead.body === "" ? null : (
            <p className="m-0 whitespace-pre-wrap text-sm text-text">{lead.body}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {lead.url === null ? null : (
              <a
                className="text-sm"
                href={lead.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {tw("engagement.detail.viewOnReddit")}
              </a>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => del.mutate(lead.id, { onSuccess: onClose })}
              disabled={del.isPending}
            >
              {tw("engagement.detail.delete")}
            </Button>
          </div>
          {detail.contextComments.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-sm text-text-muted">
                {tw("engagement.detail.topComments")}
              </summary>
              <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                {detail.contextComments.map((c, i) => (
                  <li
                    key={i}
                    className="whitespace-pre-wrap rounded-md bg-surface p-2 text-xs text-text-muted"
                  >
                    {c}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tw("engagement.why.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {lead.whyThisLead === null ? (
            <p className="m-0 text-sm text-text-muted">{tw("engagement.why.pending")}</p>
          ) : (
            <p className="m-0 text-sm text-text">{lead.whyThisLead}</p>
          )}
          {lead.scoreComponents === null ? null : (
            <ul
              className="m-0 flex list-none flex-col gap-1 p-0"
              aria-label={tw("engagement.why.title")}
            >
              {strongSignals(lead.scoreComponents).map((s) => (
                <li
                  key={s.key}
                  className="flex items-center gap-2 text-xs text-text-muted"
                >
                  <span className="w-40 shrink-0">{tw(s.key)}</span>
                  <meter min={0} max={1} value={s.value} className="h-2 flex-1" />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ReplyEditor detail={detail} username={username} />

      {lead.replied ? (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>{tw("engagement.sent.title")}</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              disabled={sync.isPending || username === null}
              onClick={() =>
                sync.mutate(lead.id, {
                  onSuccess: () =>
                    toast({ title: tw("engagement.sync.queued"), tone: "info" }),
                })
              }
            >
              {tw("engagement.sync")}
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {lead.threadState === null ? null : (
              <p
                className={`m-0 text-sm ${lead.threadState === "comment_missing" ? "text-warning" : "text-text-muted"}`}
              >
                {tw(`engagement.thread.${lead.threadState}`)}
                {lead.repliesToUs > 0
                  ? ` · ${tw("engagement.thread.repliesToUs", { count: lead.repliesToUs })}`
                  : ""}
              </p>
            )}
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {detail.replies.map((r) => (
                <li key={r.id} className="rounded-md bg-surface p-2 text-sm">
                  <span className="flex gap-2 text-xs text-text-muted">
                    <Badge
                      size="sm"
                      tone={r.tone === "direct_promo" ? "warning" : "neutral"}
                    >
                      {r.tone === null
                        ? tw("engagement.sent.tone.pending")
                        : tw(`engagement.sent.tone.${r.tone}`)}
                    </Badge>
                    {new Date(r.sentAt).toLocaleString()}
                  </span>
                  <p className="m-0 mt-1 whitespace-pre-wrap text-text">{r.text}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function ReplyEditor({
  detail,
  username,
}: {
  readonly detail: LeadDetailData;
  readonly username: string | null;
}) {
  const { lead } = detail;
  const { toast } = useToast();
  const generate = useGenerateReply();
  const saveDraft = useSaveDraft();
  const send = useSendReply();
  const markSent = useMarkSent();
  const [text, setText] = useState(lead.replyDraft ?? "");
  const [confirming, setConfirming] = useState(false);
  const [marking, setMarking] = useState(false);
  const [commentUrl, setCommentUrl] = useState("");

  // Un borrador nuevo del worker reemplaza el texto (el usuario pidió regenerar).
  useEffect(() => {
    setText(lead.replyDraft ?? "");
  }, [lead.replyDraft, lead.id]);

  const generating = lead.replyStatus === "generating" || generate.isPending;
  const dirty = text !== (lead.replyDraft ?? "");
  const blocked = blockedKey(detail.sendBlockedReason);

  const copyAndOpen = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: tw("engagement.copyOpen.copied"), tone: "info" });
    } catch {
      // Sin permiso de portapapeles: se abre el hilo igual.
    }
    if (lead.url !== null) window.open(lead.url, "_blank", "noopener,noreferrer");
  };

  const doSend = () => {
    send.mutate(
      { id: lead.id, text },
      {
        onSuccess: () => {
          setConfirming(false);
          toast({ title: tw("engagement.send.sent"), tone: "success" });
        },
        onError: (error) => {
          setConfirming(false);
          const reason = reasonOf(error);
          toast({
            title:
              reason === "reddit_unavailable"
                ? tw("engagement.send.unknown")
                : tw(reasonKey(reason)),
            tone: "danger",
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{tw("engagement.reply.title")}</CardTitle>
        <Button
          variant="secondary"
          size="sm"
          disabled={generating}
          onClick={() =>
            generate.mutate({ id: lead.id, regenerate: lead.replyDraft !== null })
          }
        >
          {generating
            ? tw("engagement.reply.generating")
            : lead.replyDraft === null
              ? tw("engagement.reply.generate")
              : tw("engagement.reply.regenerate")}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {lead.replyStatus === "failed" ? (
          <p className="m-0 text-sm text-danger" role="alert">
            {tw("engagement.reply.failed")}
          </p>
        ) : null}
        <Textarea
          rows={8}
          value={text}
          aria-label={tw("engagement.reply.title")}
          placeholder={tw("engagement.reply.placeholder")}
          onChange={(e) => setText(e.target.value)}
          disabled={generating}
        />
        {detail.draftIssues.length > 0 && !dirty ? (
          <ul
            className="m-0 flex list-none flex-col gap-1 p-0"
            data-testid="draft-issues"
          >
            {detail.draftIssues.map((i) => (
              <li
                key={i}
                className={`text-sm ${i === "contains_link" ? "text-warning" : "text-danger"}`}
              >
                {tw(issueKey(i))}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || saveDraft.isPending}
            onClick={() => saveDraft.mutate({ id: lead.id, text })}
          >
            {tw("engagement.reply.saveDraft")}
          </Button>
          <Button
            size="sm"
            disabled={!detail.canSend || dirty || text.trim() === "" || send.isPending}
            onClick={() => setConfirming(true)}
            data-testid="send-button"
          >
            {tw("engagement.send")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={text.trim() === ""}
            onClick={() => void copyAndOpen()}
          >
            {tw("engagement.copyOpen")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={text.trim() === ""}
            onClick={() => setMarking(true)}
          >
            {tw("engagement.markSent")}
          </Button>
        </div>
        {blocked === null ? null : (
          <p className="m-0 text-sm text-text-muted" data-testid="send-blocked">
            {tw(blocked)}
          </p>
        )}
      </CardContent>

      <Dialog open={confirming} onClose={() => setConfirming(false)}>
        <DialogHeader>
          <DialogTitle>{tw("engagement.send.confirmTitle")}</DialogTitle>
          <DialogDescription>
            {tw("engagement.send.confirmBody", { username: username ?? "?" })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="m-0 whitespace-pre-wrap rounded-md bg-surface p-2 text-sm">
            {text}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            {tw("common.cancel")}
          </Button>
          <Button onClick={doSend} disabled={send.isPending} data-testid="confirm-send">
            {tw("engagement.send.confirm")}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={marking} onClose={() => setMarking(false)}>
        <DialogHeader>
          <DialogTitle>{tw("engagement.markSent")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <label className="flex flex-col gap-1 text-sm">
            {tw("engagement.markSent.url")}
            <Input
              value={commentUrl}
              onChange={(e) => setCommentUrl(e.target.value)}
              inputMode="url"
            />
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setMarking(false)}>
            {tw("common.cancel")}
          </Button>
          <Button
            disabled={markSent.isPending}
            onClick={() =>
              markSent.mutate(
                { id: lead.id, text, commentUrl },
                {
                  onSuccess: () => {
                    setMarking(false);
                    setCommentUrl("");
                    toast({ title: tw("engagement.markSent.done"), tone: "success" });
                  },
                },
              )
            }
          >
            {tw("engagement.markSent")}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}
