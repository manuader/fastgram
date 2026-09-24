"use client";

import { buttonVariants, EmptyState, ErrorState } from "@fastgram/ui";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { RocketIcon, ZapIcon } from "@/icons";
import { copyKeyForError } from "@/lib/api/errors";
import { browserTimeZone } from "@/lib/calendar/calendar";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import {
  useBlitzQueueCount,
  useTodayCalendar,
  useTodayPostDetails,
} from "@/lib/today/data";
import {
  buildTodayView,
  dayPartOf,
  formatTodayDate,
  olderDrafts,
  TODAY_REFRESH_MS,
  todayWindow,
  type DayPart,
} from "@/lib/today/today";
import { ApprovalCard } from "./ApprovalCard";
import { AutopilotCard } from "./AutopilotCard";
import { FailedCard } from "./FailedCard";
import { TikTokDrafts } from "./TikTokDrafts";
import { TodayCounters } from "./TodayCounters";
import { TodayTimeline } from "./TodayTimeline";

const GREETING: Readonly<Record<DayPart, CopyKey>> = {
  morning: "today.greeting.morning",
  afternoon: "today.greeting.afternoon",
  evening: "today.greeting.evening",
};

interface Clock {
  readonly nowMs: number;
  readonly timeZone: string;
}

/**
 * El reloj de la pantalla. `null` hasta montar: el servidor no conoce ni la
 * hora ni la zona del navegador, y dibujar el saludo en el SSR rompería la
 * hidratación (y cruzaría la medianoche con otra zona). Avanza cada 30 s, con el
 * mismo compás que los datos: la ventana de consulta sólo cambia de números al
 * cambiar el día, así que el tic no re-pide nada por sí mismo.
 */
function useClock(): Clock | null {
  const [clock, setClock] = useState<Clock | null>(null);
  useEffect(() => {
    const tick = () => {
      setClock({ nowMs: Date.now(), timeZone: browserTimeZone() });
    };
    tick();
    const id = setInterval(tick, TODAY_REFRESH_MS);
    return () => {
      clearInterval(id);
    };
  }, []);
  return clock;
}

/**
 * "Today" · `PU-UI-002` (`docs/PLAN-USO-PERSONAL.md` §7). Reemplaza al
 * dashboard de FR-030 en `/home`: la pantalla de todos los días no son KPIs de
 * vanidad sino qué sale hoy, qué falló y qué espera al usuario.
 *
 * Qué viene de dónde —y los dos datos que sólo existen para la marca activa— está
 * en la cabecera de `lib/today/data.ts`.
 */
export function TodayScreen() {
  const clock = useClock();
  const { active, workspaces, isPersonal } = useWorkspace();
  const range = useMemo(
    () => (clock === null ? null : todayWindow(clock.nowMs, clock.timeZone)),
    [clock],
  );

  const calendar = useTodayCalendar(range);
  const details = useTodayPostDetails(range);
  const blitz = useBlitzQueueCount();

  const view = useMemo(
    () =>
      calendar.data === undefined || range === null || clock === null
        ? null
        : buildTodayView(calendar.data.items, range, clock.nowMs),
    [calendar.data, range, clock],
  );

  const brandCount = workspaces.data?.length ?? 1;
  const multiBrand = isPersonal && brandCount > 1;
  const timeZone = clock?.timeZone ?? "UTC";

  const blitzValue = blitz.isPending ? undefined : blitz.isError ? null : blitz.data;
  const older =
    calendar.data === undefined || view === null
      ? 0
      : olderDrafts(calendar.data.counts.inbox, view.drafts.length);

  const quietDay =
    view !== null &&
    view.timeline.length === 0 &&
    view.drafts.length === 0 &&
    view.failed.length === 0;

  return (
    <div className="fgw-page">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight text-text">
          {clock === null
            ? tw("today.title")
            : tw(GREETING[dayPartOf(clock.nowMs, clock.timeZone)])}
        </h1>
        <p className="text-sm text-text-muted" data-testid="today-date">
          {clock === null
            ? "\u00a0"
            : tw(multiBrand ? "today.subtitle.all" : "today.subtitle.one", {
                date: formatTodayDate(clock.nowMs, clock.timeZone),
              })}
        </p>
      </header>

      <div className="mb-6">
        <TodayCounters
          values={{
            posted: calendar.isError ? null : view?.counts.postedToday,
            scheduled: calendar.isError ? null : view?.counts.scheduledToday,
            approval: blitzValue,
            failed: calendar.isError ? null : view?.counts.failedRecent,
          }}
          approvalHint={
            multiBrand && active !== null
              ? tw("today.counter.approvalIn", { brand: active.name })
              : null
          }
        />
      </div>

      {calendar.isError ? (
        <ErrorState
          title={tw("today.error")}
          description={tw(copyKeyForError(calendar.error))}
          onRetry={() => {
            void calendar.refetch();
          }}
        />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="flex min-w-0 flex-col gap-6">
            {view !== null && (
              <TikTokDrafts drafts={view.drafts} older={older} timeZone={timeZone} />
            )}
            <section
              aria-labelledby="today-timeline-title"
              className="flex flex-col gap-3"
            >
              <h2 id="today-timeline-title" className="text-lg font-semibold text-text">
                {tw("today.timeline.title")}
              </h2>
              {quietDay ? (
                <EmptyState
                  icon={<RocketIcon size={20} />}
                  title={tw("today.empty.title")}
                  description={tw("today.empty.body")}
                  action={
                    <Link
                      href={ROUTES.blitz}
                      className={buttonVariants({ variant: "primary", size: "md" })}
                    >
                      {tw("today.empty.blitz")}
                    </Link>
                  }
                  secondaryAction={
                    <Link
                      href={`${ROUTES.blitz}#create`}
                      className={buttonVariants({ variant: "secondary", size: "md" })}
                    >
                      <ZapIcon size={14} />
                      <span className="ml-1">{tw("today.empty.prompt")}</span>
                    </Link>
                  }
                />
              ) : (
                <TodayTimeline
                  items={view?.timeline}
                  details={details.data}
                  timeZone={timeZone}
                  multiBrand={multiBrand}
                />
              )}
              {calendar.data?.truncated === true && (
                <p className="text-xs text-warning">{tw("today.truncated")}</p>
              )}
            </section>
          </div>
          <aside className="flex min-w-0 flex-col gap-6">
            <ApprovalCard activeCount={blitzValue ?? null} loading={blitz.isPending} />
            {/* `PU-AUTO-003`: sólo se dibuja con alguna marca en piloto. */}
            <AutopilotCard timeZone={timeZone} />
            <FailedCard
              failed={view?.failed}
              details={details.data}
              timeZone={timeZone}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
