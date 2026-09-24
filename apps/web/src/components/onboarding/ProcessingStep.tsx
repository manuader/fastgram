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
 * Dashboard`. De esos ocho, lo único que **este paso** puede afirmar es el
 * primero: el estado de cada fuente. El workspace ya existe (lo crea
 * `POST /onboarding/workspace` antes del paso 1) y el paso a `ready` ocurre al
 * cerrar el wizard, no acá: `POST /onboarding/complete` pasa el workspace de
 * `draft` a `active` y devuelve `step: "ready"` (ver su nota en
 * `apps/api/src/routes/v1/onboarding.ts`). Sembrar ángulos sigue sin ejecutor.
 *
 * Así que esta pantalla muestra `Analyzing company profile...` mientras alguna
 * fuente siga en curso y, cuando terminan, **que terminó el análisis** — no
 * `Workspace ready!`, que todavía no es cierto en este paso. Encadenar los
 * otros textos con temporizadores sería una animación de un trabajo que nadie
 * hace en este momento.
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
      {/* Región viva (P5-A11Y-001): el paso de `Analyzing…` a "terminó" se
          anuncia; la lista de fuentes deja de ser viva cuando nada corre. */}
      <header className="fgw-onb__header" aria-live="polite">
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
