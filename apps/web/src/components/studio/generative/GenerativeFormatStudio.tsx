"use client";

import type { FormatRun, FormatRunRequest, GenModelSpec } from "@fastgram/contracts";
import {
  FORMAT_RUN_OVERLAY_MAX_CHARS,
  FORMAT_RUN_TOPIC_MAX_CHARS,
} from "@fastgram/contracts";
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
import { editorHref } from "@/components/editor/ContentEditor";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { ClapperboardIcon, WandIcon } from "@/icons";
import { isApiRequestError } from "@/lib/api/errors";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { formatUsd } from "@/lib/models/budget";
import { ROUTES } from "@/lib/nav/routes";
import {
  isRunInFlight,
  useFormatEstimate,
  useFormatRun,
  useGenerativeFormats,
  useStartFormatRun,
} from "./api";

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

interface FormState {
  readonly overlayText: string;
  readonly topic: string;
  readonly includeBrand: boolean;
  readonly model: string;
  readonly durationSeconds: number | null;
}

/** La duración inicial: la preferida del formato si el modelo la acepta. */
function initialDuration(spec: GenModelSpec | undefined, preferred: number | null) {
  if (spec === undefined || spec.durationsSeconds.length === 0) return null;
  if (preferred !== null && spec.durationsSeconds.includes(preferred)) return preferred;
  return spec.durationsSeconds[0] ?? null;
}

/** El cuerpo de estimar/generar, o `null` si todavía no se puede pedir. */
export function toFormatRunRequest(form: FormState): FormatRunRequest | null {
  const overlayText = form.overlayText.trim();
  if (overlayText === "" || overlayText.length > FORMAT_RUN_OVERLAY_MAX_CHARS)
    return null;
  if (form.topic.length > FORMAT_RUN_TOPIC_MAX_CHARS) return null;
  if (form.model === "") return null;
  return {
    overlayText,
    ...(form.topic.trim() === "" ? {} : { topic: form.topic.trim() }),
    includeBrand: form.includeBrand,
    model: form.model,
    ...(form.durationSeconds === null ? {} : { durationSeconds: form.durationSeconds }),
  };
}

const STEP_COPY: Readonly<Record<FormatRun["status"], CopyKey>> = {
  queued: "formats.run.queued",
  generating: "formats.run.generating",
  building: "formats.run.building",
  ready: "formats.run.ready",
  failed: "formats.run.failed",
  nsfw: "formats.run.nsfw",
};

const STEPS: readonly FormatRun["status"][] = [
  "queued",
  "generating",
  "building",
  "ready",
];

function Counter({ value, max }: { readonly value: number; readonly max: number }) {
  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        value > max ? "text-danger" : "text-text-subtle",
      )}
      aria-live="polite"
    >
      {tw("formats.counter", { count: value, max })}
    </span>
  );
}

