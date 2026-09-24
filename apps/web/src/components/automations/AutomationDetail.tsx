"use client";

import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  Input,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from "@fastgram/ui";
import type { Automation, AutomationSlot } from "@fastgram/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { copyKeyForError } from "@/lib/api/errors";
import { NETWORK_LABEL } from "@/lib/calendar/board";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import {
  useAutomation,
  useAutomationAction,
  useAutomationSlots,
  useDeleteAutomation,
  useUpdateAutomation,
} from "@/lib/automations/api";
import {
  AUTOMATION_STATUS_COPY,
  AUTOMATION_STATUS_TONE,
  dayLabel,
  generationBlockedCopy,
  progressOf,
} from "@/lib/automations/present";
import { LaunchDialog } from "./LaunchDialog";
import { SlotDialog } from "./SlotDialog";
import { SlotCalendar, SlotGrid } from "./SlotViews";

/** Por qué una campaña quedó `FAILED` (`failureCode`, estable). */
function failureCopy(code: string | null): string {
  switch (code) {
    case "llm_not_configured":
      return tw("automations.failure.noLlm");
    case "all_builds_failed":
      return tw("automations.failure.allBuilds");
    default:
      return tw("automations.failure.generic");
  }
}

/**
 * `/automations/:id` — el detalle de una campaña (`FR-150`, `F-213…F-220`):
 * nombre (`Rename automation`), estado y progreso, totales de los posts
 * (`F-218`), las vistas `Calendar view` / `Grid view` de los slots, la
 * revisión (`Post details`), `Continue to launch` y `Cancel automation`.
 */
