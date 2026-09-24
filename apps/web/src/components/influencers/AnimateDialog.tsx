"use client";

import type { GenModelSpec, InfluencerVideoRequest } from "@fastgram/contracts";
import { INFLUENCER_VIDEO_PROMPT_MAX } from "@fastgram/contracts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  Textarea,
  cn,
} from "@fastgram/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { ChoiceChips } from "@/components/ai-studio/ChoiceChips";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import { formatUsd } from "@/lib/models/budget";
import { useGenerateVideo, useVideoEstimate } from "./api";

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

/** El cuerpo del pedido, o `null` si falta algo. */
export function videoRequest(
  source: { readonly mediaId: string } | null,
  spec: GenModelSpec | undefined,
  duration: number | null,
  prompt: string,
): InfluencerVideoRequest | null {
  if (source === null || spec === undefined || duration === null) return null;
  return {
    sourceMediaId: source.mediaId,
    model: spec.id,
    durationSeconds: duration,
    prompt: prompt.trim(),
  };
}

export interface AnimateDialogProps {
  readonly influencerId: string;
  /** La imagen a animar (del Media Bank). `null` = cerrado. */
  readonly source: { readonly mediaId: string; readonly url: string } | null;
  /** Los image-to-video de Higgsfield (`GET /influencers/setup`). */
  readonly models: readonly GenModelSpec[];
  readonly onClose: () => void;
  readonly onStarted: () => void;
}

/**
 * «Animate this image» — `F-099`, `FR-082`. El image-to-video de Higgsfield
 * con una imagen del personaje: prompt de movimiento opcional, modelo,
 * duración y el costo **antes** de generar. Talking Head no está: ningún
 * proveedor documenta lip-sync por API (ver la cabecera de la ruta).
 */
export function AnimateDialog({
  influencerId,
  source,
  models,
  onClose,
  onStarted,
}: AnimateDialogProps) {
  const ids = { prompt: useId(), model: useId() };
  const [model, setModel] = useState(models[0]?.id ?? "");
  const spec = models.find((m) => m.id === model);
  const [duration, setDuration] = useState<number | null>(
    spec?.durationsSeconds[0] ?? null,
  );
  const [prompt, setPrompt] = useState("");
  const debouncedPrompt = useDebounced(prompt, ESTIMATE_DEBOUNCE_MS);

  const request = useMemo(
    () => videoRequest(source, spec, duration, debouncedPrompt),
    [source, spec, duration, debouncedPrompt],
  );
  const estimate = useVideoEstimate(influencerId, request);
  const generate = useGenerateVideo(influencerId);

  const cost = estimate.data?.estimate;
  const overBudget = estimate.data !== undefined && !estimate.data.fits;
  const typing = prompt !== debouncedPrompt;
  const ready = videoRequest(source, spec, duration, prompt);
  const error = generate.error;
  const budgetRejected =
    isApiRequestError(error) && error.details?.["reason"] === "budget_exceeded";

  const close = () => {
    setPrompt("");
    generate.reset();
    onClose();
  };

  return (
    <Dialog open={source !== null} onClose={close} size="md">
      <DialogHeader>
        <DialogTitle>{tw("influencers.animate.title")}</DialogTitle>
        <DialogClose label={tw("influencers.wizard.cancel")} />
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-4">
          {source !== null && (
            <img
              src={source.url}
              alt=""
              className="aspect-[9/16] max-h-56 self-start rounded-xl object-cover"
            />
          )}
          {models.length === 0 ? (
            <p className="m-0 text-sm text-text-muted">
              {tw("influencers.animate.noModels")}
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <label htmlFor={ids.prompt} className="text-sm font-medium text-text">
                  {tw("influencers.animate.prompt")}
                </label>
                <Textarea
                  id={ids.prompt}
                  rows={2}
                  maxLength={INFLUENCER_VIDEO_PROMPT_MAX}
                  placeholder={tw("influencers.animate.placeholder")}
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor={ids.model} className="text-sm font-medium text-text">
                  {tw("aiStudio.model.label")}
                </label>
                <Select
                  id={ids.model}
                  value={model}
                  options={models.map((m) => ({ value: m.id, label: m.label }))}
                  onChange={(e) => {
                    const next = models.find((m) => m.id === e.target.value);
                    setModel(e.target.value);
                    setDuration(
                      next === undefined
                        ? null
                        : duration !== null && next.durationsSeconds.includes(duration)
                          ? duration
                          : (next.durationsSeconds[0] ?? null),
                    );
                  }}
                />
              </div>
              {spec !== undefined && duration !== null && (
                <ChoiceChips
                  name="influencer-video-duration"
                  label={tw("aiStudio.duration.label")}
                  value={duration}
                  onChange={setDuration}
                  choices={spec.durationsSeconds.map((s) => ({
                    value: s,
                    label: tw("aiStudio.duration.value", { seconds: s }),
                  }))}
                />
              )}
              <div aria-live="polite" data-testid="influencer-video-estimate">
                <span className="text-xs text-text-muted">
                  {tw("influencers.images.estimate")}
                </span>{" "}
                <span className="font-semibold tabular-nums text-text">
                  {cost === undefined || typing ? "—" : formatUsd(cost.usd)}
                </span>
                <p
                  className={cn(
                    "m-0 text-xs",
                    overBudget || estimate.isError ? "text-danger" : "text-text-subtle",
                  )}
                >
                  {estimate.isFetching || typing
                    ? tw("influencers.images.estimating")
                    : estimate.isError
                      ? (estimate.error.serverMessage ??
                        tw("influencers.images.failedToStart"))
                      : overBudget
                        ? tw("influencers.images.overBudget", {
                            remaining: formatUsd(estimate.data?.budget.remainingUsd ?? 0),
                          })
                        : " "}
                </p>
              </div>
              {generate.isError && (
                <p className="m-0 text-sm text-danger" role="alert">
                  {budgetRejected
                    ? tw("influencers.images.budgetExceeded")
                    : (error?.serverMessage ?? tw("influencers.images.failedToStart"))}
                </p>
              )}
            </>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={close}>
          {tw("influencers.wizard.cancel")}
        </Button>
        <Button
          loading={generate.isPending}
          disabled={ready === null || overBudget || generate.isPending}
          onClick={() => {
            if (ready === null) return;
            generate.mutate(ready, {
              onSuccess: () => {
                close();
                onStarted();
              },
            });
          }}
        >
          {tw("influencers.animate.generate")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
