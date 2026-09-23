"use client";

import { buttonVariants, Button, EmptyState } from "@fastgram/ui";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import {
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InboxIcon,
} from "@/icons";
import {
  browserTimeZone,
  countInMonth,
  dayKeyOf,
  formatChipTime,
  formatDayLabel,
  formatMonthTitle,
  groupByDay,
  headerCounts,
  monthGrid,
  monthOf,
  PLATFORM_CHIP_TONE,
  postInstant,
  shiftMonth,
  type HeaderCounts,
  type YearMonth,
} from "@/lib/calendar/calendar";
import {
  CALENDAR_MAX_PAGES,
  CALENDAR_PAGE_LIMIT,
  useCalendarContentTypes,
  useCalendarPosts,
} from "@/lib/calendar/data";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { CONTENT_TYPE_COPY } from "@/lib/library/content";
import {
  POST_PLATFORM_COPY,
  POST_STATUS_COPY,
  POST_STATUS_TONE,
} from "@/lib/library/posts";
import { ROUTES } from "@/lib/nav/routes";
import type { ContentType, Post } from "@fastgram/contracts";

export interface CalendarViewProps {
  /**
   * La zona IANA en la que se reparten los días. Por defecto, la del navegador
   * (ver `lib/calendar/calendar.ts`). Es una prop para que los tests fijen la
   * zona sin depender de la máquina que los corre.
   */
  readonly timeZone?: string;
  /** "Ahora", en ms. Decide el mes con el que abre y qué día es hoy. */
  readonly now?: number;
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
 * La zona y "ahora", resueltos **después de montar** si no vienen por prop.
 *
 * El servidor también renderiza este client component, con su propia zona y su
 * propio reloj. Resolverlos en el primer render haría que, en los bordes —un
 * post de las 23:30, o el último día del mes—, el HTML del servidor y el del
 * navegador no coincidan, y React tire la hidratación. Hasta que se resuelven,
 * la vista está en `loading`.
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

/**
 * `/calendar` · F-140 (vista mes), F-141 (chips), F-142 (contador por día),
 * F-143 (contadores de cabecera). FR-110 (PRD:1653-1668).
 *
 * Los estados de FR-110 (PRD:1664): default · loading · empty (mes sin posts) ·
 * error. Con el mismo orden de ramas que la Library, por la misma razón: un
 * fallo de red y un mes vacío se dibujan igual —una cuadrícula sin chips— y
 * significan lo contrario. `No posts` después de un timeout le dice a alguien
 * que no tiene nada programado.
 *
 * ## Lo que no está
 *
 * - **Click en un chip → detalle del post.** FR-110 lo marca INFERRED y no hay
 *   pantalla de detalle de post en la app. El chip no es un control: uno que
 *   parece clicable y no hace nada es peor.
 * - **Icono de plataforma** (PRD:1659). La app no tiene iconos de marca
 *   (`icons/index.tsx` es SVG a mano, sin `lucide-react` ni logos). El chip
 *   lleva el nombre y el color de la plataforma; falta el logo.
 * - **El alternador de vista** (F-144) es otra tarea.
 */
export function CalendarView({ timeZone, now }: CalendarViewProps) {
  const clock = useClock(timeZone, now);
  const [shown, setShown] = useState<YearMonth | null>(null);

  const posts = useCalendarPosts();
  const types = useCalendarContentTypes();

  const month = shown ?? (clock === null ? null : monthOf(clock.now, clock.timeZone));

  const byDay = useMemo(
    () =>
      clock === null
        ? new Map<string, readonly Post[]>()
        : groupByDay(posts.items, clock.timeZone),
    [posts.items, clock],
  );

  if (clock === null || month === null) {
    return <section className="fgw-calendar" aria-busy="true" />;
  }

  const firstLoadFailed = posts.error !== null && posts.items.length === 0;
  const loading = !firstLoadFailed && (posts.pending || posts.collecting);
  const settled = !posts.pending && !posts.collecting;
  const monthTitle = formatMonthTitle(month);
  const today = dayKeyOf(clock.now, clock.timeZone);
  const monthCount = countInMonth(byDay, month);
  const lowerBound = posts.truncated || posts.error !== null;

  const missingType = posts.items.some((post) => !types.typeOf.has(post.contentId));

  return (
    <section className="fgw-calendar" aria-busy={loading ? "true" : "false"}>
      <div className="fgw-calendar__bar">
        <div className="fgw-calendar__nav">
          <Button
            variant="ghost"
            size="icon"
            aria-label={tw("calendar.prevMonth")}
            onClick={() => {
              setShown(shiftMonth(month, -1));
            }}
          >
            <ChevronLeftIcon size={18} />
          </Button>
          {/* `aria-live`: el cambio de mes no mueve el foco —se queda en el
              botón, para poder pulsarlo otra vez—, así que sin esto quien no ve
              la pantalla no se entera de a qué mes llegó. */}
          <h2 className="fgw-calendar__title" aria-live="polite">
            {monthTitle}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label={tw("calendar.nextMonth")}
            onClick={() => {
              setShown(shiftMonth(month, 1));
            }}
          >
            <ChevronRightIcon size={18} />
          </Button>
        </div>

        {settled && !firstLoadFailed && (
          <HeaderCounters counts={headerCounts(posts.items)} lowerBound={lowerBound} />
        )}
      </div>

      <p className="fgw-calendar__note">
        {tw("calendar.timeZone", { zone: clock.timeZone })}
      </p>
      {posts.truncated && (
        <p className="fgw-calendar__note" role="note">
          {tw("calendar.truncated", { count: CALENDAR_MAX_PAGES * CALENDAR_PAGE_LIMIT })}
        </p>
      )}
      {/* Sólo cuando ya no puede llegar: mientras el contenido se pide, un
          tipo que falta es un tipo que todavía no llegó. */}
      {settled && !types.loading && missingType && (
        <p className="fgw-calendar__note">{tw("calendar.typesPartial")}</p>
      )}

      {firstLoadFailed ? (
        <ApiErrorState error={posts.error} onRetry={posts.retry} />
      ) : (
        <>
          <MonthGrid
            month={month}
            monthTitle={monthTitle}
            byDay={loading ? new Map() : byDay}
            today={today}
            timeZone={clock.timeZone}
            typeOf={types.typeOf}
          />

          {/* El error de una página que no es la primera no tapa lo que ya
              está: los posts cargados siguen siendo ciertos. Los contadores
              pasan a "al menos". */}
          {posts.error !== null && (
            <ApiErrorState error={posts.error} onRetry={posts.retry} />
          )}

          {settled && posts.error === null && monthCount === 0 && (
            <EmptyState
              bordered
              title={tw("calendar.empty.title")}
              description={tw(
                posts.truncated
                  ? "calendar.empty.truncatedDescription"
                  : "calendar.empty.description",
                { month: monthTitle },
              )}
              action={
                <Link href={ROUTES.content} className={buttonVariants()}>
                  {tw("posts.empty.action")}
                </Link>
              }
            />
          )}
        </>
      )}
    </section>
  );
}

interface HeaderCountersProps {
  readonly counts: HeaderCounts;
  /** La lista está cortada o incompleta: cada número es un mínimo. */
  readonly lowerBound: boolean;
}

/** `✓ 36` · `📥 0` · `📅 19` (PRD:1655). */
function HeaderCounters({ counts, lowerBound }: HeaderCountersProps) {
  const items = [
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
      {items.map((item) => {
        const count = lowerBound
          ? tw("calendar.counter.atLeast", { count: item.value })
          : String(item.value);
        const label = tw(item.copy, { count });
        return (
          <li
            key={item.key}
            className="fgw-calendar__counter"
            data-counter={item.key}
            title={label}
          >
            {item.icon}
            <span aria-hidden="true" className="fgw-calendar__counter-value">
              {item.value}
              {lowerBound ? "+" : ""}
            </span>
            <span className="fg-visually-hidden">{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

interface MonthGridProps {
  readonly month: YearMonth;
  readonly monthTitle: string;
  readonly byDay: ReadonlyMap<string, readonly Post[]>;
  readonly today: string;
  readonly timeZone: string;
  readonly typeOf: ReadonlyMap<string, ContentType>;
}

/**
 * La cuadrícula, como `<table>` y no como `role="grid"`.
 *
 * Un `grid` de ARIA promete navegación con flechas entre celdas —y quien usa
 * lector de pantalla la intenta—; sin implementarla, el rol miente. Una tabla
 * da gratis lo que sí hace falta: cabeceras de columna que se anuncian al
 * cambiar de celda (`Tuesday`) y filas por semana.
 */
function MonthGrid({
  month,
  monthTitle,
  byDay,
  today,
  timeZone,
  typeOf,
}: MonthGridProps) {
  const weeks = monthGrid(month);
  return (
    <div className="fgw-calendar__scroll">
      <table className="fgw-calendar__grid">
        <caption className="fg-visually-hidden">{monthTitle}</caption>
        <thead>
          <tr>
            {WEEKDAYS.map((weekday) => (
              <th key={weekday.short} scope="col" abbr={tw(weekday.long)}>
                {tw(weekday.short)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, row) => (
            <tr key={row}>
              {week.map((cell, column) => {
                if (cell === null) {
                  return (
                    <td key={`pad-${String(column)}`} className="fgw-calendar__pad" />
                  );
                }
                const dayPosts = byDay.get(cell.key) ?? [];
                const isToday = cell.key === today;
                return (
                  <td
                    key={cell.key}
                    className="fgw-calendar__day"
                    data-day={cell.key}
                    data-today={isToday ? "true" : undefined}
                    aria-current={isToday ? "date" : undefined}
                  >
                    <div className="fgw-calendar__day-head">
                      <span className="fg-visually-hidden">
                        {dayLabel(cell.key, dayPosts.length, isToday)}
                      </span>
                      <span aria-hidden="true" className="fgw-calendar__day-number">
                        {cell.day}
                      </span>
                      {dayPosts.length > 0 && (
                        <span aria-hidden="true" className="fgw-calendar__day-count">
                          {dayPosts.length === 1
                            ? tw("calendar.dayCountOne")
                            : tw("calendar.dayCount", { count: dayPosts.length })}
                        </span>
                      )}
                    </div>
                    {dayPosts.length > 0 && (
                      <ul className="fgw-calendar__chips">
                        {dayPosts.map((post) => (
                          <PostChip
                            key={post._id}
                            post={post}
                            timeZone={timeZone}
                            type={typeOf.get(post.contentId)}
                          />
                        ))}
                      </ul>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

interface PostChipProps {
  readonly post: Post;
  readonly timeZone: string;
  readonly type: ContentType | undefined;
}

/**
 * Un chip · F-141 (PRD:609, 1659): punto de estado + `Plataforma: Tipo` + hora,
 * con fondo tintado por plataforma.
 *
 * Sin tipo cuando la pieza no llegó en las páginas de `GET /content` (ver
 * `lib/calendar/data.ts`): se escribe sólo la plataforma, no un tipo deducido.
 */
function PostChip({ post, timeZone, type }: PostChipProps) {
  const platform = tw(POST_PLATFORM_COPY[post.platform]);
  const title =
    type === undefined
      ? platform
      : tw("calendar.chip.withType", { platform, type: tw(CONTENT_TYPE_COPY[type]) });
  const time = formatChipTime(postInstant(post), timeZone);
  const status = tw(POST_STATUS_COPY[post.status]);

  return (
    <li
      className="fgw-cal-chip"
      data-tone={PLATFORM_CHIP_TONE[post.platform]}
      data-status={post.status}
      title={tw("calendar.chip.label", { title, time, status })}
    >
      <span
        aria-hidden="true"
        className="fgw-cal-chip__dot"
        data-tone={POST_STATUS_TONE[post.status]}
      />
      <span className="fgw-cal-chip__title">{title}</span>
      <span className="fgw-cal-chip__time">{time}</span>
      <span className="fg-visually-hidden">{status}</span>
    </li>
  );
}
