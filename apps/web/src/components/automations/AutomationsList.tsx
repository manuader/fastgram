"use client";

import { Badge, EmptyState, ErrorState, Skeleton } from "@fastgram/ui";
import type { Automation } from "@fastgram/contracts";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { PlusIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { NETWORK_LABEL } from "@/lib/calendar/board";
import { useAutomations } from "@/lib/automations/api";
import {
  AUTOMATION_STATUS_COPY,
  AUTOMATION_STATUS_TONE,
  dayLabel,
  progressOf,
} from "@/lib/automations/present";

export const automationHref = (id: string): string =>
  `${ROUTES.automations}/${encodeURIComponent(id)}`;

/**
 * `/automations` — las campañas de la marca, con su estado y su progreso
 * (`FR-150`). Estados: cargando, vacío (invita a crear), error, lista.
 */
export function AutomationsList() {
  const list = useAutomations();
  const reduce = useReducedMotion();

  if (list.isPending) {
    return (
      <div
        className="flex flex-col gap-3"
        aria-busy="true"
        aria-label={tw("common.loading")}
      >
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (list.isError) {
    return (
      <ErrorState
        title={tw("automations.list.error")}
        onRetry={() => {
          void list.refetch();
        }}
      />
    );
  }
  if (list.data.length === 0) {
    return (
      <EmptyState
        title={tw("automations.empty.title")}
        description={tw("automations.empty.description")}
        action={<NewAutomationButton />}
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3" aria-label={tw("automations.list.label")}>
      {list.data.map((a, index) => (
        <motion.li
          key={a.id}
          initial={reduce === true ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            type: "spring",
            stiffness: 420,
            damping: 34,
            delay: index * 0.03,
          }}
        >
          <AutomationRow automation={a} />
        </motion.li>
      ))}
    </ul>
  );
}

function AutomationRow({ automation: a }: { readonly automation: Automation }) {
  const progress = progressOf(a);
  return (
    <Link
      href={automationHref(a.id)}
      className="fg-focusable block rounded-xl border border-border bg-surface p-4 transition-colors hover:bg-surface-sunken"
      data-testid="automation-row"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-base font-semibold text-text">{a.name}</span>
          <span className="text-sm text-text-muted">
            {tw("automations.row.meta", {
              start: dayLabel(a.startDate),
              weeks: a.durationWeeks,
              perDay: a.perAccountPerDay,
            })}
          </span>
        </div>
        <Badge tone={AUTOMATION_STATUS_TONE[a.status]} dot>
          {tw(AUTOMATION_STATUS_COPY[a.status])}
        </Badge>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {a.accounts.map((acc) => (
          <Badge key={acc.platform} tone="outline" size="sm">
            {NETWORK_LABEL[acc.platform as keyof typeof NETWORK_LABEL] ?? acc.platform}
          </Badge>
        ))}
      </div>
      {progress.total > 0 && (
        <div className="mt-3 flex items-center gap-3">
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken"
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
          <span className="text-xs text-text-muted">
            {tw(progress.label, { done: progress.done, total: progress.total })}
          </span>
        </div>
      )}
    </Link>
  );
}

/** El botón de la cabecera: `New automation`. */
export function NewAutomationButton() {
  return (
    <Link href={ROUTES.automationsNew} className="fg-btn fg-btn--primary fg-btn--md">
      <PlusIcon size={16} />
      {tw("automations.new")}
    </Link>
  );
}