function RunProgress({
  runId,
  onReset,
}: {
  readonly runId: string;
  readonly onReset: () => void;
}) {
  const run = useFormatRun(runId);
  if (run.isPending) {
    return <Skeleton height={120} className="rounded-2xl" />;
  }
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
  const current = STEPS.indexOf(r.status);
  return (
    <section
      aria-labelledby="format-run-status"
      className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5"
      data-testid="format-run"
    >
      <h2 id="format-run-status" className="m-0 text-lg font-semibold text-text">
        {tw(STEP_COPY[r.status])}
      </h2>
      {r.status !== "failed" && r.status !== "nsfw" && (
        <ol
          className="m-0 flex list-none flex-wrap gap-2 p-0"
          aria-busy={isRunInFlight(r)}
        >
          {STEPS.map((s, i) => (
            <li key={s}>
              <Badge
                size="sm"
                tone={i < current ? "success" : i === current ? "info" : "neutral"}
              >
                {tw(STEP_COPY[s])}
              </Badge>
            </li>
          ))}
        </ol>
      )}
      {isRunInFlight(r) && (
        <p className="m-0 text-sm text-text-muted">{tw("formats.run.wait")}</p>
      )}
      {r.clip !== null && (
        <video
          src={r.clip.url}
          className="aspect-[9/16] max-h-80 self-start rounded-xl bg-surface-sunken"
          muted
          loop
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
        {r.status === "ready" && r.contentId !== null && (
          <Link href={editorHref(r.contentId)} className={buttonVariants({ size: "md" })}>
            {tw("formats.run.openEditor")}
          </Link>
        )}
        {!isRunInFlight(r) && (
          <Button variant="secondary" onClick={onReset}>
            {tw("formats.run.again")}
          </Button>
        )}
      </div>
    </section>
  );
}

export interface GenerativeFormatStudioProps {
  /** El `id` de `F-070` (el segmento de `/content/<id>`). */
  readonly formatId: string;
}

/**
 * Un formato generativo de `F-084` — sprint 7, `P4-FORMAT-001`/`002`.
 *
 * Escena y texto → costo estimado (antes de generar, con el tope del mes) →
 * Generate → el clip se genera con el modelo de video de Settings → Models,
 * se copia a nuestro storage y la pieza se arma con el texto encima → abre el
 * editor. Los formatos que necesitan voz quedan explicados, no escondidos.
 *
 * Lo monta la página `/content/[format]` (agente F).
 */
export function GenerativeFormatStudio({ formatId }: GenerativeFormatStudioProps) {
  const ids = { overlay: useId(), topic: useId(), model: useId(), brand: useId() };
  const view = useGenerativeFormats();
  const format = view.data?.formats.find((f) => f.id === formatId);
  const video = view.data?.video;
  const [form, setForm] = useState<FormState | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  // El formulario nace cuando llegan los modelos.
  useEffect(() => {
    if (form !== null || video === undefined || format === undefined) return;
    const model = video.defaultModel ?? video.models[0]?.id ?? "";
    const spec = video.models.find((m) => m.id === model);
    setForm({
      overlayText: "",
      topic: "",
      includeBrand: true,
      model,
      durationSeconds: initialDuration(spec, format.preferredDurationSeconds),
    });
  }, [form, video, format]);

  const debouncedForm = useDebounced(form, ESTIMATE_DEBOUNCE_MS);
  const request = useMemo(
    () => (debouncedForm === null ? null : toFormatRunRequest(debouncedForm)),
    [debouncedForm],
  );
  const estimate = useFormatEstimate(formatId, request);
  const start = useStartFormatRun(formatId);

  if (view.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton shape="text" width="40%" />
        <Skeleton height={120} className="rounded-2xl" />
        <Skeleton height={44} />
      </div>
    );
  }
  if (view.isError) {
    return (
      <ApiErrorState
        error={view.error}
        onRetry={() => {
          void view.refetch();
        }}
      />
    );
  }
  if (format === undefined) {
    return <EmptyState bordered title={tw("formats.notGenerative")} />;
  }

  const header = (
    <header className="flex flex-col gap-1">
      <h2 className="m-0 flex items-center gap-2 text-xl font-semibold text-text">
        <ClapperboardIcon size={18} className="text-accent" />
        {format.label}
      </h2>
      <p className="m-0 text-sm text-text-muted">{format.description}</p>
    </header>
  );

  if (format.status === "blocked") {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <EmptyState
          bordered
          title={tw("formats.blocked.title")}
          description={format.why ?? tw("formats.blocked.title")}
        />
      </div>
    );
  }

  if (runId !== null) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <RunProgress
          runId={runId}
          onReset={() => {
            setRunId(null);
            start.reset();
          }}
        />
      </div>
    );
  }

  if (video === undefined || !video.configured || video.models.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <EmptyState
          bordered
          title={tw("formats.setup.title")}
          description={tw("formats.setup.body")}
          action={
            <Link
              href={ROUTES.settingsModels}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              {tw("aiStudio.setup.action")}
            </Link>
          }
        />
      </div>
    );
  }

  if (form === null) return <Skeleton height={200} className="rounded-2xl" />;
  const spec = video.models.find((m) => m.id === form.model);
  const cost = estimate.data?.estimate;
  const overBudget = estimate.data !== undefined && !estimate.data.fits;
  const typing = form !== debouncedForm;
  const ready = toFormatRunRequest(form);
  const canGenerate = ready !== null && !overBudget && !start.isPending;
  const startError = start.error;
  const budgetRejected =
    isApiRequestError(startError) && startError.details?.["reason"] === "budget_exceeded";

  const onGenerate = () => {
    if (ready === null) return;
    start.mutate(ready, {
      onSuccess: (run) => {
        setRunId(run.id);
      },
    });
  };

  return (
    <div className="flex flex-col gap-5">
      {header}
      <section className="flex flex-col gap-5 rounded-2xl border border-border bg-surface p-5 shadow-sm">
        {format.narrationMissing && (
          <p className="m-0 rounded-xl bg-surface-sunken p-3 text-xs text-text-muted">
            {tw("formats.narrationMissing")}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={ids.overlay} className="text-sm font-medium text-text">
              {tw("formats.overlay.label")}
            </label>
            <Counter value={form.overlayText.length} max={FORMAT_RUN_OVERLAY_MAX_CHARS} />
          </div>
          <Textarea
            id={ids.overlay}
            rows={3}
            placeholder={tw("formats.overlay.placeholder")}
            value={form.overlayText}
            onChange={(e) => {
              setForm({ ...form, overlayText: e.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={ids.topic} className="text-sm font-medium text-text">
              {tw("formats.topic.label")}
            </label>
            <Counter value={form.topic.length} max={FORMAT_RUN_TOPIC_MAX_CHARS} />
          </div>
          <Input
            id={ids.topic}
            placeholder={tw("formats.topic.placeholder")}
            value={form.topic}
            onChange={(e) => {
              setForm({ ...form, topic: e.target.value });
            }}
          />
        </div>
        <Checkbox
          id={ids.brand}
          checked={form.includeBrand}
          label={tw("formats.brand.label")}
          onChange={(e) => {
            setForm({ ...form, includeBrand: e.target.checked });
          }}
        />
        <div className="flex flex-col gap-2">
          <label htmlFor={ids.model} className="text-sm font-medium text-text">
            {tw("aiStudio.model.label")}
          </label>
          <Select
            id={ids.model}
            value={form.model}
            options={video.models.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(e) => {
              const next = video.models.find((m) => m.id === e.target.value);
              setForm({
                ...form,
                model: e.target.value,
                durationSeconds: initialDuration(next, form.durationSeconds),
              });
            }}
          />
        </div>
        {spec !== undefined &&
          spec.durationsSeconds.length > 0 &&
          form.durationSeconds !== null && (
            <ChoiceChips
              name="format-duration"
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
        <div
          className="flex flex-col gap-3 rounded-xl bg-surface-sunken p-4"
          aria-live="polite"
          data-testid="format-estimate"
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
            {request === null
              ? tw("formats.estimate.idle")
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
          <BudgetMeter summary={estimate.data?.budget ?? view.data.budget} />
        </div>
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            leadingIcon={<WandIcon size={16} />}
            loading={start.isPending}
            disabled={!canGenerate}
            onClick={onGenerate}
          >
            {start.isPending ? tw("aiStudio.generating") : tw("aiStudio.generate")}
          </Button>
          <div aria-live="polite" className="min-h-5">
            {start.isError && (
              <p className="m-0 text-sm text-danger" role="alert">
                {budgetRejected
                  ? tw("aiStudio.generate.budgetExceeded")
                  : (startError?.serverMessage ?? tw("aiStudio.generate.error"))}
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
