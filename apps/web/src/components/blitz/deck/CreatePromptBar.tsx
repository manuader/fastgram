"use client";

import { Button, Input, Select, Spinner, buttonVariants, useToast } from "@fastgram/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  FORMAT_RUN_OVERLAY_MAX_CHARS,
  FORMAT_RUN_TOPIC_MAX_CHARS,
  formatRunEstimateSchema,
  formatRunSchema,
  type BlitzContentType,
  type FormatRun,
  type FormatRunEstimate,
  type FormatRunRequest,
} from "@fastgram/contracts";
import { editorHref } from "@/components/editor/ContentEditor";
import {
  formatKeys,
  isRunInFlight,
  useFormatRun,
  useGenerativeFormats,
} from "@/components/studio/generative/api";
import { apiRequest } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/api/idempotency-key";
import { tw } from "@/lib/i18n/t";
import { budgetKeys, formatUsd } from "@/lib/models/budget";
import { blitzQueueKey } from "@/lib/blitz/deck/api";
import { td } from "@/lib/blitz/deck/copy";
import {
  BLITZ_PROMPT_MAX_CHARS,
  PROMPT_COUNTS,
  isOpenPrompt,
  isSearchingMeme,
  promptFailureView,
  promptInputError,
  useBlitzPromptStatus,
  useGenerateFromPrompt,
  type PromptStatus,
} from "@/lib/blitz/deck/prompt";
import { BLITZ_TYPE_COPY } from "@/lib/blitz/deck/suggestion";
import { ROUTES } from "@/lib/nav/routes";
import { SparkIcon, XIcon } from "./icons";

const FORMATS: readonly BlitzContentType[] = [
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
];

/**
 * Sprint 7 (segunda tanda): los formatos IA de AI Studio (`GET
 * /ai-studio/formats`, sólo los `available`) entran al mismo selector con este
 * prefijo, para no chocar con los cuatro de Blitz.
 */
const GEN_PREFIX = "gen:";

type FormatChoice = BlitzContentType | "" | `${typeof GEN_PREFIX}${string}`;

function generativeIdOf(choice: FormatChoice): string | null {
  return choice.startsWith(GEN_PREFIX) ? choice.slice(GEN_PREFIX.length) : null;
}

/**
 * El pedido de una corrida a partir del prompt. El formato IA pide el texto que
 * va sobre el clip y, opcional, el detalle de la escena; la barra tiene un solo
 * campo, así que el prompt es las dos cosas (recortado a cada tope).
 */
function formatRunBody(prompt: string): FormatRunRequest {
  const text = prompt.trim();
  return {
    overlayText: text.slice(0, FORMAT_RUN_OVERLAY_MAX_CHARS),
    topic: text.slice(0, FORMAT_RUN_TOPIC_MAX_CHARS),
  };
}

/**
 * «Create from prompt», arriba del deck · `PU-BLITZ-003`, `EXT-009`.
 *
 * El usuario escribe un tema y, si quiere, fuerza formato y cantidad. La API
 * encola y devuelve un `requestId`; esto pregunta hasta `done` o `failed`.
 *
 *  - `done`: se invalida la cola. Las piezas nuevas llegan **primeras** porque
 *    el servidor las ordena así, con el chip «From your prompt».
 *  - `running` con `phase: searching_meme` (sprint 7): la Library no tenía un
 *    meme para el tema y el worker lo está buscando e importando. Tarda más
 *    que la copy, así que se dice en vez de dejar el spinner mudo.
 *  - `failed`: el motivo, con el arreglo al lado (Settings → Models, Library).
 *    Nunca silencioso: el refill puede quedarse callado, esto no, porque hay
 *    alguien esperando.
 *
 * No cobra: cobra aceptar la pieza, como cualquier otra del deck.
 *
 * ## Formatos IA (sprint 7, segunda tanda)
 *
 * Elegir un formato generativo no pide sugerencias: arranca una corrida de
 * AI Studio (`POST /ai-studio/formats/:format/runs?source=blitz`, que llama a
 * `startGenerativeFormatRun` de `core`). Cuesta plata del proveedor, así que
 * primero se estima y se pide confirmar con el precio. La pieza que sale es una
 * pieza, no una sugerencia: va a la Library, y un toast ofrece abrirla en el
 * editor. Sin modelo de video, las opciones aparecen deshabilitadas con el
 * motivo; si el catálogo no carga, simplemente no aparecen.
 */
