"use client";

import type { AiStudioOptions, GenKind } from "@fastgram/contracts";
import { Badge, Button, Input, Select, Textarea, buttonVariants, cn } from "@fastgram/ui";
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { ExternalLinkIcon, WandIcon } from "@/icons";
import { useCreateGeneration, useEstimate } from "@/lib/ai-studio/api";
import {
  formErrors,
  initialForm,
  providerLabel,
  specFor,
  taskFor,
  toRequest,
  withModel,
  type StudioForm,
} from "@/lib/ai-studio/form";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import { formatUsd } from "@/lib/models/budget";
import { ROUTES } from "@/lib/nav/routes";
import { BudgetMeter } from "./BudgetMeter";
import { ChoiceChips } from "./ChoiceChips";

/** Cuánto se espera a que el usuario deje de escribir antes de estimar. */
const ESTIMATE_DEBOUNCE_MS = 600;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      clearTimeout(id);
    };
  }, [value, ms]);
  return debounced;
}

export interface ComposerProps {
  readonly options: AiStudioOptions;
}

/**
 * El panel para pedir una generación — `PU-LATER-005`.
 *
 * El costo estimado se ve **antes** de generar y se recalcula al cambiar
 * cualquier cosa (con el prompt, después de una pausa al escribir). Si el
 * pedido pasaría el tope del mes, el botón se apaga y se dice cuánto queda;
 * el servidor igual lo vuelve a comprobar (402).
 */
