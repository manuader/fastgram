"use client";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
} from "@fastgram/ui";
import { useEffect, useId, useState } from "react";
import { BudgetMeter } from "@/components/ai-studio/BudgetMeter";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { parseBudgetInput, useBudget, useSaveBudget } from "@/lib/models/budget";
import { BUDGET_COPY } from "@/lib/models/copy";

/**
 * Settings → Models → «Monthly AI budget» — `PU-MODEL-005`.
 *
 * Muestra el gasto del mes contra el tope y deja cambiarlo. El tope lo
 * aplica la API al pedir cada generación (402 si se pasaría); acá sólo se
 * edita y se muestra de dónde sale (Settings, entorno o default).
 */
export function BudgetCard() {
  const inputId = useId();
  const budget = useBudget();
  const save = useSaveBudget();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const current = budget.data?.budgetUsd;
  useEffect(() => {
    if (current !== undefined) setValue(String(current));
  }, [current]);

  if (budget.isError) {
    return (
      <ApiErrorState
        error={budget.error}
        onRetry={() => {
          void budget.refetch();
        }}
      />
    );
  }

  const parsed = parseBudgetInput(value);
  const invalid = touched && parsed === null;
  const dirty = parsed !== null && parsed !== current;

  return (
    <Card className="flex flex-col" data-testid="budget-card">
      <CardHeader className="flex flex-col gap-1">
        <CardTitle as="h3">{BUDGET_COPY.title}</CardTitle>
        <CardDescription>{BUDGET_COPY.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {budget.data === undefined ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton shape="text" width="60%" />
            <Skeleton height={8} />
          </div>
        ) : (
          <>
            <BudgetMeter summary={budget.data} />
            <p className="m-0 text-xs text-text-subtle">
              {BUDGET_COPY.source[budget.data.budgetSource]} {BUDGET_COPY.estimateNote}
            </p>
          </>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="text-sm font-medium text-text">
            {BUDGET_COPY.label}
          </label>
          <Input
            id={inputId}
            inputMode="decimal"
            autoComplete="off"
            value={value}
            invalid={invalid}
            aria-describedby={`${inputId}-hint`}
            onChange={(e) => {
              setValue(e.target.value);
              setTouched(true);
              setJustSaved(false);
            }}
          />
          <p
            id={`${inputId}-hint`}
            className={
              invalid ? "m-0 text-xs text-danger" : "m-0 text-xs text-text-muted"
            }
          >
            {invalid ? BUDGET_COPY.invalid : BUDGET_COPY.hint}
          </p>
          {save.isError && (
            <p className="m-0 text-xs text-danger" role="alert">
              {save.error.serverMessage ?? BUDGET_COPY.invalid}
            </p>
          )}
        </div>
      </CardContent>
      <CardFooter className="mt-auto flex flex-wrap items-center justify-end gap-2">
        {justSaved && !dirty && (
          <span className="mr-auto text-sm text-success" role="status">
            ✓ {BUDGET_COPY.saved}
          </span>
        )}
        {budget.data?.budgetSource === "settings" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => {
              save.mutate(
                { budgetUsd: null },
                {
                  onSuccess: () => {
                    setJustSaved(true);
                  },
                },
              );
            }}
          >
            {BUDGET_COPY.reset}
          </Button>
        )}
        <Button
          size="sm"
          loading={save.isPending}
          disabled={!dirty || save.isPending}
          onClick={() => {
            if (parsed === null) return;
            save.mutate(
              { budgetUsd: parsed },
              {
                onSuccess: () => {
                  setJustSaved(true);
                  setTouched(false);
                },
              },
            );
          }}
        >
          {save.isPending ? BUDGET_COPY.saving : BUDGET_COPY.save}
        </Button>
      </CardFooter>
    </Card>
  );
}
