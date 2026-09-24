"use client";

import { Skeleton } from "@fastgram/ui";
import type { ComponentType } from "react";
import { CalendarIcon, CheckIcon, CloseIcon, RocketIcon, type IconProps } from "@/icons";
import { tw, type CopyKey } from "@/lib/i18n/t";

export interface TodayCounterValues {
  /** `undefined` = cargando; `null` = no se pudo saber (se dice, no se pone 0). */
  readonly posted: number | null | undefined;
  readonly scheduled: number | null | undefined;
  readonly approval: number | null | undefined;
  readonly failed: number | null | undefined;
}

interface Tile {
  readonly id: keyof TodayCounterValues;
  readonly labelKey: CopyKey;
  readonly icon: ComponentType<IconProps>;
  readonly color: string;
}

const TILES: readonly Tile[] = [
  {
    id: "posted",
    labelKey: "today.counter.posted",
    icon: CheckIcon,
    color: "var(--fg-color-success)",
  },
  {
    id: "scheduled",
    labelKey: "today.counter.scheduled",
    icon: CalendarIcon,
    color: "var(--fg-color-info)",
  },
  {
    id: "approval",
    labelKey: "today.counter.approval",
    icon: RocketIcon,
    color: "var(--fg-color-accent)",
  },
  {
    id: "failed",
    labelKey: "today.counter.failed",
    icon: CloseIcon,
    color: "var(--fg-color-danger)",
  },
];

/**
 * Los cuatro contadores de "Today". Un valor desconocido se muestra como tal,
 * no como `0`: "0 fallidos" es una afirmación (el mismo criterio que `KpiRow`).
 */
export function TodayCounters({
  values,
  approvalHint,
}: {
  values: TodayCounterValues;
  /** "in Acme": el de aprobación es sólo de la marca activa. */
  approvalHint: string | null;
}) {
  return (
    <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {TILES.map((tile) => {
        const Icon = tile.icon;
        const value = values[tile.id];
        const emphasis = tile.id === "failed" && typeof value === "number" && value > 0;
        return (
          <li
            key={tile.id}
            data-testid={`today-counter-${tile.id}`}
            aria-busy={value === undefined}
            className="relative flex flex-col gap-2 overflow-hidden rounded-xl border border-border bg-surface p-4"
            style={
              emphasis
                ? {
                    borderColor: `color-mix(in srgb, ${tile.color} 45%, var(--fg-color-border))`,
                  }
                : undefined
            }
          >
            <span className="flex items-center gap-2 text-xs font-medium text-text-muted">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 items-center justify-center rounded-md"
                style={{
                  color: tile.color,
                  background: `color-mix(in srgb, ${tile.color} 14%, transparent)`,
                }}
              >
                <Icon size={14} />
              </span>
              {tw(tile.labelKey)}
            </span>
            <div className="text-3xl font-semibold tabular-nums text-text">
              {value === undefined ? (
                <Skeleton width={48} height={32} />
              ) : value === null ? (
                <span className="text-sm font-normal text-text-muted">
                  {tw("today.counter.unavailable")}
                </span>
              ) : (
                <span data-testid={`today-counter-${tile.id}-value`}>{value}</span>
              )}
            </div>
            {tile.id === "approval" && approvalHint !== null && (
              <span className="text-xs text-text-subtle">{approvalHint}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