export function CreatePromptBar() {
  const queryClient = useQueryClient();
  const generate = useGenerateFromPrompt();
  const inputId = useId();
  // ⌘K → "Create from prompt" navega a `/blitz#create`: el foco va directo al tema.
  useEffect(() => {
    if (window.location.hash !== "#create") return;
    document.getElementById(inputId)?.focus();
  }, [inputId]);
  const errorId = useId();

  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState<FormatChoice>("");
  const [count, setCount] = useState(1);
  const [showError, setShowError] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  // Una key por intento: se reusa si el mismo intento se reintenta a mano
  // (no cobra, pero sí crea un pedido y un job), y se tira al cambiar algo.
  const keyRef = useRef<string | null>(null);

  const status = useBlitzPromptStatus(requestId);
  const inputError = promptInputError(prompt);
  const current = status.data;
  const generative = useGenerativeFormats();
  const genId = generativeIdOf(format);
  const gen = useGenerativeRun();
  const busy =
    gen.busy ||
    generate.isPending ||
    (requestId !== null && (current === undefined || isOpenPrompt(current)));

  const genOptions =
    generative.data?.formats
      .filter((f) => f.status === "available")
      .map((f) =>
        generative.data?.video.configured === true
          ? {
              value: `${GEN_PREFIX}${f.id}`,
              label: tw("prompt.gen.option", { label: f.label }),
            }
          : {
              value: `${GEN_PREFIX}${f.id}`,
              label: tw("prompt.gen.optionDisabled", { label: f.label }),
              disabled: true,
            },
      ) ?? [];

  // Al cerrar bien: la cola tiene piezas nuevas arriba.
  const settled = current?.status === "done" ? current.requestId : null;
  useEffect(() => {
    if (settled !== null) {
      void queryClient.invalidateQueries({ queryKey: blitzQueueKey() });
    }
  }, [settled, queryClient]);

  function edited(): void {
    keyRef.current = null;
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) return;
    if (inputError !== null) {
      setShowError(true);
      return;
    }
    if (genId !== null) {
      setRequestId(null);
      gen.estimate(genId, formatRunBody(prompt));
      return;
    }
    gen.reset();
    keyRef.current ??= newIdempotencyKey();
    generate.mutate(
      {
        prompt,
        contentType: format === "" ? null : (format as BlitzContentType),
        count,
        idempotencyKey: keyRef.current,
      },
      {
        onSuccess: (id) => {
          keyRef.current = null;
          setRequestId(id);
        },
      },
    );
  }

  function dismiss(): void {
    setRequestId(null);
    generate.reset();
    gen.reset();
  }

  const invalid = showError && inputError !== null;

  return (
    <section
      aria-labelledby={`${inputId}-title`}
      className="mb-6 rounded-2xl border border-border bg-surface p-4 shadow-sm"
      data-testid="create-prompt-bar"
    >
      <h2
        id={`${inputId}-title`}
        className="mb-3 flex items-center gap-2 text-sm font-semibold text-text"
      >
        <span className="text-accent">
          <SparkIcon size={16} />
        </span>
        {td("prompt.title")}
      </h2>
      <form className="flex flex-wrap items-start gap-2" onSubmit={submit} noValidate>
        <div className="min-w-[14rem] flex-1">
          <label htmlFor={inputId} className="sr-only">
            {td("prompt.label")}
          </label>
          <Input
            id={inputId}
            value={prompt}
            maxLength={BLITZ_PROMPT_MAX_CHARS}
            placeholder={td("prompt.placeholder")}
            invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => {
              setPrompt(event.target.value);
              edited();
            }}
          />
          {invalid && (
            <p id={errorId} className="mt-1 text-xs text-danger">
              {td(inputError)}
            </p>
          )}
        </div>
        <Select
          aria-label={td("prompt.format")}
          value={format}
          onChange={(event) => {
            setFormat(event.target.value as FormatChoice);
            edited();
          }}
          options={[
            { value: "", label: td("prompt.format.any") },
            ...FORMATS.map((f) => ({ value: f, label: tw(BLITZ_TYPE_COPY[f]) })),
            ...genOptions,
          ]}
        />
        <Select
          aria-label={td("prompt.count")}
          // Una corrida de formato IA hace una pieza: la cantidad no aplica.
          disabled={genId !== null}
          value={genId !== null ? "1" : String(count)}
          onChange={(event) => {
            setCount(Number(event.target.value));
            edited();
          }}
          options={PROMPT_COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
        />
        <Button type="submit" variant="primary" loading={busy} disabled={busy}>
          {td("prompt.submit")}
        </Button>
      </form>

      {gen.active ? (
        <GenerativeOutcome gen={gen} onDismiss={dismiss} />
      ) : (
        <PromptOutcome
          submitting={generate.isPending}
          submitFailed={generate.isError}
          statusFailed={status.isError}
          requestId={requestId}
          current={current}
          onDismiss={dismiss}
        />
      )}
    </section>
  );
}

