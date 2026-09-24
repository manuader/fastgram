"use client";

import type { SwapRunRequest } from "@fastgram/contracts";
import { Skeleton } from "@fastgram/ui";
import { useMemo, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw } from "@/lib/i18n/t";
import {
  EstimateAndGenerate,
  PortraitPicker,
  SpeakingRunProgress,
  VideoPicker,
  VoiceSetupState,
} from "./SpeakingFormatStudio";
import { useSpeakingOptions, useStartVoiceRun, useVoiceEstimate } from "./speaking-api";

interface Picked {
  readonly mediaId: string;
  readonly url: string;
}

export interface SwapFormState {
  readonly characterId: string | null;
  readonly portrait: Picked | null;
  readonly source: Picked | null;
}

/** El cuerpo de estimar/generar, o `null` si falta algo. */
export function toSwapRequest(form: SwapFormState): SwapRunRequest | null {
  if (form.source === null) return null;
  if (form.characterId === null && form.portrait === null) return null;
  return {
    sourceMediaId: form.source.mediaId,
    ...(form.characterId === null
      ? { portraitMediaId: (form.portrait as Picked).mediaId }
      : { characterModelId: form.characterId }),
    // Sin guion no hay de dónde sacar un caption: el video va limpio.
    caption: null,
  };
}

/**
 * `character-swap` (`F-070`): el personaje de un video tuyo pasa a ser el de
 * un modelo de la biblioteca (o un retrato del Media Bank), con Wan 2.2
 * Animate Replace en fal. Sprint 8 (agente L).
 */
export function CharacterSwapStudio({ header }: { readonly header: React.ReactNode }) {
  const options = useSpeakingOptions();
  const [runId, setRunId] = useState<string | null>(null);
  const [form, setForm] = useState<SwapFormState | null>(null);
  const request = useMemo(() => (form === null ? null : toSwapRequest(form)), [form]);
  const estimate = useVoiceEstimate("swap", request);
  const start = useStartVoiceRun("swap");

  if (options.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        {header}
        <Skeleton height={260} className="rounded-2xl" />
      </div>
    );
  }
  if (options.isError) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <ApiErrorState
          error={options.error}
          onRetry={() => {
            void options.refetch();
          }}
        />
      </div>
    );
  }
  const o = options.data;
  if (runId !== null) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <SpeakingRunProgress
          runId={runId}
          onReset={() => {
            setRunId(null);
            start.reset();
          }}
        />
      </div>
    );
  }
  if (!o.swap.configured) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <VoiceSetupState swap />
      </div>
    );
  }
  const f: SwapFormState = form ?? {
    characterId: (o.characters ?? []).find((c) => c.status === "ready")?.id ?? null,
    portrait: null,
    source: null,
  };
  return (
    <div className="flex flex-col gap-4">
      {header}
      <section className="flex flex-col gap-5 rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <VideoPicker
          label={tw("speaking.swap.source")}
          hint={tw("speaking.swap.sourceHint", { seconds: o.swapMaxSourceSeconds })}
          picked={f.source}
          onPick={(source) => {
            setForm({ ...f, source });
          }}
        />
        <PortraitPicker
          characters={o.characters}
          characterId={f.characterId}
          portrait={f.portrait}
          hint={null}
          onCharacter={(characterId) => {
            setForm({ ...f, characterId, portrait: null });
          }}
          onPortrait={(portrait) => {
            setForm({ ...f, characterId: null, portrait });
          }}
        />
        <p className="m-0 rounded-xl bg-surface-sunken p-3 text-xs text-text-muted">
          {tw("speaking.swap.noAudio")}
        </p>
        <EstimateAndGenerate
          estimate={estimate}
          idle={request === null}
          typing={false}
          budget={o.budget}
          pending={start.isPending}
          disabled={request === null || start.isPending}
          error={start.error}
          onGenerate={() => {
            if (request === null) return;
            start.mutate(request, {
              onSuccess: (run) => {
                setRunId(run.id);
              },
            });
          }}
        />
      </section>
    </div>
  );
}
