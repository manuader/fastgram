"use client";

import { EmptyState, Skeleton } from "@fastgram/ui";
import type { ModelTaskConfig } from "@fastgram/contracts";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { useModelsOverview } from "@/lib/models/api";
import { MODELS_COPY } from "@/lib/models/copy";
import { BudgetCard } from "./BudgetCard";
import { isJudgmentOverride, JudgmentOverrides } from "./JudgmentOverrides";
import { TaskModelCard } from "./TaskModelCard";

/** `text` y `judgment`: las que algo del código usa hoy. */
const isActive = (t: ModelTaskConfig): boolean => t.wired;

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <Skeleton shape="text" width="30%" />
      <Skeleton shape="text" width="60%" />
      <Skeleton height={36} />
      <Skeleton height={36} />
      <Skeleton height={36} />
    </div>
  );
}

/**
 * Settings → Models — `PU-MODEL-002`, `docs/PLAN-USO-PERSONAL.md` §4.
 *
 * Una tarjeta por tarea. Arriba las que el código usa hoy (`text`,
 * `judgment`); abajo las reservadas, que se pueden dejar configuradas pero
 * todavía no llama nadie — y se dice.
 *
 * Estados: `loading` (esqueletos con la forma de las tarjetas), `error`
 * (`ApiErrorState`, con la salida que corresponda al código) y `empty`, que
 * acá no es «no hay tareas» —siempre vienen las seis— sino **ninguna tarea
 * configurada**: sin un modelo de texto la cola de Blitz queda vacía, y es lo
 * primero que hay que saber.
 */
export function ModelsSettings() {
  const query = useModelsOverview();

  if (query.isError) {
    return (
      <ApiErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  if (query.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-2" aria-busy="true">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const { tasks, providers } = query.data;
  // `P1-JUDGE-004`: los overrides de juicio van en su sección, no como tarjetas sueltas.
  const overrides = tasks.filter((t) => isJudgmentOverride(t.task));
  const base = tasks.filter((t) => !isJudgmentOverride(t.task));
  const active = base.filter(isActive);
  const reserved = base.filter((t) => !isActive(t));
  const nothingConfigured = base.every((t) => t.status === "unset");

  return (
    <div className="flex flex-col gap-8">
      {nothingConfigured && (
        <EmptyState
          size="sm"
          title={MODELS_COPY.emptyTitle}
          description={MODELS_COPY.emptyBody}
        />
      )}

      <section aria-labelledby="models-active" className="flex flex-col gap-4">
        <h2 id="models-active" className="m-0 text-lg font-semibold text-text">
          {MODELS_COPY.sectionActive}
        </h2>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {active.map((config) => (
            <TaskModelCard key={config.task} config={config} presets={providers} />
          ))}
        </div>
      </section>

      <JudgmentOverrides overrides={overrides} presets={providers} />

      {/* `PU-MODEL-005`: gasto del mes contra el tope de imagen y video. */}
      <section
        aria-label="Monthly AI budget"
        className="grid items-start gap-4 lg:grid-cols-2"
      >
        <BudgetCard />
      </section>

      <section aria-labelledby="models-reserved" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="models-reserved" className="m-0 text-lg font-semibold text-text">
            {MODELS_COPY.sectionReserved}
          </h2>
          <p className="m-0 text-sm text-text-muted">{MODELS_COPY.sectionReservedHint}</p>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {reserved.map((config) => (
            <TaskModelCard key={config.task} config={config} presets={providers} />
          ))}
        </div>
      </section>
    </div>
  );
}
