"use client";

import type {
  SpeakingCharacter,
  SpeakingOptions,
  SpeakingRun,
  SpeakingRunRequest,
} from "@fastgram/contracts";
import { SPEAKING_SCRIPT_MAX_CHARS, SPEAKING_TOPIC_MAX_CHARS } from "@fastgram/contracts";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Textarea,
  buttonVariants,
  cn,
} from "@fastgram/ui";
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { BudgetMeter } from "@/components/ai-studio/BudgetMeter";
import { ChoiceChips } from "@/components/ai-studio/ChoiceChips";
import { MediaPickerDialog } from "@/components/editor/MediaPickerDialog";
import { editorHref } from "@/components/editor/ContentEditor";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { UserIcon, WandIcon } from "@/icons";
import { isApiRequestError } from "@/lib/api/errors";
import { flattenItems, useMediaPicker } from "@/lib/editor/api";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { formatUsd } from "@/lib/models/budget";
import { ROUTES } from "@/lib/nav/routes";
import {
  isSpeakingRunInFlight,
  useGenerateScript,
  useSpeakingOptions,
  useSpeakingRun,
  useStartVoiceRun,
  useVoiceEstimate,
} from "./speaking-api";

const ESTIMATE_DEBOUNCE_MS = 600;

/** Idiomas que se ofrecen (ISO 639-1). Los dos modelos de voz los aceptan. */
export const SPEAKING_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "pt", label: "Portuguese" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
];

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

/** Un retrato o video elegido del Media Bank. */
interface Picked {
  readonly mediaId: string;
  readonly url: string;
}

export interface SpeakingFormState {
  readonly characterId: string | null;
  readonly portrait: Picked | null;
  readonly demo: Picked | null;
  readonly script: string;
  readonly durationSeconds: number;
  readonly languageCode: string;
  /** `""` = la del modelo de la biblioteca o la default del modelo de voz. */
  readonly voiceId: string;
  readonly caption: boolean;
}