export function AutomationDetail({ automationId }: { readonly automationId: string }) {
  const query = useAutomation(automationId);
  const slots = useAutomationSlots(
    automationId,
    query.data !== undefined && query.data.status !== "DRAFT",
  );

  if (query.isPending) {
    return (
      <div
        className="flex flex-col gap-4"
        aria-busy="true"
        aria-label={tw("common.loading")}
      >
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (query.isError) {
    return query.error.code === "not_found" ? (
      <ErrorState
        title={tw("automations.detail.notFound")}
        description={tw("automations.detail.notFound.body")}
      />
    ) : (
      <ErrorState
        title={tw("automations.detail.error")}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return (
    <DetailBody
      automation={query.data}
      slots={slots.data ?? null}
      slotsLoading={slots.isPending && query.data.status !== "DRAFT"}
      slotsError={slots.isError}
      retrySlots={() => {
        void slots.refetch();
      }}
    />
  );
}

function DetailBody({
  automation: a,
  slots,
  slotsLoading,
  slotsError,
  retrySlots,
}: {
  readonly automation: Automation;
  readonly slots: readonly AutomationSlot[] | null;
  readonly slotsLoading: boolean;
  readonly slotsError: boolean;
  readonly retrySlots: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(a.name);
  const [open, setOpen] = useState<AutomationSlot | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [confirm, setConfirm] = useState<"cancel" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rename = useUpdateAutomation(a.id);
  const generate = useAutomationAction(a.id, "generate");
  const cancel = useAutomationAction(a.id, "cancel");
  const del = useDeleteAutomation();
  const router = useRouter();
  const { toast } = useToast();
  const progress = progressOf(a);
  const live = a.status === "BUILDING" || a.status === "ACTIVE";

  const fail = (e: unknown) => {
    setError(generationBlockedCopy(e) ?? tw(copyKeyForError(e)));
  };

  const actions = (
    <div className="flex flex-wrap gap-2">
      {a.status === "DRAFT" && (
        <>
          <Link
            href={`${ROUTES.automations}/${encodeURIComponent(a.id)}/edit`}
            className="fg-btn fg-btn--secondary fg-btn--md"
          >
            {tw("automations.detail.editSetup")}
          </Link>
          <Button
            loading={generate.isPending}
            onClick={() => {
              setError(null);
              generate.mutateAsync().catch(fail);
            }}
          >
            {tw("automations.wizard.generate")}
          </Button>
        </>
      )}
      {a.status === "REVIEW" && (
        <Button
          onClick={() => {
            setLaunchOpen(true);
          }}
        >
          {tw("automations.detail.continue")}
        </Button>
      )}
      {(a.status === "GENERATING" || a.status === "REVIEW" || live) && (
        <Button
          variant="ghost"
          onClick={() => {
            setConfirm("cancel");
          }}
        >
          {tw("automations.detail.cancel")}
        </Button>
      )}
      {!live && a.status !== "GENERATING" && (
        <Button
          variant="ghost"
          onClick={() => {
            setConfirm("delete");
          }}
        >
          {tw("automations.detail.delete")}
        </Button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={a.name}
        description={tw("automations.row.meta", {
          start: dayLabel(a.startDate),
          weeks: a.durationWeeks,
          perDay: a.perAccountPerDay,
        })}
        actions={actions}
      />

      <Card padding="md" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={AUTOMATION_STATUS_TONE[a.status]} dot>
            {tw(AUTOMATION_STATUS_COPY[a.status])}
          </Badge>
          {a.accounts.map((acc) => (
            <Badge key={acc.platform} tone="outline" size="sm">
              {NETWORK_LABEL[acc.platform as keyof typeof NETWORK_LABEL] ?? acc.platform}
              {acc.accountType === "planned"
                ? ` · ${tw("automations.detail.plannedTag")}`
                : ""}
            </Badge>
          ))}
          {renaming ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                rename
                  .mutateAsync({ name })
                  .then(() => {
                    setRenaming(false);
                  })
                  .catch(fail);
              }}
            >
              <Input
                aria-label={tw("automations.detail.nameLabel")}
                value={name}
                maxLength={100}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
              <Button type="submit" size="sm" loading={rename.isPending}>
                {tw("automations.detail.saveName")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setName(a.name);
                  setRenaming(false);
                }}
              >
                {tw("automations.detail.cancelRename")}
              </Button>
            </form>
          ) : (
            <Button
              size="sm"
              variant="link"
              onClick={() => {
                setRenaming(true);
              }}
            >
              {tw("automations.detail.rename")}
            </Button>
          )}
        </div>
        {progress.total > 0 && (
          <div className="flex items-center gap-3">
            <div
              className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
              aria-label={tw(progress.label, {
                done: progress.done,
                total: progress.total,
              })}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500"
                style={{ width: `${String(progress.percent)}%` }}
              />
            </div>
            <span className="text-sm text-text-muted">
              {tw(progress.label, { done: progress.done, total: progress.total })}
            </span>
          </div>
        )}
        {a.status === "GENERATING" && (
          <p className="text-sm text-text-muted" role="status">
            {tw("automations.detail.generating")}
          </p>
        )}
        {live && (
          <p className="text-sm text-text-muted">{tw("automations.detail.postLaunch")}</p>
        )}
        {a.status === "FAILED" && (
          <p role="alert" className="text-sm text-danger">
            {failureCopy(a.failureCode)}
          </p>
        )}
        {a.stats !== undefined && a.stats.posts > 0 && (
          <dl className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
            <Stat label={tw("automations.stats.published")} value={a.stats.published} />
            <Stat label={tw("automations.stats.pending")} value={a.stats.pending} />
            <Stat label={tw("automations.stats.failed")} value={a.stats.failed} />
            <Stat label={tw("automations.stats.views")} value={a.stats.views} />
            <Stat label={tw("automations.stats.likes")} value={a.stats.likes} />
            <Stat label={tw("automations.stats.comments")} value={a.stats.comments} />
          </dl>
        )}
        {error !== null && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </Card>

      {a.status === "DRAFT" ? (
        <Card padding="lg">
          <p className="text-sm text-text-muted">{tw("automations.detail.draftHint")}</p>
        </Card>
      ) : slotsLoading ? (
        <Skeleton className="h-64 w-full rounded-xl" aria-label={tw("common.loading")} />
      ) : slotsError || slots === null ? (
        <ErrorState title={tw("automations.detail.slotsError")} onRetry={retrySlots} />
      ) : slots.length === 0 ? (
        <Card padding="lg">
          <p className="text-sm text-text-muted">{tw("automations.detail.noSlots")}</p>
        </Card>
      ) : (
        <Tabs defaultValue="calendar">
          <TabsList aria-label={tw("automations.view.label")}>
            <TabsTrigger value="calendar">{tw("automations.view.calendar")}</TabsTrigger>
            <TabsTrigger value="grid">{tw("automations.view.grid")}</TabsTrigger>
          </TabsList>
          <TabsContent value="calendar" className="pt-4">
            <SlotCalendar
              slots={slots}
              timezone={a.timezone}
              startDate={a.startDate}
              durationWeeks={a.durationWeeks}
              onOpen={setOpen}
            />
          </TabsContent>
          <TabsContent value="grid" className="pt-4">
            <SlotGrid
              slots={slots}
              timezone={a.timezone}
              startDate={a.startDate}
              durationWeeks={a.durationWeeks}
              onOpen={setOpen}
            />
          </TabsContent>
        </Tabs>
      )}

      <SlotDialog
        automation={a}
        slot={open === null ? null : (slots?.find((s) => s.id === open.id) ?? open)}
        onClose={() => {
          setOpen(null);
        }}
      />
      <LaunchDialog
        automation={a}
        open={launchOpen}
        onClose={() => {
          setLaunchOpen(false);
        }}
      />
      <Dialog
        open={confirm !== null}
        onClose={() => {
          setConfirm(null);
        }}
        size="sm"
      >
        <DialogHeader>
          <DialogTitle>
            {confirm === "cancel"
              ? tw("automations.confirm.cancel.title")
              : tw("automations.confirm.delete.title")}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-text-muted">
            {confirm === "cancel"
              ? tw("automations.confirm.cancel.body")
              : tw("automations.confirm.delete.body")}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => {
              setConfirm(null);
            }}
          >
            {tw("automations.confirm.keep")}
          </Button>
          <Button
            variant="danger"
            loading={cancel.isPending || del.isPending}
            onClick={() => {
              if (confirm === "cancel") {
                cancel
                  .mutateAsync()
                  .then(() => {
                    setConfirm(null);
                    toast({ title: tw("automations.toast.cancelled"), tone: "success" });
                  })
                  .catch((e: unknown) => {
                    setConfirm(null);
                    fail(e);
                  });
              } else {
                del
                  .mutateAsync(a.id)
                  .then(() => {
                    router.push(ROUTES.automations);
                  })
                  .catch((e: unknown) => {
                    setConfirm(null);
                    fail(e);
                  });
              }
            }}
          >
            {confirm === "cancel"
              ? tw("automations.detail.cancel")
              : tw("automations.detail.delete")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="flex flex-col rounded-lg bg-surface-sunken p-2">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="text-base font-semibold text-text">
        {new Intl.NumberFormat("en", { notation: "compact" }).format(value)}
      </dd>
    </div>
  );
}
