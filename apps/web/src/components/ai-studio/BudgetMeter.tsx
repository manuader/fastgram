"use client";

import type { BudgetSummary } from "@fastgram/contracts";
import { cn } from "@fastgram/ui";
import { tw } from "@/lib/i18n/t";
import { budgetUsedFraction, formatUsd } from "@/lib/models/budget";

export interface BudgetMeterProps {
  readonly summary: BudgetSummary;
  readonly className?: string;
}

/**
 * Gasto del mes contra el tope — `PU-MODEL-005`. Lo cobrado y lo que está en
 * vuelo (reservado) cuentan igual para el tope, así que la barra muestra los
 * dos, con lo reservado más tenue.
 */
export function BudgetMeter({ summary, className }: BudgetMeterProps) {
  const used = budgetUsedFraction(summary);
  const charged =
    summary.budgetUsd <= 0 ? 1 : Math.min(1, summary.chargedUsd / summary.budgetUsd);
  const tone = used >= 1 ? "bg-danger" : used >= 0.8 ? "bg-warning" : "bg-accent";
  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-testid="budget-meter">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-text-muted">{tw("aiStudio.budget.label")}</span>
        <span className="font-medium tabular-nums text-text">
          {tw("aiStudio.budget.value", {
            spent: formatUsd(summary.chargedUsd + summary.reservedUsd),
            budget: formatUsd(summary.budgetUsd),
          })}
        </span>
      </div>
      <div
        className="relative h-1.5 overflow-hidden rounded-full bg-surface-sunken"
        role="meter"
        aria-label={tw("aiStudio.budget.label")}
        aria-valuemin={0}
        aria-valuemax={summary.budgetUsd}
        aria-valuenow={summary.chargedUsd + summary.reservedUsd}
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full opacity-40 transition-all",
            tone,
          )}
          style={{ width: `${String(used * 100)}%` }}
        />
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full transition-all", tone)}
          style={{ width: `${String(charged * 100)}%` }}
        />
      </div>
      {summary.reservedUsd > 0 && (
        <span className="text-xs text-text-subtle">
          {tw("aiStudio.budget.reserved", { reserved: formatUsd(summary.reservedUsd) })}
        </span>
      )}
    </div>
  );
}
