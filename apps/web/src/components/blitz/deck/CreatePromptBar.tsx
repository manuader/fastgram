"use client";

import { Button, Input, Select, Spinner, buttonVariants } from "@fastgram/ui";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { BlitzContentType } from "@fastgram/contracts";
import { newIdempotencyKey } from "@/lib/api/idempotency-key";
import { tw } from "@/lib/i18n/t";
import { blitzQueueKey } from "@/lib/blitz/deck/api";
import { td } from "@/lib/blitz/deck/copy";
import {
  BLITZ_PROMPT_MAX_CHARS,
  PROMPT_COUNTS,
  isOpenPrompt,
  promptFailureView,
  promptInputError,
  useBlitzPromptStatus,
  useGenerateFromPrompt,
  type PromptStatus,
} from "@/lib/blitz/deck/prompt";
import { BLITZ_TYPE_COPY } from "@/lib/blitz/deck/suggestion";
import { SparkIcon, XIcon } from "./icons";

const FORMATS: readonly BlitzContentType[] = [
  "slideshow",
  "wall-of-text",
  "green-screen",
  "video-hook",
];

/**
 * «Create from prompt», arriba del deck · `PU-BLITZ-003`, `EXT-009`.
 *
 * El usuario escribe un tema y, si quiere, fuerza formato y cantidad. La API
 * encola y devuelve un `requestId`; esto pregunta hasta `done` o `failed`.
 *
 *  - `done`: se invalida la cola. Las piezas nuevas llegan **primeras** porque
 *    el servidor las ordena así, con el chip «From your prompt».
 *  - `failed`: el motivo, con el arreglo al lado (Settings → Models, Library).
 *    Nunca silencioso: el refill puede quedarse callado, esto no, porque hay
 *    alguien esperando.
 *
 * No cobra: cobra aceptar la pieza, como cualquier otra del deck.
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
  const [format, setFormat] = useState<BlitzContentType | "">("");
  const [count, setCount] = useState(1);
  const [showError, setShowError] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  // Una key por intento: se reusa si el mismo intento se reintenta a mano
  // (no cobra, pero sí crea un pedido y un job), y se tira al cambiar algo.
  const keyRef = useRef<string | null>(null);

  const status = useBlitzPromptStatus(requestId);
  const inputError = promptInputError(prompt);
  const current = status.data;
  const busy =
    generate.isPending ||
    (requestId !== null && (current === undefined || isOpenPrompt(current)));

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
    keyRef.current ??= newIdempotencyKey();
    generate.mutate(
      {
        prompt,
        contentType: format === "" ? null : format,
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
            setFormat(event.target.value as BlitzContentType | "");
            edited();
          }}
          options={[
            { value: "", label: td("prompt.format.any") },
            ...FORMATS.map((f) => ({ value: f, label: tw(BLITZ_TYPE_COPY[f]) })),
          ]}
        />
        <Select
          aria-label={td("prompt.count")}
          value={String(count)}
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

      <PromptOutcome
        submitting={generate.isPending}
        submitFailed={generate.isError}
        statusFailed={status.isError}
        requestId={requestId}
        current={current}
        onDismiss={dismiss}
      />
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