export function Composer({ options }: ComposerProps) {
  const ids = { prompt: useId(), model: useId(), image: useId() };
  const firstKind: GenKind =
    options.image.configured || !options.video.configured ? "image" : "video";
  const [form, setForm] = useState<StudioForm>(() => initialForm(options, firstKind));
  const [notice, setNotice] = useState<string | null>(null);

  const task = taskFor(options, form.kind);
  const spec = specFor(options, form);
  const errors = formErrors(form, spec);
  const debouncedPrompt = useDebounced(form.prompt, ESTIMATE_DEBOUNCE_MS);
  const request = useMemo(
    () => toRequest({ ...form, prompt: debouncedPrompt }, spec),
    [form, debouncedPrompt, spec],
  );
  const estimate = useEstimate(request);
  const create = useCreateGeneration();

  const cost = estimate.data?.estimate;
  const remaining = options.budget.remainingUsd;
  const overBudget = cost !== undefined && cost.usd > remaining + 1e-9;
  const typing = form.prompt !== debouncedPrompt;
  const canGenerate =
    task.configured && toRequest(form, spec) !== null && !overBudget && !create.isPending;

  const setKind = (kind: GenKind) => {
    if (kind === form.kind) return;
    setForm(initialForm(options, kind, form));
    setNotice(null);
  };

  const onGenerate = () => {
    const body = toRequest(form, spec);
    if (body === null) return;
    setNotice(null);
    create.mutate(body, {
      onSuccess: () => {
        setNotice(tw("aiStudio.generate.started"));
      },
    });
  };

  const createError = create.error;
  const budgetRejected =
    isApiRequestError(createError) &&
    createError.details?.["reason"] === "budget_exceeded";

  return (
    <section
      aria-labelledby="ai-studio-composer"
      className="flex flex-col gap-5 overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="ai-studio-composer" className="m-0 text-lg font-semibold text-text">
          <WandIcon size={18} className="mr-2 inline-block align-[-3px] text-accent" />
          {tw("aiStudio.generate")}
        </h2>
        {task.provider !== null && (
          <Badge tone="neutral" size="sm">
            {providerLabel(task.provider)}
          </Badge>
        )}
      </div>

      <ChoiceChips
        name="ai-studio-kind"
        label={tw("aiStudio.kind.label")}
        value={form.kind}
        onChange={setKind}
        choices={[
          { value: "image", label: tw("aiStudio.kind.image") },
          { value: "video", label: tw("aiStudio.kind.video") },
        ]}
      />

      {!task.configured ? (
        <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border-strong bg-surface-sunken p-4">
          <p className="m-0 text-sm text-text-muted">
            {tw("aiStudio.setup.kindMissing", {
              kind: tw(
                form.kind === "image" ? "aiStudio.kind.image" : "aiStudio.kind.video",
              ).toLowerCase(),
            })}
          </p>
          <Link
            href={ROUTES.settingsModels}
            className={cn(
              buttonVariants({ variant: "secondary", size: "sm" }),
              "self-start",
            )}
          >
            {tw("aiStudio.setup.action")}
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <label htmlFor={ids.prompt} className="text-sm font-medium text-text">
              {tw("aiStudio.prompt.label")}
            </label>
            <Textarea
              id={ids.prompt}
              rows={4}
              maxLength={2000}
              placeholder={tw("aiStudio.prompt.placeholder")}
              value={form.prompt}
              onChange={(e) => {
                setForm({ ...form, prompt: e.target.value });
              }}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor={ids.model} className="text-sm font-medium text-text">
              {tw("aiStudio.model.label")}
            </label>
            <Select
              id={ids.model}
              value={form.model}
              options={task.models.map((m) => ({ value: m.id, label: m.label }))}
              onChange={(e) => {
                setForm(withModel(options, form, e.target.value));
              }}
            />
            {spec !== undefined && (
              <a
                href={spec.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 self-start text-xs text-text-subtle hover:text-text"
              >
                <code>{spec.id}</code>
                <ExternalLinkIcon size={12} />
                <span className="sr-only">{tw("aiStudio.model.docs")}</span>
              </a>
            )}
          </div>

          {spec !== undefined &&
            (spec.aspectFromImage ? (
              <p className="m-0 text-sm text-text-muted">
                {tw("aiStudio.aspect.label")}: {tw("aiStudio.aspect.fromImage")}
              </p>
            ) : (
              <ChoiceChips
                name="ai-studio-aspect"
                label={tw("aiStudio.aspect.label")}
                value={form.aspectRatio}
                onChange={(aspectRatio) => {
                  setForm({ ...form, aspectRatio });
                }}
                choices={spec.aspectRatios.map((r) => ({ value: r, label: r }))}
              />
            ))}

          {spec !== undefined && spec.counts.length > 1 && (
            <ChoiceChips
              name="ai-studio-count"
              label={tw("aiStudio.count.label")}
              value={form.count}
              onChange={(count) => {
                setForm({ ...form, count });
              }}
              choices={spec.counts.map((n) => ({ value: n, label: String(n) }))}
            />
          )}

          {spec?.kind === "video" && form.durationSeconds !== null && (
            <ChoiceChips
              name="ai-studio-duration"
              label={tw("aiStudio.duration.label")}
              value={form.durationSeconds}
              onChange={(durationSeconds) => {
                setForm({ ...form, durationSeconds });
              }}
              choices={spec.durationsSeconds.map((s) => ({
                value: s,
                label: tw("aiStudio.duration.value", { seconds: s }),
              }))}
            />
          )}

          {spec !== undefined && spec.imageInput !== "none" && (
            <div className="flex flex-col gap-2">
              <label htmlFor={ids.image} className="text-sm font-medium text-text">
                {tw("aiStudio.image.label")}
              </label>
              <Input
                id={ids.image}
                type="url"
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                placeholder="https://"
                aria-describedby={`${ids.image}-hint`}
                value={form.imageUrl}
                onChange={(e) => {
                  setForm({ ...form, imageUrl: e.target.value });
                }}
              />
              <p id={`${ids.image}-hint`} className="m-0 text-xs text-text-subtle">
                {tw("aiStudio.image.hint")}
              </p>
            </div>
          )}

          <div
            className="flex flex-col gap-3 rounded-xl bg-surface-sunken p-4"
            aria-live="polite"
            data-testid="ai-studio-estimate"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-text-muted">
                {tw("aiStudio.estimate.label")}
              </span>
              <span className="text-2xl font-semibold tabular-nums text-text">
                {cost === undefined || typing ? "—" : formatUsd(cost.usd)}
              </span>
            </div>
            <p
              className={cn(
                "m-0 text-xs",
                overBudget || estimate.isError ? "text-danger" : "text-text-subtle",
              )}
            >
              {request === null && errors.prompt !== undefined
                ? tw("aiStudio.estimate.idle")
                : estimate.isFetching || typing
                  ? tw("aiStudio.estimate.loading")
                  : estimate.isError
                    ? (estimate.error.serverMessage ?? tw("aiStudio.estimate.error"))
                    : overBudget
                      ? tw("aiStudio.estimate.overBudget", {
                          remaining: formatUsd(remaining),
                        })
                      : cost === undefined
                        ? " "
                        : cost.source === "provider"
                          ? tw("aiStudio.estimate.provider", {
                              provider: providerLabel(estimate.data?.provider ?? null),
                            })
                          : tw("aiStudio.estimate.priceList", { basis: cost.basis })}
            </p>
            <BudgetMeter summary={options.budget} />
          </div>

          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              leadingIcon={<WandIcon size={16} />}
              loading={create.isPending}
              disabled={!canGenerate}
              onClick={onGenerate}
            >
              {create.isPending ? tw("aiStudio.generating") : tw("aiStudio.generate")}
            </Button>
            <div aria-live="polite" className="min-h-5">
              {create.isError ? (
                <p className="m-0 text-sm text-danger" role="alert">
                  {budgetRejected
                    ? tw("aiStudio.generate.budgetExceeded")
                    : (createError?.serverMessage ?? tw("aiStudio.generate.error"))}
                </p>
              ) : notice !== null ? (
                <p className="m-0 text-sm text-success">{notice}</p>
              ) : null}
            </div>
            <Link
              href={ROUTES.settingsModels}
              className="self-start text-xs text-text-subtle hover:text-text"
            >
              {tw("aiStudio.budget.manage")}
            </Link>
          </div>
        </>
      )}
    </section>
  );
}
