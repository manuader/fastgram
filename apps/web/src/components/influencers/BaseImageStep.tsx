"use client";

import type { InfluencerBaseImageRequest } from "@fastgram/contracts";
import { Button, Skeleton, Textarea, cn } from "@fastgram/ui";
import { useEffect, useId, useState } from "react";
import { WandIcon } from "@/icons";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import type { WizardForm } from "@/lib/influencers/form";
import { formatUsd } from "@/lib/models/budget";
import { useBaseGeneration, useBaseImageEstimate, useGenerateBaseImage } from "./api";

/** La descripción del paso 1 → el cuerpo de la imagen base. */
export function baseImageRequest(
  form: Pick<WizardForm, "gender" | "age" | "ethnicity" | "details">,
  instructions: string,
): InfluencerBaseImageRequest {
  const ethnicity = form.ethnicity.trim();
  const details = form.details.trim();
  const extra = instructions.trim();
  return {
    ...(form.gender === "" ? {} : { gender: form.gender }),
    ...(form.age === null ? {} : { age: form.age }),
    ...(ethnicity === "" ? {} : { ethnicity }),
    ...(details === "" ? {} : { details }),
    ...(extra === "" ? {} : { instructions: extra }),
  };
}

export interface BaseImageStepProps {
  readonly form: WizardForm;
  /** El id de la imagen base elegida (Media Bank), o `null` mientras no hay. */
  readonly onChange: (
    base: { readonly mediaId: string; readonly url: string } | null,
  ) => void;
}

/**
 * Paso 2 con «Generate base image» — `F-091`, `F-093`, `P4-INFL-003`.
 *
 * Genera la imagen base desde la descripción del paso 1 con el modelo de
 * imagen de Settings → Models (es una generación de AI Studio: mismo tope,
 * queda en el Media Bank). «Regenerate» pide **otra persona**, no una edición
 * (literal de `FR-080`), con instrucciones opcionales.
 */
export function BaseImageStep({ form, onChange }: BaseImageStepProps) {
  const instructionsId = useId();
  const [instructions, setInstructions] = useState("");
  const [generationId, setGenerationId] = useState<string | null>(null);
  const body = baseImageRequest(form, instructions);
  const described = Object.keys(baseImageRequest(form, "")).length > 0;
  const estimate = useBaseImageEstimate(described ? baseImageRequest(form, "") : null);
  const generate = useGenerateBaseImage();
  const generation = useBaseGeneration(generationId);

  const g = generation.data;
  const media = g?.status === "ready" ? g.media[0] : undefined;
  const inFlight =
    g !== undefined && (g.status === "queued" || g.status === "generating");
  const overBudget = estimate.data !== undefined && !estimate.data.fits;
  const error = generate.error;

  const run = () => {
    onChange(null);
    generate.mutate(body, {
      onSuccess: (created) => {
        setGenerationId(created.id);
      },
    });
  };

  // Cuando la base queda lista, el wizard puede seguir.
  const readyId = media?.mediaId;
  const readyUrl = media?.url;
  useEffect(() => {
    if (readyId !== undefined && readyUrl !== undefined) {
      onChange({ mediaId: readyId, url: readyUrl });
    }
  }, [readyId, readyUrl, onChange]);

  if (!described) {
    return (
      <p className="m-0 text-sm text-text-muted">
        {tw("influencers.base.describeFirst")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-sm text-text-muted">{tw("influencers.base.intro")}</p>
      <div
        className="flex aspect-[9/16] w-40 items-center justify-center overflow-hidden rounded-xl bg-surface-sunken"
        aria-busy={inFlight || generate.isPending}
        data-testid="influencer-base-image"
      >
        {media !== undefined ? (
          <img
            src={media.url}
            alt={tw("influencers.base.alt")}
            className="h-full w-full object-cover"
          />
        ) : inFlight || generate.isPending ? (
          <Skeleton className="h-full w-full" />
        ) : g !== undefined && g.error !== null ? (
          <span className="p-2 text-center text-xs text-danger">{g.error.message}</span>
        ) : (
          <WandIcon size={20} className="text-text-subtle" />
        )}
      </div>
      {generationId !== null && (
        <div className="flex flex-col gap-2">
          <label htmlFor={instructionsId} className="text-sm font-medium text-text">
            {tw("influencers.base.instructions")}
          </label>
          <Textarea
            id={instructionsId}
            rows={2}
            maxLength={500}
            placeholder={tw("influencers.base.instructionsPlaceholder")}
            value={instructions}
            onChange={(e) => {
              setInstructions(e.target.value);
            }}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={generationId === null ? "primary" : "secondary"}
          leadingIcon={<WandIcon size={16} />}
          loading={generate.isPending}
          disabled={generate.isPending || inFlight || overBudget}
          onClick={run}
        >
          {generationId === null
            ? tw("influencers.base.generate")
            : tw("influencers.base.regenerate")}
        </Button>
        <span
          className={cn(
            "text-xs tabular-nums",
            overBudget || estimate.isError ? "text-danger" : "text-text-subtle",
          )}
          aria-live="polite"
        >
          {estimate.isFetching
            ? tw("influencers.images.estimating")
            : estimate.isError
              ? (estimate.error.serverMessage ?? tw("influencers.images.failedToStart"))
              : estimate.data === undefined
                ? " "
                : overBudget
                  ? tw("influencers.images.overBudget", {
                      remaining: formatUsd(estimate.data.budget.remainingUsd),
                    })
                  : tw("influencers.base.cost", {
                      cost: formatUsd(estimate.data.estimate.usd),
                    })}
        </span>
      </div>
      {generationId !== null && (
        <p className="m-0 text-xs text-text-subtle">{tw("influencers.base.newPerson")}</p>
      )}
      {generate.isError && (
        <p className="m-0 text-sm text-danger" role="alert">
          {isApiRequestError(error) && error.details?.["reason"] === "budget_exceeded"
            ? tw("influencers.images.budgetExceeded")
            : (error?.serverMessage ?? tw("influencers.images.failedToStart"))}
        </p>
      )}
    </div>
  );
}
