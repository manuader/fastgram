"use client";

import { Badge, cn } from "@fastgram/ui";
import type { AutomationSlot } from "@fastgram/contracts";
import { motion, useReducedMotion } from "motion/react";
import { tw } from "@/lib/i18n/t";
import { dayKeyOf } from "@/lib/calendar/calendar";
import {
  CONTENT_TYPE_COPY,
  SLOT_STATUS_COPY,
  SLOT_STATUS_TONE,
  campaignWeeks,
  shortDayLabel,
  slotFailureCopy,
  slotTime,
  slotsByDay,
} from "@/lib/automations/present";

interface ViewProps {
  readonly slots: readonly AutomationSlot[];
  readonly timezone: string;
  readonly startDate: string;
  readonly durationWeeks: number;
  readonly onOpen: (slot: AutomationSlot) => void;
}

/**
 * `Calendar view` — `F-220`. Una fila por semana de la campaña, una columna
 * por día (en la zona de la campaña), y en cada día sus slots por hora. Un
 * día sin slots dice que no hay nada (una hora vencida no se generó).
 */
export function SlotCalendar({
  slots,
  timezone,
  startDate,
  durationWeeks,
  onOpen,
}: ViewProps) {
  const byDay = slotsByDay(slots, timezone);
  const weeks = campaignWeeks(startDate, durationWeeks);
  return (
    <div className="flex flex-col gap-4" data-testid="slot-calendar">
      {weeks.map((days, w) => (
        <section key={days[0]} aria-label={tw("automations.view.week", { n: w + 1 })}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {tw("automations.view.week", { n: w + 1 })}
          </h3>
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-7">
            {days.map((day) => {
              const list = byDay.get(day) ?? [];
              return (
                <li
                  key={day}
                  className="flex min-h-[112px] flex-col gap-1.5 rounded-lg border border-border bg-surface p-2"
                >
                  <span className="text-xs font-medium text-text-muted">
                    {shortDayLabel(day)}
                  </span>
                  {list.length === 0 ? (
                    <span className="text-xs text-text-muted">
                      {tw("automations.view.noPosts")}
                    </span>
                  ) : (
                    list.map((slot) => (
                      <SlotChip
                        key={slot.id}
                        slot={slot}
                        timezone={timezone}
                        onOpen={onOpen}
                      />
                    ))
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

function SlotChip({
  slot,
  timezone,
  onOpen,
}: {
  readonly slot: AutomationSlot;
  readonly timezone: string;
  readonly onOpen: (slot: AutomationSlot) => void;
}) {
  const muted =
    slot.status === "CANCELLED" ||
    slot.status === "FAILED_GEN" ||
    slot.status === "FAILED";
  return (
    <button
      type="button"
      onClick={() => {
        onOpen(slot);
      }}
      className={cn(
        "fg-focusable flex flex-col items-start gap-0.5 rounded-md border border-border px-2 py-1 text-left text-xs hover:bg-surface-sunken",
        muted && "opacity-60",
      )}
      aria-label={tw("automations.view.openSlot", {
        time: slotTime(slot, timezone),
        type: tw(CONTENT_TYPE_COPY[slot.contentType]),
        status: tw(SLOT_STATUS_COPY[slot.status]),
      })}
    >
      <span className="font-semibold text-text">{slotTime(slot, timezone)}</span>
      <span className="text-text-muted">{tw(CONTENT_TYPE_COPY[slot.contentType])}</span>
      <Badge tone={SLOT_STATUS_TONE[slot.status]} size="sm" dot>
        {tw(SLOT_STATUS_COPY[slot.status])}
      </Badge>
    </button>
  );
}

/** `Grid view` — `F-220`. Una tarjeta por slot, con la media y la copy. */
export function SlotGrid({ slots, timezone, onOpen }: ViewProps) {
  const reduce = useReducedMotion();
  const sorted = [...slots].sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
  return (
    <ul
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      data-testid="slot-grid"
    >
      {sorted.map((slot, i) => {
        const failure = slotFailureCopy(slot);
        return (
          <motion.li
            key={slot.id}
            initial={reduce === true ? false : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.18, delay: Math.min(i, 12) * 0.02 }}
          >
            <button
              type="button"
              onClick={() => {
                onOpen(slot);
              }}
              className="fg-focusable flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-surface text-left hover:bg-surface-sunken"
            >
              <SlotPreview slot={slot} className="aspect-[4/5] w-full" />
              <div className="flex flex-1 flex-col gap-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={SLOT_STATUS_TONE[slot.status]} size="sm" dot>
                    {tw(SLOT_STATUS_COPY[slot.status])}
                  </Badge>
                  <Badge tone="outline" size="sm">
                    {tw(CONTENT_TYPE_COPY[slot.contentType])}
                  </Badge>
                </div>
                <span className="text-xs text-text-muted">
                  {slot.scheduledAt === null
                    ? "—"
                    : `${shortDayLabel(dayKeyOf(slot.scheduledAt, timezone))} · ${slotTime(slot, timezone)}`}
                </span>
                {slot.generatedText !== null ? (
                  <p className="line-clamp-3 text-sm text-text">{slot.generatedText}</p>
                ) : failure !== null ? (
                  <p className="text-sm text-danger">{tw(failure)}</p>
                ) : (
                  <p className="text-sm text-text-muted">
                    {tw(SLOT_STATUS_COPY[slot.status])}
                  </p>
                )}
              </div>
            </button>
          </motion.li>
        );
      })}
    </ul>
  );
}

/** La media que abre la pieza, o un placeholder mientras no hay. */
export function SlotPreview({
  slot,
  className,
}: {
  readonly slot: AutomationSlot;
  readonly className?: string;
}) {
  if (slot.preview === null) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-surface-sunken text-xs text-text-muted",
          className,
        )}
        aria-hidden="true"
      >
        {tw(CONTENT_TYPE_COPY[slot.contentType])}
      </div>
    );
  }
  return slot.preview.kind === "image" ? (
    // `<img>`: mismo motivo que `ContentCard` (hosts no declarados en Next).
    <img
      src={slot.preview.url}
      alt=""
      className={cn("object-cover", className)}
      loading="lazy"
    />
  ) : (
    <video
      src={slot.preview.url}
      className={cn("object-cover", className)}
      muted
      playsInline
      preload="metadata"
    />
  );
}
