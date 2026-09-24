"use client";

import { Button, Checkbox } from "@fastgram/ui";
import type { ModelProviderPreset, ModelTaskConfig } from "@fastgram/contracts";
import { useState } from "react";
import { useClearModelOverride } from "@/lib/models/api";
import { MODELS_COPY, TASK_COPY } from "@/lib/models/copy";
import { TaskModelCard } from "./TaskModelCard";

/** `P1-JUDGE-004`: las tareas de override, en el orden en que se muestran. */
export const JUDGMENT_OVERRIDES = [
  "judgment.autopilot",
  "judgment.brand",
  "judgment.engagement",
] as const;

export function isJudgmentOverride(task: string): boolean {
  return (JUDGMENT_OVERRIDES as readonly string[]).includes(task);
}

/** ¿Tiene un modelo propio guardado (no heredado)? */
export function hasOwnModel(config: ModelTaskConfig): boolean {
  return config.inheritsFrom === null && config.source === "registry";
}

function OverrideRow({
  config,
  presets,
}: {
  readonly config: ModelTaskConfig;
  readonly presets: readonly ModelProviderPreset[];
}) {
  const own = hasOwnModel(config);
  const [open, setOpen] = useState(own);
  const clear = useClearModelOverride(config.task);
  const copy = TASK_COPY[config.task];
  const checkboxId = `judgment-override-${config.task}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Checkbox
          id={checkboxId}
          label={copy.title}
          description={copy.description}
          checked={open || own}
          disabled={clear.isPending}
          onChange={(event) => {
            if (event.currentTarget.checked) {
              setOpen(true);
              return;
            }
            setOpen(false);
            // Destildar un override guardado lo borra: vuelve a `judgment`.
            if (own) clear.mutate();
          }}
        />
        {clear.isPending && (
          <p className="m-0 pl-6 text-xs text-text-muted" role="status">
            {MODELS_COPY.clearingOverride}
          </p>
        )}
        {clear.isError && (
          <p className="m-0 pl-6 text-xs text-danger" role="alert">
            {MODELS_COPY.clearOverrideFailed}
          </p>
        )}
      </div>
      {(open || own) && (
        <div className="flex flex-col gap-2 pl-6">
          <TaskModelCard config={config} presets={presets} />
          {own && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={clear.isPending}
                onClick={() => {
                  setOpen(false);
                  clear.mutate();
                }}
              >
                {MODELS_COPY.clearOverride}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * La sección Judgment de Settings → Models — `P1-JUDGE-004` (§9.15.2: el
 * modelo se elige **por punto de decisión**). Por defecto todo usa el modelo
 * de `judgment`; «Use a different model for…» abre la tarjeta del override.
 * Destildarlo borra el override (`DELETE /models/{task}`).
 */
export function JudgmentOverrides({
  overrides,
  presets,
}: {
  readonly overrides: readonly ModelTaskConfig[];
  readonly presets: readonly ModelProviderPreset[];
}) {
  if (overrides.length === 0) return null;
  return (
    <section aria-labelledby="models-judgment" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="models-judgment" className="m-0 text-lg font-semibold text-text">
          {MODELS_COPY.judgmentSection}
        </h2>
        <p className="m-0 text-sm text-text-muted">{MODELS_COPY.judgmentSectionHint}</p>
        <p className="m-0 text-sm font-medium text-text">
          {MODELS_COPY.useDifferentModel}
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {overrides.map((config) => (
          <OverrideRow key={config.task} config={config} presets={presets} />
        ))}
      </div>
    </section>
  );
}
