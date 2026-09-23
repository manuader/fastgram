"use client";

import type { BrandSource } from "@fastgram/contracts";
import { Spinner } from "@fastgram/ui";
import { useId } from "react";
import { tw } from "@/lib/i18n/t";
import { processingPhase } from "@/lib/onboarding/processing";
import { SourceAnalysisList } from "./SourceAnalysisList";

/**
 * Paso 4 del onboarding · `FR-010` (PRD:748, 760), `FR-011.2` (PRD:835).
 * `P1-ONB-005`.
 *
 * ## De la secuencia de `FR-010`, sólo el primer estado tiene respaldo
 *
 * El PRD pide `Analyzing company profile...` → `Processing with AI...` →
 * `Creating Workspace...` → `Setting up your workspace...` → `Preparing
 * workspace` → `Workspace ready!` → `Completing Setup...` → `Continue to
 * Dashboard`. De esos ocho, lo único que la API puede afirmar es el primero:
 * el estado de cada fuente. Crear el workspace no tiene ejecutor
 * (`companyRepository` es de sólo lectura) y `POST /onboarding/complete`
 * devuelve `step: "processing"`, no `ready`, justamente para no mentir (ver su
 * nota en `apps/api/src/routes/v1/onboarding.ts`).
 *
 * Así que esta pantalla muestra `Analyzing company profile...` mientras alguna
 * fuente siga en curso y, cuando terminan, **que terminó el análisis** — no
 * `Workspace ready!`. Encadenar los otros seis textos con temporizadores sería
 * una animación de un trabajo que nadie hace.
 *
 * El cierre del wizard (`POST /onboarding/complete` y `Continue to
 * Dashboard`) es del wizard (`P1-ONB-001`), no de este paso.
 */
export function ProcessingStep({
  sources,
}: {
  readonly sources: readonly BrandSource[];
}) {
  const titleId = useId();
  const phase = processingPhase(sources);

  return (
    <section className="fgw-onb" aria-labelledby={titleId}>
      <header className="fgw-onb__header">
        <h1 id={titleId} className="fgw-onb__title fgw-onb__title--status">
          {phase === "analyzing" && <Spinner size="sm" aria-hidden="true" />}
          {phase === "analyzing" && tw("loading.onboarding.analyzing")}
          {phase === "done" && tw("onboarding.processing.done")}
          {phase === "failed" && tw("onboarding.processing.needsSupport")}
          {phase === "empty" && tw("onboarding.processing.noSources")}
        </h1>
      </header>
      <SourceAnalysisList sources={sources} />
    </section>
  );
}
