"use client";

import { Button, Textarea, cn } from "@fastgram/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { ChoiceChips } from "@/components/ai-studio/ChoiceChips";
import { WandIcon } from "@/icons";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import { useGenerateImages, useImageEstimate } from "@/lib/influencers/api";
import {
  IMAGE_ASPECTS,
  INITIAL_IMAGE_FORM,
  toImageRequest,
  type ImageForm,
} from "@/lib/influencers/form";
import { formatUsd } from "@/lib/models/budget";
import { TemplateSelect } from "./TemplatesDialog";

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

export interface ImageComposerProps {
  readonly influencerId: string;
  readonly gender: string | undefined;
}

/**
 * La barra de generación de FR-081: prompt, relación, cantidad y el costo
 * **antes** de generar (estimador de Higgsfield con el personaje). Si pasaría
 * el tope del mes, el botón se apaga; el servidor lo vuelve a comprobar (402).
 */
export function ImageComposer({ influencerId, gender }: ImageComposerProps) {
  const promptId = useId();
  const [form, setForm] = useState<ImageForm>(INITIAL_IMAGE_FORM);
  const [notice, setNotice] = useState<string | null>(null);
  const debouncedPrompt = useDebounced(form.prompt, ESTIMATE_DEBOUNCE_MS);
  const request = useMemo(
    () => toImageRequest({ ...form, prompt: debouncedPrompt }),
    [form, debouncedPrompt],
  );
  const estimate = useImageEstimate(influencerId, request);
  const generate = useGenerateImages(influencerId);

  const cost = estimate.data?.estimate;
  const remaining = estimate.data?.budget.remainingUsd;
  const overBudget = estimate.data !== undefined && !estimate.data.fits;
  const typing = form.prompt !== debouncedPrompt;
  const canGenerate = toImageRequest(form) !== null && !overBudget && !generate.isPending;

  const placeholder =
    gender === "female"
      ? tw("influencers.images.placeholder.female")
      : gender === "male"
        ? tw("influencers.images.placeholder.male")
        : tw("influencers.images.placeholder.other");

  const onGenerate = () => {
    const body = toImageRequest(form);
    if (body === null) return;
    setNotice(null);
    generate.mutate(body, {
      onSuccess: () => {
        setNotice(tw("influencers.images.started"));
        setForm({ ...form, prompt: "" });
      },
    });
  };

  const error = generate.error;
  const budgetRejected =
    isApiRequestError(error) && error.details?.["reason"] === "budget_exceeded";

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex flex-col gap-2">
        <label htmlFor={promptId} className="text-sm font-medium text-text">
          {tw("influencers.images.prompt")}
        </label>
        <Textarea
          id={promptId}
          rows={2}
          maxLength={2000}
          placeholder={placeholder}
          value={form.prompt}
          onChange={(e) => {
            setForm({ ...form, prompt: e.target.value });
          }}
        />
      </div>
      <div className="flex flex-wrap items-end gap-6">
        <TemplateSelect
          gender={gender}
          onApply={(prompt) => {
            setForm({ ...form, prompt });
          }}
        />
        <ChoiceChips
          name="influencer-aspect"
          label={tw("influencers.images.aspect")}
          value={form.aspectRatio}
          onChange={(aspectRatio) => {
            setForm({ ...form, aspectRatio });
          }}
          choices={IMAGE_ASPECTS.map((r) => ({ value: r, label: r }))}
        />
        <ChoiceChips
          name="influencer-count"
          label={tw("influencers.images.count")}
          value={form.count}
          onChange={(count) => {
            setForm({ ...form, count });
          }}
          choices={[
            { value: 1 as const, label: "1" },
            { value: 4 as const, label: "4" },
          ]}
        />
      </div>
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        aria-live="polite"
        data-testid="influencer-estimate"
      >
        <div className="flex flex-col">
          <span className="text-xs text-text-muted">
            {tw("influencers.images.estimate")}
          </span>
          <span className="text-xl font-semibold tabular-nums text-text">
            {cost === undefined || typing ? "—" : formatUsd(cost.usd)}
          </span>
          <span
            className={cn(
              "text-xs",
              overBudget || estimate.isError ? "text-danger" : "text-text-subtle",
            )}
          >
            {request === null
              ? tw("influencers.images.estimateIdle")
              : estimate.isFetching || typing
                ? tw("influencers.images.estimating")
                : estimate.isError
                  ? (estimate.error.serverMessage ??
                    tw("influencers.images.failedToStart"))
                  : overBudget && remaining !== undefined
                    ? tw("influencers.images.overBudget", {
                        remaining: formatUsd(remaining),
                      })
                    : " "}
          </span>
        </div>
        <Button
          leadingIcon={<WandIcon size={16} />}
          loading={generate.isPending}
          disabled={!canGenerate}
          onClick={onGenerate}
        >
          {generate.isPending
            ? tw("influencers.images.generating")
            : tw("influencers.images.generate")}
        </Button>
      </div>
      <div aria-live="polite" className="min-h-5">
        {generate.isError ? (
          <p className="m-0 text-sm text-danger" role="alert">
            {budgetRejected
              ? tw("influencers.images.budgetExceeded")
              : (error?.serverMessage ?? tw("influencers.images.failedToStart"))}
          </p>
        ) : notice !== null ? (
          <p className="m-0 text-sm text-success">{notice}</p>
        ) : null}
      </div>
      <p className="m-0 text-xs text-text-subtle">
        {tw("influencers.images.animateHint")}
      </p>
    </section>
  );
}