function PromptOutcome({
  submitting,
  submitFailed,
  statusFailed,
  requestId,
  current,
  onDismiss,
}: {
  submitting: boolean;
  submitFailed: boolean;
  statusFailed: boolean;
  requestId: string | null;
  current: PromptStatus | undefined;
  onDismiss: () => void;
}) {
  if (submitting) return null;
  if (submitFailed) {
    return (
      <Notice tone="danger" message={td("prompt.submitFailed")} onDismiss={onDismiss} />
    );
  }
  if (requestId === null) return null;
  if (statusFailed) {
    return (
      <Notice tone="warning" message={td("prompt.statusFailed")} onDismiss={onDismiss} />
    );
  }
  if (current === undefined || isOpenPrompt(current)) {
    const requested = current?.count ?? 1;
    return (
      <p
        role="status"
        className="mt-3 inline-flex items-center gap-2 text-sm text-text-muted"
        data-testid="prompt-progress"
      >
        <Spinner size="sm" aria-hidden />
        {current?.status === "queued"
          ? td("prompt.queued")
          : isSearchingMeme(current)
            ? td("prompt.searchingMeme")
            : requested === 1
              ? td("prompt.generatingOne")
              : td("prompt.generating", { count: requested })}
      </p>
    );
  }
  if (current.status === "done") {
    const made = current.suggestionIds.length;
    const requested = current.count ?? made;
    const message =
      made < requested
        ? td("prompt.donePartial", { count: made, requested })
        : made === 1
          ? td("prompt.doneOne")
          : td("prompt.done", { count: made });
    return <Notice tone="success" message={message} onDismiss={onDismiss} />;
  }
  const view = promptFailureView(current.failureReason);
  return (
    <Notice
      tone="danger"
      message={td(view.message)}
      onDismiss={onDismiss}
      action={
        view.link === undefined ? undefined : (
          <Link
            href={view.link.href}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            {td(view.link.label)}
          </Link>
        )
      }
    />
  );
}

