"use client";

import type { Lead, LeadView } from "@fastgram/contracts";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@fastgram/ui";
import { useState, type FormEvent } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw } from "@/lib/i18n/t";
import { useCreateManualLead, useLeads } from "@/lib/engagement/api";
import { reasonKey, reasonOf, tierLabelKey } from "@/lib/engagement/present";

export interface LeadListProps {
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly canDiscover: boolean;
  readonly onDiscover: () => void;
  readonly discovering: boolean;
}

/** Listado con vistas y filtros — `F-193`. */
export function LeadList({
  selectedId,
  onSelect,
  canDiscover,
  onDiscover,
  discovering,
}: LeadListProps) {
  const [view, setView] = useState<LeadView>("all");
  const [unseen, setUnseen] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const leads = useLeads(view, unseen, q);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="eng-leads">
      <h2 id="eng-leads" className="sr-only">
        {tw("engagement.views.all")}
      </h2>
      <Tabs value={view} defaultValue="all" onValueChange={(v) => setView(v as LeadView)}>
        <TabsList>
          <TabsTrigger value="all">{tw("engagement.views.all")}</TabsTrigger>
          <TabsTrigger value="top">{tw("engagement.views.top")}</TabsTrigger>
          <TabsTrigger value="engaged">{tw("engagement.views.engaged")}</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          aria-label={tw("engagement.search")}
          placeholder={tw("engagement.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          wrapperClassName="min-w-0 flex-1"
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={unseen} onCheckedChange={setUnseen} />
          {tw("engagement.unseenOnly")}
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
          {tw("engagement.addManual")}
        </Button>
        {canDiscover ? (
          <Button variant="ghost" size="sm" onClick={onDiscover} disabled={discovering}>
            {tw("engagement.discovery.run")}
          </Button>
        ) : null}
      </div>

      {leads.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton height={64} />
          <Skeleton height={64} />
          <Skeleton height={64} />
        </div>
      ) : leads.isError ? (
        <ApiErrorState error={leads.error} onRetry={() => void leads.refetch()} />
      ) : leads.data.items.length === 0 ? (
        <EmptyState
          title={tw("engagement.empty.title")}
          description={tw("engagement.empty.body")}
          bordered
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="lead-list">
          {leads.data.items.map((lead) => (
            <li key={lead.id}>
              <LeadCard
                lead={lead}
                selected={lead.id === selectedId}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>
      )}
      <ManualLeadDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(id) => {
          setAdding(false);
          onSelect(id);
        }}
      />
    </section>
  );
}

function LeadCard({
  lead,
  selected,
  onSelect,
}: {
  readonly lead: Lead;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(lead.id)}
      aria-current={selected ? "true" : undefined}
      className={`flex w-full flex-col gap-1 rounded-lg border p-3 text-left ${
        selected ? "border-accent bg-surface" : "border-border bg-surface/60"
      }`}
    >
      <span className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <Badge tone="reddit" size="sm">
          r/{lead.subreddit}
        </Badge>
        <Badge tone={lead.tier === "top" ? "success" : "neutral"} size="sm">
          {tw(tierLabelKey(lead))}
        </Badge>
        {lead.leadScore === null ? null : (
          <span>
            {tw("engagement.score", { score: Math.round(lead.leadScore * 100) })}
          </span>
        )}
        <span>{tw("engagement.comments", { count: lead.numComments })}</span>
        {lead.newActivity ? (
          <Badge tone="info" size="sm">
            {tw("engagement.newActivity")}
          </Badge>
        ) : null}
      </span>
      <span
        className={`line-clamp-2 text-sm ${lead.seen ? "text-text-muted" : "font-medium text-text"}`}
      >
        {lead.title}
      </span>
    </button>
  );
}

function ManualLeadDialog({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
}) {
  const create = useCreateManualLead();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { url: url.trim(), title: title.trim(), ...(body.trim() === "" ? {} : { body }) },
      {
        onSuccess: (lead) => {
          setUrl("");
          setTitle("");
          setBody("");
          onCreated(lead.id);
        },
      },
    );
  };
  return (
    <Dialog open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{tw("engagement.addManual")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {tw("engagement.addManual.url")}
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              inputMode="url"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {tw("engagement.addManual.title")}
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={300}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {tw("engagement.addManual.body")}
            <Textarea
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={10000}
            />
          </label>
          {create.isError ? (
            <p className="m-0 text-sm text-danger" role="alert">
              {tw(reasonKey(reasonOf(create.error)))}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {tw("common.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {tw("engagement.addManual.submit")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
