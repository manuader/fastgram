"use client";

import { EmptyState, Skeleton } from "@fastgram/ui";
import { useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw } from "@/lib/i18n/t";
import {
  SpeakingForm,
  SpeakingRunProgress,
  VoiceSetupState,
} from "./SpeakingFormatStudio";
import { useSpeakingOptions, useSpeakingRuns } from "./speaking-api";

export interface TalkingHeadPanelProps {
  /** El id del modelo de la biblioteca (contrato `GET /character-models`). */
  readonly characterModelId: string;
}

/**
 * «Talking head» en el detalle de un modelo — `P4-INFL-011`, `F-098`,
 * `AI-010`. Guion (con la guía de largo del PRD) → voz del modelo → video con
 * el retrato del modelo → pieza en la Library.
 *
 * Lo exporta el agente L y lo monta la pantalla del modelo (del agente K):
 * `<TalkingHeadPanel characterModelId={model.id} />`. Todo lo que necesita lo
 * pide solo; no depende de la pantalla que lo monta.
 */
export function TalkingHeadPanel({ characterModelId }: TalkingHeadPanelProps) {
  const options = useSpeakingOptions();
  const runs = useSpeakingRuns(characterModelId);
  const [runId, setRunId] = useState<string | null>(null);

  if (options.isPending) {
    return <Skeleton height={320} className="rounded-2xl" aria-busy="true" />;
  }
  if (options.isError) {
    return (
      <ApiErrorState
        error={options.error}
        onRetry={() => {
          void options.refetch();
        }}
      />
    );
  }
  const o = options.data;
  if (!o.speech.configured || !o.avatar.configured) return <VoiceSetupState />;
  const character = o.characters?.find((c) => c.id === characterModelId);
  if (character !== undefined && character.status !== "ready") {
    return (
      <EmptyState
        bordered
        title={tw("speaking.talkingHead.notReady")}
        description={tw("speaking.talkingHead.notReadyBody")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {runId !== null ? (
        <SpeakingRunProgress
          runId={runId}
          onReset={() => {
            setRunId(null);
          }}
        />
      ) : (
        <SpeakingForm
          formatId="talking-head-ugc"
          options={o}
          fixedCharacterId={characterModelId}
          source="influencer"
          onStarted={(run) => {
            setRunId(run.id);
          }}
        />
      )}
      <section aria-labelledby="talking-head-history" className="flex flex-col gap-3">
        <h3 id="talking-head-history" className="m-0 text-sm font-semibold text-text">
          {tw("speaking.talkingHead.history")}
        </h3>
        {runs.isPending ? (
          <Skeleton height={80} className="rounded-xl" />
        ) : runs.isError ? (
          <ApiErrorState
            error={runs.error}
            onRetry={() => {
              void runs.refetch();
            }}
          />
        ) : runs.data.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">
            {tw("speaking.talkingHead.empty")}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {runs.data
              .filter((r) => r.id !== runId)
              .map((r) => (
                <li key={r.id}>
                  <SpeakingRunProgress runId={r.id} />
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
