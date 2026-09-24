"use client";

import type { BrandSource } from "@fastgram/contracts";
import { cn } from "@fastgram/ui";
import { useId } from "react";
import { tw } from "@/lib/i18n/t";
import { analysisSteps, type StepState } from "./analysis-steps";

const MARK: Readonly<Record<StepState, string>> = {
  done: "✓",
  current: "●",
  pending: "○",
};

const STATE_COPY = {
  done: "brand.phase.done",
  current: "brand.phase.current",
  pending: "brand.phase.pending",
} as const;

/**
 * Los sub-pasos reales del análisis de una fuente (`P1-ONB-005`). Sólo
 * mientras la fuente está `analyzing`; la fase la escribe el worker
 * (`analysisPhase`, migración `0031`). La lista vive dentro de la fila, que ya
 * es `aria-live` en {@link BrandSourcesCard}: el cambio de paso se anuncia.
 */
export function AnalysisSteps({
  source,
}: {
  readonly source: Pick<BrandSource, "status" | "sourceType" | "analysisPhase">;
}) {
  const titleId = useId();
  const steps = analysisSteps(source);
  if (steps === null) return null;
  const started = steps.some((s) => s.state !== "pending");
  return (
    <div className="mt-1 text-sm" data-testid="analysis-steps">
      <p id={titleId} className="fg-visually-hidden">
        {tw("brand.phase.title")}
      </p>
      {!started && <p className="m-0 text-text-muted">{tw("brand.phase.starting")}</p>}
      <ol aria-labelledby={titleId} className="m-0 flex list-none flex-col gap-0.5 p-0">
        {steps.map((step) => (
          <li
            key={step.phase}
            data-state={step.state}
            aria-current={step.state === "current" ? "step" : undefined}
            className={cn(
              "flex items-center gap-2",
              step.state === "pending" ? "text-text-muted" : "",
              step.state === "current" ? "font-medium" : "",
            )}
          >
            <span aria-hidden="true" className="w-4 text-center">
              {MARK[step.state]}
            </span>
            <span>{tw(step.label)}</span>
            <span className="fg-visually-hidden">({tw(STATE_COPY[step.state])})</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