interface GenerativeRun {
  /** Hay algo que mostrar: una estimación, una corrida o un error. */
  readonly active: boolean;
  readonly busy: boolean;
  readonly estimating: boolean;
  readonly estimateFailed: boolean;
  readonly pending: {
    readonly formatId: string;
    readonly body: FormatRunRequest;
    readonly estimate: FormatRunEstimate;
  } | null;
  readonly starting: boolean;
  readonly startError: ApiRequestError | null;
  readonly run: FormatRun | undefined;
  readonly runFailed: boolean;
  readonly estimate: (formatId: string, body: FormatRunRequest) => void;
  readonly start: () => void;
  readonly reset: () => void;
}

/**
 * Estimar → confirmar → correr → seguir la corrida. Al quedar lista, un toast
 * con «Open in editor» y la Library se invalida: la pieza nueva está ahí.
 */
function useGenerativeRun(): GenerativeRun {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  const [runId, setRunId] = useState<string | null>(null);
  const [pending, setPending] = useState<GenerativeRun["pending"]>(null);
  const toasted = useRef<string | null>(null);

  const estimate = useMutation<
    FormatRunEstimate,
    ApiRequestError,
    { formatId: string; body: FormatRunRequest }
  >({
    mutationFn: ({ formatId, body }) =>
      apiRequest<FormatRunEstimate>(
        `/ai-studio/formats/${encodeURIComponent(formatId)}/estimate`,
        { method: "POST", body, schema: formatRunEstimateSchema },
      ),
    onSuccess: (result, variables) => setPending({ ...variables, estimate: result }),
  });

  const start = useMutation<
    FormatRun,
    ApiRequestError,
    { formatId: string; body: FormatRunRequest }
  >({
    mutationFn: ({ formatId, body }) =>
      apiRequest<FormatRun>(`/ai-studio/formats/${encodeURIComponent(formatId)}/runs`, {
        method: "POST",
        body,
        query: { source: "blitz" },
        schema: formatRunSchema,
      }),
    onSuccess: (run) => {
      queryClient.setQueryData(formatKeys.run(run.id), run);
      void queryClient.invalidateQueries({ queryKey: budgetKeys.summary() });
      setPending(null);
      setRunId(run.id);
    },
  });

  const run = useFormatRun(runId);
  const ready =
    run.data?.status === "ready" && run.data.contentId !== null ? run.data : null;
  useEffect(() => {
    if (ready === null || toasted.current === ready.id) return;
    toasted.current = ready.id;
    const contentId = ready.contentId as string;
    void queryClient.invalidateQueries({ queryKey: ["content"] });
    toast({
      title: tw("prompt.gen.ready"),
      tone: "success",
      action: {
        label: tw("formats.run.openEditor"),
        onClick: () => router.push(editorHref(contentId)),
      },
    });
  }, [ready, queryClient, router, toast]);

  const inFlight = run.data !== undefined && isRunInFlight(run.data);
  return {
    active:
      estimate.isPending ||
      estimate.isError ||
      pending !== null ||
      start.isPending ||
      start.isError ||
      runId !== null,
    busy:
      estimate.isPending ||
      start.isPending ||
      (runId !== null && (run.data === undefined ? !run.isError : inFlight)),
    estimating: estimate.isPending,
    estimateFailed: estimate.isError,
    pending,
    starting: start.isPending,
    startError: start.error,
    run: run.data,
    runFailed: run.isError,
    estimate: (formatId, body) => {
      setRunId(null);
      setPending(null);
      start.reset();
      estimate.mutate({ formatId, body });
    },
    start: () => {
      if (pending !== null)
        start.mutate({ formatId: pending.formatId, body: pending.body });
    },
    reset: () => {
      setRunId(null);
      setPending(null);
      estimate.reset();
      start.reset();
    },
  };
}

/** El mensaje de un rechazo al arrancar: el del servidor si lo hay (ya es copy). */
function startErrorMessage(error: ApiRequestError): string {
  if (error.details?.["reason"] === "budget_exceeded") {
    const remaining = error.details["remainingUsd"];
    return tw("aiStudio.estimate.overBudget", {
      remaining: formatUsd(typeof remaining === "number" ? remaining : 0),
    });
  }
  if (error.details?.["reason"] === "not_configured") return tw("formats.setup.body");
  return error.serverMessage ?? tw("prompt.gen.startFailed");
}

