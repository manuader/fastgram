"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { CalendarCounts, CalendarItem } from "@fastgram/contracts";
import { buttonVariants, Button, EmptyState } from "@fastgram/ui";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PostEditDialog } from "@/components/schedule/PostEditDialog";
import { CalendarOpenContext } from "./CalendarChip";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import {
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InboxIcon,
} from "@/icons";
import {
  dragIdOf,
  dropIdOf,
  itemsByDay,
  monthRange,
  queryRange,
  resolveDrop,
  shiftDay,
  weekDays,
  weekRange,
  weekStartOf,
  type BrandScope,
  type CalendarViewMode,
  type DayRange,
} from "@/lib/calendar/board";
import {
  browserTimeZone,
  dayKeyOf,
  formatDayLabel,
  formatMonthTitle,
  monthGrid,
  shiftMonth,
  type YearMonth,
} from "@/lib/calendar/calendar";
import { useCalendar, useMoveCalendarItem } from "@/lib/calendar/data";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { CalendarChip } from "./CalendarChip";

export interface CalendarViewProps {
  /**
   * La zona del navegador. Es una prop para que los tests la fijen sin
   * depender de la máquina que los corre.
   */
  readonly timeZone?: string;
  /** "Ahora", en ms. Decide el período con el que abre y qué día es hoy. */
  readonly now?: number;
  readonly initialView?: CalendarViewMode;
}

/** Las siete columnas, domingo primero (PRD:1657). */
const WEEKDAYS: readonly { short: CopyKey; long: CopyKey }[] = [
  { short: "calendar.weekday.su", long: "calendar.weekday.sunday" },
  { short: "calendar.weekday.mo", long: "calendar.weekday.monday" },
  { short: "calendar.weekday.tu", long: "calendar.weekday.tuesday" },
  { short: "calendar.weekday.we", long: "calendar.weekday.wednesday" },
  { short: "calendar.weekday.th", long: "calendar.weekday.thursday" },
  { short: "calendar.weekday.fr", long: "calendar.weekday.friday" },
  { short: "calendar.weekday.sa", long: "calendar.weekday.saturday" },
];

interface Clock {
  readonly timeZone: string;
  readonly now: number;
}

/**
 * La zona y "ahora", resueltos **después de montar** si no vienen por prop:
 * resolverlos en el render del servidor haría que, en los bordes de día, el
 * HTML del servidor y el del navegador no coincidan y React tire la
 * hidratación. Hasta entonces la vista está en `loading`.
 */
function useClock(timeZone: string | undefined, now: number | undefined): Clock | null {
  const [resolved, setResolved] = useState<Clock | null>(
    timeZone !== undefined && now !== undefined ? { timeZone, now } : null,
  );
  useEffect(() => {
    if (resolved !== null) return;
    setResolved({ timeZone: timeZone ?? browserTimeZone(), now: now ?? Date.now() });
  }, [resolved, timeZone, now]);
  return resolved;
}

function monthOfKey(key: string): YearMonth {
  const [year, month] = key.split("-").map(Number);
  return { year: year ?? 1970, month: month ?? 1 };
}

const weekTitleFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function formatShortDay(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return weekTitleFormat.format(
    new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)),
  );
}

/**
 * `/calendar` · FR-110 + `PU-CAL-002`: vistas semana y mes, chips por red con
 * color, hora y miniatura, **arrastrar para mover**, y filtro "esta marca /
 * todas las marcas".
 *
 * Los estados de FR-110 (PRD:1664): default · loading · empty · error, con el
 * orden de ramas de la Library: un fallo de red y un período vacío se dibujan
 * igual —una grilla sin chips— y significan lo contrario.
 *
 * ## La zona en la que se dibuja
 *
 * "Esta marca" dibuja en la zona **de la marca** (la de su estrategia: es la
 * de las ventanas del auto-slot, así un post de las 09:00 cae a las 09:00).
 * "Todas las marcas" dibuja en la del navegador, porque cada marca puede
 * tener otra. La pantalla dice cuál está usando.
 *
 * ## Arrastrar
 *
 * Soltar en otro día conserva la hora local (`movedInstant`). Lo que ya salió
 * no se arrastra; la API igual lo rechazaría (409) y el chip vuelve a su lugar.
 * Con teclado: foco en el chip, espacio, flechas, espacio (dnd-kit).
 */
