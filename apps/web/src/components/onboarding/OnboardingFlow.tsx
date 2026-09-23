"use client";

import type { OnboardingStep } from "@fastgram/contracts";
import { Skeleton } from "@fastgram/ui";
import { useEffect, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { useOnboardingState } from "@/lib/onboarding/brand-source";
import { BrandSourceStep } from "./BrandSourceStep";
import { ProcessingStep } from "./ProcessingStep";
import { SourceAnalysisList } from "./SourceAnalysisList";

const STEP_COPY: Readonly<Record<OnboardingStep, CopyKey>> = {
  brand_source: "onboarding.step.brandSource",
  company_details: "onboarding.step.companyDetails",
  profiling: "onboarding.step.profiling",
  processing: "onboarding.step.processing",
  ready: "onboarding.step.ready",
};

/**
 * `/onboarding` — lo mínimo para montar los pasos 1 y 4 sobre `GET /onboarding`.
 *
 * **No es el wizard de `P1-ONB-001`**: no hay indicador de progreso, ni
 * `Exit setup`, ni los pasos 2, 3 y 5. Lo que hace es lo que los dos pasos
 * construidos necesitan para verse con datos reales:
 *
 * · **loading** — `aria-busy` y un esqueleto.
 * · **error** — `ApiErrorState`, con la salida que le toque al código.
 * · **paso 1** — mientras la API diga `brand_source`, **o** mientras el usuario
 *   siga en el paso aunque ya haya añadido una fuente. Sin esto, la primera
 *   fuente mueve el paso derivado a `company_details` y la pantalla se va sola
 *   antes de que pueda usar `Add another source`.
 * · **paso 4** — `processing`.
 * · **cualquier otro** — dice que el paso no está construido, y sigue
 *   mostrando el estado del análisis: que falte la pantalla del paso 2 no es
 *   motivo para esconder lo que ya se sabe de las fuentes.
 */
export function OnboardingFlow() {
  const state = useOnboardingState();
  // `null` = todavía no se decidió; se fija **con el primer dato** y no se
  // vuelve a derivar del `step` de la API. Si se derivara en cada render, el
  // refetch que sigue a la primera alta (que mueve el paso a
  // `company_details`) desmontaría el paso 1 en el acto. Lo encontró el test
  // de `Add another source`, no la lectura.
  const [onSourceStep, setOnSourceStep] = useState<boolean | null>(null);
  const firstStep = state.data?.step;
  useEffect(() => {
    if (onSourceStep === null && firstStep !== undefined) {
      setOnSourceStep(firstStep === "brand_source");
    }
  }, [onSourceStep, firstStep]);

  if (state.isPending) {
    return (
      <div className="fgw-onb" aria-busy="true">
        <Skeleton className="fgw-onb__skeleton" />
      </div>
    );
  }
  if (state.isError) {
    return (
      <div className="fgw-onb" aria-busy="false">
        <ApiErrorState
          error={state.error}
          onRetry={() => {
            void state.refetch();
          }}
        />
      </div>
    );
  }

  const { step, sources } = state.data;
  const showSourceStep = onSourceStep ?? step === "brand_source";

  if (showSourceStep) {
    return (
      <div className="fgw-onb-flow" aria-busy="false">
        <BrandSourceStep
          sources={sources}
          onContinue={() => {
            setOnSourceStep(false);
          }}
        />
      </div>
    );
  }
  if (step === "processing") {
    return (
      <div className="fgw-onb-flow" aria-busy="false">
        <ProcessingStep sources={sources} />
      </div>
    );
  }
  return (
    <div className="fgw-onb-flow" aria-busy="false">
      <section className="fgw-onb">
        <h1 className="fgw-onb__title">
          {tw("placeholder.notBuilt.title", { screen: tw(STEP_COPY[step]) })}
        </h1>
        <p className="fgw-onb__subtitle">{tw("placeholder.notBuilt.description")}</p>
        <SourceAnalysisList sources={sources} />
      </section>
    </div>
  );
}