function GenerativeOutcome({
  gen,
  onDismiss,
}: {
  gen: GenerativeRun;
  onDismiss: () => void;
}) {
  if (gen.estimating) {
    return <Progress label={tw("prompt.gen.estimating")} />;
  }
  if (gen.estimateFailed) {
    return (
      <Notice
        tone="danger"
        message={tw("prompt.gen.estimateFailed")}
        onDismiss={onDismiss}
      />
    );
  }
  if (gen.pending !== null) {
    const { estimate } = gen.pending;
    if (!estimate.fits) {
      return (
        <Notice
          tone="warning"
          message={tw("aiStudio.estimate.overBudget", {
            remaining: formatUsd(estimate.budget.remainingUsd),
          })}
          onDismiss={onDismiss}
        />
      );
    }
    return (
      <Notice
        tone="success"
        message={tw("prompt.gen.confirm", { cost: formatUsd(estimate.estimate.usd) })}
        onDismiss={onDismiss}
        action={
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={gen.starting}
            disabled={gen.starting}
            onClick={gen.start}
          >
            {tw("prompt.gen.generate")}
          </Button>
        }
      />
    );
  }
  if (gen.startError !== null) {
    return (
      <Notice
        tone="danger"
        message={startErrorMessage(gen.startError)}
        onDismiss={onDismiss}
        action={
          gen.startError.details?.["reason"] === "not_configured" ? (
            <Link
              href={ROUTES.settingsModels}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              {td("prompt.failed.llmLink")}
            </Link>
          ) : undefined
        }
      />
    );
  }
  if (gen.starting) return <Progress label={tw("formats.run.queued")} />;
  if (gen.runFailed) {
    return (
      <Notice
        tone="warning"
        message={tw("prompt.gen.statusFailed")}
        onDismiss={onDismiss}
      />
    );
  }
  const run = gen.run;
  if (run === undefined) return <Progress label={tw("formats.run.queued")} />;
  if (isRunInFlight(run)) {
    return (
      <div>
        <Progress label={tw(`formats.run.${run.status}` as "formats.run.queued")} />
        <p className="mt-1 text-xs text-text-muted">{tw("formats.run.wait")}</p>
      </div>
    );
  }
  if (run.status === "ready" && run.contentId !== null) {
    return (
      <Notice
        tone="success"
        message={tw("prompt.gen.ready")}
        onDismiss={onDismiss}
        action={
          <Link
            href={editorHref(run.contentId)}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            {tw("formats.run.openEditor")}
          </Link>
        }
      />
    );
  }
  return (
    <Notice
      tone="danger"
      message={run.status === "nsfw" ? tw("formats.run.nsfw") : tw("formats.run.failed")}
      onDismiss={onDismiss}
    />
  );
}

function Progress({ label }: { label: string }) {
  return (
    <p
      role="status"
      className="mt-3 inline-flex items-center gap-2 text-sm text-text-muted"
      data-testid="prompt-progress"
    >
      <Spinner size="sm" aria-hidden />
      {label}
    </p>
  );
}

function Notice({
  tone,
  message,
  action,
  onDismiss,
}: {
  tone: "success" | "warning" | "danger";
  message: string;
  action?: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div
      role={tone === "success" ? "status" : "alert"}
      className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-sunken px-3 py-2 text-sm"
      style={{ color: `var(--fg-color-${tone})` }}
      data-testid={`prompt-${tone}`}
    >
      <span className="flex-1 text-text">{message}</span>
      {action}
      <button
        type="button"
        className="fg-focusable rounded p-1 text-text-muted hover:text-text"
        aria-label={td("prompt.dismiss")}
        onClick={onDismiss}
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}