export function CalendarView({
  timeZone,
  now,
  initialView = "month",
}: CalendarViewProps) {
  const clock = useClock(timeZone, now);
  const [view, setView] = useState<CalendarViewMode>(initialView);
  const [scope, setScope] = useState<BrandScope>("current");
  const [anchor, setAnchor] = useState<string | null>(null);

  const today = clock === null ? null : dayKeyOf(clock.now, clock.timeZone);
  const focusDay = anchor ?? today;

  const days: DayRange | null =
    focusDay === null
      ? null
      : view === "month"
        ? monthRange(monthOfKey(focusDay))
        : weekRange(weekStartOf(focusDay));
  const range = days === null || clock === null ? null : queryRange(days, clock.timeZone);

  const calendar = useCalendar(scope, range);
  const move = useMoveCalendarItem();

  const brand = scope === "current" ? calendar.data?.brands[0] : undefined;
  const displayZone = brand?.timezone ?? clock?.timeZone ?? "UTC";

  const items = calendar.data?.items;
  const byDay = useMemo(() => itemsByDay(items ?? [], displayZone), [items, displayZone]);
  const byDragId = useMemo(
    () => new Map((items ?? []).map((item) => [dragIdOf(item), item] as const)),
    [items],
  );

  const sensors = useSensors(
    // Una distancia mínima para que un click no sea un arrastre.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );
  // Sprint 7: click en un post → editar caption / hora, reintentar si falló.
  const [editing, setEditing] = useState<CalendarItem | null>(null);

  if (clock === null || focusDay === null || days === null) {
    return <section className="fgw-calendar" aria-busy="true" />;
  }

  const onDragEnd = (event: DragEndEvent): void => {
    const request = resolveDrop({
      item: byDragId.get(String(event.active.id)),
      overId: event.over === null ? null : String(event.over.id),
      timeZone: displayZone,
      now: clock.now,
    });
    if (request !== null) move.mutate(request);
  };

  const loading = calendar.isPending;
  const failed = calendar.isError;
  const title =
    view === "month"
      ? formatMonthTitle(monthOfKey(focusDay))
      : tw("calendar.weekTitle", {
          start: formatShortDay(days.first),
          end: formatShortDay(days.last),
        });

  const visibleCount = countVisible(byDay, days);
  const step = (delta: number): void => {
    setAnchor(
      view === "month"
        ? (() => {
            const next = shiftMonth(monthOfKey(focusDay), delta);
            return `${String(next.year)}-${String(next.month).padStart(2, "0")}-01`;
          })()
        : shiftDay(focusDay, 7 * delta),
    );
  };

  return (
    <section className="fgw-calendar" aria-busy={loading ? "true" : "false"}>
      <div className="fgw-calendar__bar">
        <div className="fgw-calendar__nav">
          <Button
            variant="ghost"
            size="icon"
            aria-label={tw(view === "month" ? "calendar.prevMonth" : "calendar.prevWeek")}
            onClick={() => {
              step(-1);
            }}
          >
            <ChevronLeftIcon size={18} />
          </Button>
          <h2 className="fgw-calendar__title" aria-live="polite">
            {title}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label={tw(view === "month" ? "calendar.nextMonth" : "calendar.nextWeek")}
            onClick={() => {
              step(1);
            }}
          >
            <ChevronRightIcon size={18} />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Toggle
            label={tw("calendar.view.label")}
            options={[
              { value: "week", label: tw("calendar.view.week") },
              { value: "month", label: tw("calendar.view.month") },
            ]}
            value={view}
            onChange={(next) => {
              setView(next);
            }}
          />
          <Toggle
            label={tw("calendar.scope.label")}
            options={[
              { value: "current", label: tw("calendar.scope.current") },
              { value: "all", label: tw("calendar.scope.all") },
            ]}
            value={scope}
            onChange={(next) => {
              setScope(next);
            }}
          />
        </div>

        {calendar.data !== undefined && <HeaderCounters counts={calendar.data.counts} />}
      </div>

      <p className="fgw-calendar__note">
        {brand === undefined
          ? tw("calendar.timeZone", { zone: displayZone })
          : tw("calendar.timeZoneBrand", { brand: brand.name, zone: displayZone })}{" "}
        {tw("calendar.dragHint")} {tw("calendar.keyboardHint")}
      </p>
      {calendar.data?.truncated === true && (
        <p className="fgw-calendar__note" role="note">
          {tw("calendar.rangeTruncated")}
        </p>
      )}
      {move.isError && (
        <p className="fgw-calendar__note text-danger" role="alert">
          {tw("calendar.moveFailed")}
        </p>
      )}

      {failed ? (
        <ApiErrorState
          error={calendar.error}
          onRetry={() => {
            void calendar.refetch();
          }}
        />
      ) : (
        <>
          <CalendarOpenContext.Provider value={setEditing}>
            <DndContext sensors={sensors} onDragEnd={onDragEnd}>
              {view === "month" ? (
                <MonthGrid
                  month={monthOfKey(focusDay)}
                  caption={title}
                  byDay={loading ? new Map() : byDay}
                  today={dayKeyOf(clock.now, displayZone)}
                  timeZone={displayZone}
                  showBrand={scope === "all"}
                />
              ) : (
                <WeekGrid
                  start={days.first}
                  caption={title}
                  byDay={loading ? new Map() : byDay}
                  today={dayKeyOf(clock.now, displayZone)}
                  timeZone={displayZone}
                  showBrand={scope === "all"}
                />
              )}
            </DndContext>
          </CalendarOpenContext.Provider>

          {!loading && visibleCount === 0 && (
            <EmptyState
              bordered
              title={tw("calendar.empty.title")}
              description={
                view === "month"
                  ? tw("calendar.empty.description", { month: title })
                  : tw("calendar.empty.weekDescription")
              }
              action={
                <Link href={ROUTES.content} className={buttonVariants()}>
                  {tw("posts.empty.action")}
                </Link>
              }
            />
          )}
        </>
      )}
      <PostEditDialog
        open={editing !== null}
        postId={editing?.id ?? null}
        timeZone={displayZone}
        onClose={() => {
          setEditing(null);
        }}
        {...(editing === null ? {} : { brandId: editing.brandId })}
      />
    </section>
  );
}

function countVisible(
  byDay: ReadonlyMap<string, readonly CalendarItem[]>,
  days: DayRange,
): number {
  let total = 0;
  for (const [key, bucket] of byDay) {
    if (key >= days.first && key <= days.last) total += bucket.length;
  }
  return total;
}

interface ToggleProps<T extends string> {
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}

/** Botones segmentados con `aria-pressed`: dos opciones no merecen un `<select>`. */
function Toggle<T extends string>({ label, options, value, onChange }: ToggleProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-md border border-border"
    >
      {options.map((option) => (
        <Button
          key={option.value}
          variant={option.value === value ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={option.value === value}
          onClick={() => {
            onChange(option.value);
          }}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** `✓ 36` · `📥 0` · `📅 19` (PRD:1655). Globales, de las marcas incluidas. */
function HeaderCounters({ counts }: { readonly counts: CalendarCounts }) {
  const entries = [
    {
      key: "posted",
      icon: <CheckIcon size={16} />,
      value: counts.posted,
      copy: "calendar.counter.posted",
    },
    {
      key: "inbox",
      icon: <InboxIcon size={16} />,
      value: counts.inbox,
      copy: "calendar.counter.inbox",
    },
    {
      key: "scheduled",
      icon: <CalendarIcon size={16} />,
      value: counts.scheduled,
      copy: "calendar.counter.scheduled",
    },
  ] as const;
  return (
    <ul className="fgw-calendar__counters" aria-label={tw("calendar.counters.label")}>
      {entries.map((entry) => {
        const label = tw(entry.copy, { count: String(entry.value) });
        return (
          <li
            key={entry.key}
            className="fgw-calendar__counter"
            data-counter={entry.key}
            title={label}
          >
            {entry.icon}
            <span aria-hidden="true" className="fgw-calendar__counter-value">
              {entry.value}
            </span>
            <span className="fg-visually-hidden">{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

interface GridProps {
  readonly caption: string;
  readonly byDay: ReadonlyMap<string, readonly CalendarItem[]>;
  readonly today: string;
  readonly timeZone: string;
  readonly showBrand: boolean;
}

function WeekdayHeader() {
  return (
    <thead>
      <tr>
        {WEEKDAYS.map((weekday) => (
          <th key={weekday.short} scope="col" abbr={tw(weekday.long)}>
            {tw(weekday.short)}
          </th>
        ))}
      </tr>
    </thead>
  );
}

/**
 * La cuadrícula del mes, como `<table>` y no `role="grid"`: ver el porqué en la
 * historia de este archivo (un `grid` promete navegación con flechas que no
 * hay). Cada día es una zona donde soltar.
 */
function MonthGrid({ month, ...grid }: GridProps & { readonly month: YearMonth }) {
  const weeks = monthGrid(month);
  return (
    <div className="fgw-calendar__scroll">
      <table className="fgw-calendar__grid">
        <caption className="fg-visually-hidden">{grid.caption}</caption>
        <WeekdayHeader />
        <tbody>
          {weeks.map((week, row) => (
            <tr key={row}>
              {week.map((cell, column) =>
                cell === null ? (
                  <td key={`pad-${String(column)}`} className="fgw-calendar__pad" />
                ) : (
                  <DayCell
                    key={cell.key}
                    dayKey={cell.key}
                    label={String(cell.day)}
                    {...grid}
                    roomy={false}
                  />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** La semana: una fila de siete días más altos, con miniaturas. */
function WeekGrid({ start, ...grid }: GridProps & { readonly start: string }) {
  return (
    <div className="fgw-calendar__scroll">
      <table className="fgw-calendar__grid">
        <caption className="fg-visually-hidden">{grid.caption}</caption>
        <WeekdayHeader />
        <tbody>
          <tr>
            {weekDays(start).map((key) => (
              <DayCell
                key={key}
                dayKey={key}
                label={formatShortDay(key)}
                {...grid}
                roomy
              />
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

interface DayCellProps extends GridProps {
  readonly dayKey: string;
  readonly label: string;
  readonly roomy: boolean;
}

function DayCell({
  dayKey,
  label,
  byDay,
  today,
  timeZone,
  showBrand,
  roomy,
}: DayCellProps) {
  const { setNodeRef, isOver } = useDroppable({ id: dropIdOf(dayKey) });
  const dayItems = byDay.get(dayKey) ?? [];
  const isToday = dayKey === today;
  return (
    <td
      ref={setNodeRef}
      className="fgw-calendar__day"
      data-day={dayKey}
      data-today={isToday ? "true" : undefined}
      data-over={isOver ? "true" : undefined}
      aria-current={isToday ? "date" : undefined}
      style={{
        ...(roomy ? { height: "22rem" } : {}),
        ...(isOver
          ? { outline: "2px solid var(--fg-color-accent)", outlineOffset: "-2px" }
          : {}),
      }}
    >
      <div className="fgw-calendar__day-head">
        <span className="fg-visually-hidden">
          {dayLabel(dayKey, dayItems.length, isToday)}
        </span>
        <span aria-hidden="true" className="fgw-calendar__day-number">
          {label}
        </span>
        {dayItems.length > 0 && (
          <span aria-hidden="true" className="fgw-calendar__day-count">
            {dayItems.length === 1
              ? tw("calendar.dayCountOne")
              : tw("calendar.dayCount", { count: dayItems.length })}
          </span>
        )}
      </div>
      {dayItems.length > 0 && (
        <ChipList>
          {dayItems.map((item) => (
            <CalendarChip
              key={dragIdOf(item)}
              item={item}
              timeZone={timeZone}
              showBrand={showBrand}
              roomy={roomy}
            />
          ))}
        </ChipList>
      )}
    </td>
  );
}

function ChipList({ children }: { readonly children: ReactNode }) {
  return <ul className="fgw-calendar__chips">{children}</ul>;
}

function dayLabel(key: string, count: number, isToday: boolean): string {
  const date = formatDayLabel(key);
  const label =
    count === 0
      ? tw("calendar.dayLabelNone", { date })
      : count === 1
        ? tw("calendar.dayLabelOne", { date })
        : tw("calendar.dayLabel", { date, count });
  return isToday ? tw("calendar.dayLabelToday", { label }) : label;
}