export function countWords(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/**
 * La guía en vivo de `AI-010` (la misma cuenta que `core`): 2 a 3 palabras
 * por segundo, con el mensaje literal del PRD para un guion corto.
 */
export function scriptHint(
  script: string,
  durationSeconds: number,
  wordsPerSecond: { readonly min: number; readonly max: number } = { min: 2, max: 3 },
): { level: "ok" | "short" | "long"; message: string } {
  const words = countWords(script);
  const min = Math.round(durationSeconds * wordsPerSecond.min);
  const max = Math.round(durationSeconds * wordsPerSecond.max);
  const range = `Target ${String(min)}-${String(max)} words`;
  if (words < min) {
    return {
      level: "short",
      message: `${String(words)} words may be too short for ${String(durationSeconds)}s - ${range}`,
    };
  }
  if (words > max) {
    return {
      level: "long",
      message: `${String(words)} words may be too long for ${String(durationSeconds)}s - ${range}`,
    };
  }
  return { level: "ok", message: tw("speaking.script.onTarget", { words, min, max }) };
}

/** El cuerpo de estimar/generar, o `null` si todavía no se puede pedir. */
export function toSpeakingRequest(form: SpeakingFormState): SpeakingRunRequest | null {
  const script = form.script.trim();
  if (script === "" || script.length > SPEAKING_SCRIPT_MAX_CHARS) return null;
  if (form.characterId === null && form.portrait === null) return null;
  return {
    script,
    durationSeconds: form.durationSeconds,
    languageCode: form.languageCode,
    ...(form.caption ? {} : { caption: null }),
    ...(form.characterId === null
      ? { portraitMediaId: (form.portrait as Picked).mediaId }
      : { characterModelId: form.characterId }),
    ...(form.voiceId === "" ? {} : { voiceId: form.voiceId }),
    ...(form.demo === null ? {} : { demoMediaId: form.demo.mediaId }),
  };
}

const STAGE_COPY: Readonly<Record<SpeakingRun["stage"], CopyKey>> = {
  queued: "formats.run.queued",
  voice: "speaking.run.voice",
  video: "speaking.run.video",
  building: "speaking.run.building",
  ready: "formats.run.ready",
  failed: "formats.run.failed",
  nsfw: "formats.run.nsfw",
};

/** Una corrida con voz o de swap: etapas, el video, la voz y el editor. */
export function SpeakingRunProgress({
  runId,
  onReset,
}: {
  readonly runId: string;
  readonly onReset?: () => void;
}) {
  const run = useSpeakingRun(runId);
  if (run.isPending) return <Skeleton height={120} className="rounded-2xl" />;
  if (run.isError) {
    return (
      <ApiErrorState
        error={run.error}
        onRetry={() => {
          void run.refetch();
        }}
      />
    );
  }
  const r = run.data;
  const steps: SpeakingRun["stage"][] =
    r.kind === "swap"
      ? ["queued", "video", "building", "ready"]
      : ["queued", "voice", "video", "building", "ready"];
  const current = steps.indexOf(r.stage);
  return (
    <section
      aria-labelledby={`speaking-run-${r.id}`}
      className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5"
      data-testid="speaking-run"
    >
      <h2 id={`speaking-run-${r.id}`} className="m-0 text-lg font-semibold text-text">
        {tw(STAGE_COPY[r.stage])}
      </h2>
      {r.stage !== "failed" && r.stage !== "nsfw" && (
        <ol
          className="m-0 flex list-none flex-wrap gap-2 p-0"
          aria-busy={isSpeakingRunInFlight(r)}
        >
          {steps.map((s, i) => (
            <li key={s}>
              <Badge
                size="sm"
                tone={i < current ? "success" : i === current ? "info" : "neutral"}
              >
                {tw(STAGE_COPY[s])}
              </Badge>
            </li>
          ))}
        </ol>
      )}
      {isSpeakingRunInFlight(r) && (
        <p className="m-0 text-sm text-text-muted">{tw("speaking.run.wait")}</p>
      )}
      {r.voiceUrl !== null && r.video === null && (
        <audio src={r.voiceUrl} controls className="w-full max-w-sm">
          <track kind="captions" />
        </audio>
      )}
      {r.video !== null && (
        <video
          src={r.video.url}
          className="aspect-[9/16] max-h-80 self-start rounded-xl bg-surface-sunken"
          playsInline
          controls
        />
      )}
      {r.error !== null && (
        <p className="m-0 text-sm text-danger" role="alert">
          {r.error.message}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {r.stage === "ready" && r.contentId !== null && (
          <Link href={editorHref(r.contentId)} className={buttonVariants({ size: "md" })}>
            {tw("formats.run.openEditor")}
          </Link>
        )}
        {!isSpeakingRunInFlight(r) && onReset !== undefined && (
          <Button variant="secondary" onClick={onReset}>
            {tw("formats.run.again")}
          </Button>
        )}
      </div>
    </section>
  );
}

/** Settings → Models no tiene lo que hace falta: se dice qué y dónde. */
export function VoiceSetupState({ swap = false }: { readonly swap?: boolean }) {
  return (
    <EmptyState
      bordered
      title={tw("speaking.setup.title")}
      description={tw(swap ? "speaking.setup.swapBody" : "speaking.setup.body")}
      action={
        <Link
          href={ROUTES.settingsModels}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          {tw("aiStudio.setup.action")}
        </Link>
      }
    />
  );
}

/** Elegir el retrato: un modelo de la biblioteca o una imagen del Media Bank. */
export function PortraitPicker({
  characters,
  characterId,
  portrait,
  hint,
  onCharacter,
  onPortrait,
}: {
  readonly characters: readonly SpeakingCharacter[] | null;
  readonly characterId: string | null;
  readonly portrait: Picked | null;
  readonly hint: string | null;
  readonly onCharacter: (id: string) => void;
  readonly onPortrait: (picked: Picked) => void;
}) {
  const [open, setOpen] = useState(false);
  const media = useMediaPicker("image", open);
  const ready = (characters ?? []).filter((c) => c.status === "ready");
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1 text-sm font-medium text-text">
        {tw("speaking.portrait.label")}
      </legend>
      {hint !== null && <p className="m-0 text-xs text-text-muted">{hint}</p>}
      {ready.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {ready.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                aria-pressed={characterId === c.id}
                onClick={() => {
                  onCharacter(c.id);
                }}
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-2 py-1.5 text-sm",
                  characterId === c.id
                    ? "border-accent bg-accent/10 text-text"
                    : "border-border bg-surface text-text-muted hover:text-text",
                )}
              >
                <img
                  src={c.portraitUrl}
                  alt=""
                  className="size-8 rounded-lg object-cover"
                />
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-xs text-text-subtle">
          {characters === null
            ? tw("speaking.portrait.libraryDown")
            : tw("speaking.portrait.noModels")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<UserIcon size={14} />}
          onClick={() => {
            setOpen(true);
          }}
        >
          {tw("speaking.portrait.pick")}
        </Button>
        {characterId === null && portrait !== null && (
          <span className="flex items-center gap-2 text-xs text-text-muted">
            <img src={portrait.url} alt="" className="size-8 rounded-lg object-cover" />
            {tw("aiStudio.image.picked")}
          </span>
        )}
      </div>
      <MediaPickerDialog
        open={open}
        type="image"
        title={tw("speaking.portrait.pickTitle")}
        onCancel={() => {
          setOpen(false);
        }}
        onPick={(url) => {
          const m = flattenItems(media.data).find((x) => x.r2Url === url);
          if (m !== undefined) onPortrait({ mediaId: m.mediaId, url });
          setOpen(false);
        }}
      />
    </fieldset>
  );
}

/** Elegir un video del Media Bank (el demo, o el de origen de un swap). */
export function VideoPicker({
  label,
  hint,
  picked,
  onPick,
}: {
  readonly label: string;
  readonly hint: string | null;
  readonly picked: Picked | null;
  readonly onPick: (picked: Picked) => void;
}) {
  const [open, setOpen] = useState(false);
  const media = useMediaPicker("video", open);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-text">{label}</span>
      {hint !== null && <p className="m-0 text-xs text-text-muted">{hint}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setOpen(true);
          }}
        >
          {tw(picked === null ? "speaking.video.pick" : "speaking.video.change")}
        </Button>
        {picked !== null && (
          <video
            src={picked.url}
            className="h-20 rounded-lg bg-surface-sunken"
            muted
            playsInline
          />
        )}
      </div>
      <MediaPickerDialog
        open={open}
        type="video"
        title={label}
        onCancel={() => {
          setOpen(false);
        }}
        onPick={(url) => {
          const m = flattenItems(media.data).find((x) => x.r2Url === url);
          if (m !== undefined) onPick({ mediaId: m.mediaId, url });
          setOpen(false);
        }}
      />
    </div>
  );
}

/** El costo estimado, el tope y el botón. Compartido con el swap. */
export function EstimateAndGenerate({
  estimate,
  idle,
  typing,
  budget,
  pending,
  disabled,
  error,
  onGenerate,
}: {
  readonly estimate: ReturnType<typeof useVoiceEstimate>;
  readonly idle: boolean;
  readonly typing: boolean;
  readonly budget: SpeakingOptions["budget"];
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly error: ReturnType<typeof useStartVoiceRun>["error"];
  readonly onGenerate: () => void;
}) {
  const overBudget = estimate.data !== undefined && !estimate.data.fits;
  const budgetRejected =
    isApiRequestError(error) && error.details?.["reason"] === "budget_exceeded";
  return (
    <>
      <div
        className="flex flex-col gap-3 rounded-xl bg-surface-sunken p-4"
        aria-live="polite"
        data-testid="speaking-estimate"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-text-muted">{tw("aiStudio.estimate.label")}</span>
          <span className="text-2xl font-semibold tabular-nums text-text">
            {estimate.data === undefined || typing ? "—" : formatUsd(estimate.data.usd)}
          </span>
        </div>
        {estimate.data !== undefined && !typing && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-text-subtle">
            {estimate.data.voice !== null && (
              <li>
                {tw("speaking.estimate.voice", {
                  usd: formatUsd(estimate.data.voice.estimate.usd),
                  basis: estimate.data.voice.estimate.basis,
                })}
              </li>
            )}
            <li>
              {tw("speaking.estimate.video", {
                usd: formatUsd(estimate.data.video.estimate.usd),
                basis: estimate.data.video.estimate.basis,
              })}
            </li>
          </ul>
        )}
        <p
          className={cn(
            "m-0 text-xs",
            overBudget || estimate.isError ? "text-danger" : "text-text-subtle",
          )}
        >
          {idle
            ? tw("speaking.estimate.idle")
            : estimate.isFetching || typing
              ? tw("aiStudio.estimate.loading")
              : estimate.isError
                ? (estimate.error.serverMessage ?? tw("aiStudio.estimate.error"))
                : overBudget
                  ? tw("aiStudio.estimate.overBudget", {
                      remaining: formatUsd(estimate.data?.budget.remainingUsd ?? 0),
                    })
                  : " "}
        </p>
        <BudgetMeter summary={estimate.data?.budget ?? budget} />
      </div>
      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          leadingIcon={<WandIcon size={16} />}
          loading={pending}
          disabled={disabled || overBudget}
          onClick={onGenerate}
        >
          {pending ? tw("aiStudio.generating") : tw("aiStudio.generate")}
        </Button>
        <div aria-live="polite" className="min-h-5">
          {error !== null && (
            <p className="m-0 text-sm text-danger" role="alert">
              {budgetRejected
                ? tw("aiStudio.generate.budgetExceeded")
                : (error.serverMessage ?? tw("aiStudio.generate.error"))}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

export interface SpeakingFormProps {
  /** Un formato con voz de `F-070`. */
  readonly formatId: string;
  readonly options: SpeakingOptions;
  /** `P4-INFL-011`: el modelo ya está elegido (pantalla del modelo). */
  readonly fixedCharacterId?: string | undefined;
  readonly source?: "studio" | "influencer";
  readonly onStarted: (run: SpeakingRun) => void;
}

/** El formulario de un formato con voz. Supone la voz y el avatar configurados. */
export function SpeakingForm({
  formatId,
  options,
  fixedCharacterId,
  source = "studio",
  onStarted,
}: SpeakingFormProps) {
  const ids = {
    script: useId(),
    topic: useId(),
    voice: useId(),
    language: useId(),
    caption: useId(),
  };
  const info = options.formats.find((f) => f.id === formatId);
  const readyCharacters = (options.characters ?? []).filter((c) => c.status === "ready");
  const firstCharacter = fixedCharacterId ?? readyCharacters[0]?.id ?? null;
  const preferred = info?.preferredDurationSeconds ?? 15;
  const [form, setForm] = useState<SpeakingFormState>(() => ({
    characterId: firstCharacter,
    portrait: null,
    demo: null,
    script: "",
    durationSeconds: options.durations.includes(preferred)
      ? preferred
      : (options.durations[0] ?? 5),
    languageCode: "en",
    voiceId: "",
    caption: true,
  }));
  const [topic, setTopic] = useState("");
  const writer = useGenerateScript(formatId);
  const debounced = useDebounced(form, ESTIMATE_DEBOUNCE_MS);
  const request = useMemo(() => toSpeakingRequest(debounced), [debounced]);
  const estimate = useVoiceEstimate(formatId, request);
  const start = useStartVoiceRun(formatId, source);

  const character = readyCharacters.find((c) => c.id === form.characterId) ?? null;
  const speech = options.speech.models.find((m) => m.id === options.speech.defaultModel);
  const hint = scriptHint(form.script, form.durationSeconds, options.wordsPerSecond);
  const needsDemo = info !== undefined && info.layout !== "full";
  const ready = toSpeakingRequest(form);
  const canGenerate =
    ready !== null && (!needsDemo || form.demo !== null) && !start.isPending;

  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-border bg-surface p-5 shadow-sm">
      {fixedCharacterId === undefined && (
        <PortraitPicker
          characters={options.characters}
          characterId={form.characterId}
          portrait={form.portrait}
          hint={info?.portraitHint ?? null}
          onCharacter={(characterId) => {
            setForm({ ...form, characterId, portrait: null, voiceId: "" });
          }}
          onPortrait={(portrait) => {
            setForm({ ...form, characterId: null, portrait, voiceId: "" });
          }}
        />
      )}
      {needsDemo && (
        <VideoPicker
          label={tw("speaking.demo.label")}
          hint={info.demoHint}
          picked={form.demo}
          onPick={(demo) => {
            setForm({ ...form, demo });
          }}
        />
      )}
      <ChoiceChips
        name={`speaking-duration-${formatId}`}
        label={tw("aiStudio.duration.label")}
        value={form.durationSeconds}
        onChange={(durationSeconds) => {
          setForm({ ...form, durationSeconds });
        }}
        choices={options.durations.map((s) => ({
          value: s,
          label: tw("aiStudio.duration.value", { seconds: s }),
        }))}
      />
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={ids.script} className="text-sm font-medium text-text">
            {tw("speaking.script.label")}
          </label>
          <span
            className={cn(
              "text-xs",
              hint.level === "ok" ? "text-text-subtle" : "text-warning",
            )}
            aria-live="polite"
            data-testid="script-hint"
          >
            {hint.message}
          </span>
        </div>
        <Textarea
          id={ids.script}
          rows={5}
          maxLength={SPEAKING_SCRIPT_MAX_CHARS}
          placeholder={tw("speaking.script.placeholder")}
          value={form.script}
          onChange={(e) => {
            setForm({ ...form, script: e.target.value });
          }}
        />
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <label htmlFor={ids.topic} className="text-xs text-text-muted">
              {tw("speaking.script.topic")}
            </label>
            <Input
              id={ids.topic}
              maxLength={SPEAKING_TOPIC_MAX_CHARS}
              placeholder={tw("speaking.script.topicPlaceholder")}
              value={topic}
              onChange={(e) => {
                setTopic(e.target.value);
              }}
            />
          </div>
          <Button
            variant="secondary"
            size="md"
            loading={writer.isPending}
            disabled={!options.scriptWriter || writer.isPending}
            onClick={() => {
              writer.mutate(
                {
                  durationSeconds: form.durationSeconds,
                  languageCode: form.languageCode,
                  ...(topic.trim() === "" ? {} : { topic: topic.trim() }),
                },
                {
                  onSuccess: (r) => {
                    setForm((f) => ({ ...f, script: r.script }));
                  },
                },
              );
            }}
          >
            {tw("speaking.script.generate")}
          </Button>
        </div>
        {!options.scriptWriter && (
          <p className="m-0 text-xs text-text-subtle">{tw("speaking.script.noWriter")}</p>
        )}
        {writer.isError && (
          <p className="m-0 text-xs text-danger" role="alert">
            {writer.error.serverMessage ?? tw("speaking.script.failed")}
          </p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label htmlFor={ids.voice} className="text-sm font-medium text-text">
            {tw("speaking.voice.label")}
          </label>
          <Select
            id={ids.voice}
            value={form.voiceId}
            options={[
              {
                value: "",
                label:
                  character?.voice !== null && character?.voice !== undefined
                    ? tw("speaking.voice.model", { voice: character.voice.voiceId })
                    : tw("speaking.voice.default", {
                        voice: speech?.defaultVoice ?? "—",
                      }),
              },
              ...(speech?.voices ?? []).map((v) => ({ value: v, label: v })),
            ]}
            onChange={(e) => {
              setForm({ ...form, voiceId: e.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor={ids.language} className="text-sm font-medium text-text">
            {tw("speaking.language.label")}
          </label>
          <Select
            id={ids.language}
            value={form.languageCode}
            options={SPEAKING_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
            onChange={(e) => {
              setForm({ ...form, languageCode: e.target.value });
            }}
          />
        </div>
      </div>
      <Checkbox
        id={ids.caption}
        checked={form.caption}
        label={tw("speaking.caption.label")}
        onChange={(e) => {
          setForm({ ...form, caption: e.target.checked });
        }}
      />
      <EstimateAndGenerate
        estimate={estimate}
        idle={request === null}
        typing={form !== debounced}
        budget={options.budget}
        pending={start.isPending}
        disabled={!canGenerate}
        error={start.error}
        onGenerate={() => {
          if (ready === null) return;
          start.mutate(ready, { onSuccess: onStarted });
        }}
      />
    </section>
  );
}

/** La pantalla de un formato con voz (`/content/<id>`), montada por `GenerativeFormatStudio`. */
export function SpeakingFormatStudio({
  formatId,
  header,
}: {
  readonly formatId: string;
  readonly header: React.ReactNode;
}) {
  const options = useSpeakingOptions();
  const [runId, setRunId] = useState<string | null>(null);
  if (options.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        {header}
        <Skeleton height={320} className="rounded-2xl" />
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
  return (
    <div className="flex flex-col gap-4">
      {header}
      {runId !== null ? (
        <SpeakingRunProgress
          runId={runId}
          onReset={() => {
            setRunId(null);
          }}
        />
      ) : !o.speech.configured || !o.avatar.configured ? (
        <VoiceSetupState />
      ) : (
        <SpeakingForm
          formatId={formatId}
          options={o}
          onStarted={(run) => {
            setRunId(run.id);
          }}
        />
      )}
    </div>
  );
}
