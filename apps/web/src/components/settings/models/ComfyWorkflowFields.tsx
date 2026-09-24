"use client";

import { Select, Textarea, Input } from "@fastgram/ui";
import { useId, useMemo, useState } from "react";
import type { ModelTask } from "@fastgram/contracts";
import { COMFY_COPY } from "@/lib/models/copy";
import {
  BINDING_TYPE,
  listInputs,
  parseWorkflow,
  withRef,
  withWorkflowText,
  type ComfyBinding,
  type ComfyDraft,
  type ComfyField,
} from "@/lib/models/comfy";

export interface ComfyWorkflowFieldsProps {
  readonly task: ModelTask;
  readonly draft: ComfyDraft;
  readonly errors: Partial<Record<ComfyField, string>>;
  readonly onChange: (next: ComfyDraft) => void;
}

/**
 * El workflow de ComfyUI de una tarjeta de imagen o video — `PU-LATER-003`.
 *
 * Pegar o subir el JSON (formato API) → se detectan prompt, tamaño, semilla e
 * imagen de entrada y se muestran en selects para confirmar o cambiar. Los
 * estados: vacío (cómo exportarlo), error (no parsea / formato del editor) y
 * listo (los selects).
 */
export function ComfyWorkflowFields({
  task,
  draft,
  errors,
  onChange,
}: ComfyWorkflowFieldsProps) {
  const ids = {
    workflow: useId(),
    file: useId(),
    duration: useId(),
    prompt: useId(),
    width: useId(),
    height: useId(),
    seed: useId(),
    image: useId(),
  };
  const [fileError, setFileError] = useState(false);
  const [reading, setReading] = useState(false);

  const parsed = useMemo(() => parseWorkflow(draft.text), [draft.text]);
  const inputs = useMemo(() => (parsed.ok ? listInputs(parsed.workflow) : []), [parsed]);
  const empty = draft.text.trim() === "";
  const workflowError = empty ? undefined : errors.workflow;

  const bindings: ComfyBinding[] =
    task === "video"
      ? ["prompt", "width", "height", "seed", "image"]
      : ["prompt", "width", "height", "seed"];

  const hintFor = (b: ComfyBinding): string | undefined => {
    if (b === "prompt") return errors.prompt ?? COMFY_COPY.bindingHints.prompt;
    if (b === "height") return errors.size ?? COMFY_COPY.bindingHints.size;
    if (b === "seed") return COMFY_COPY.bindingHints.seed;
    if (b === "image") return COMFY_COPY.bindingHints.image;
    return undefined;
  };

  const onFile = async (file: File | undefined) => {
    if (file === undefined) return;
    setFileError(false);
    setReading(true);
    try {
      onChange(withWorkflowText(draft, await file.text(), task));
    } catch {
      setFileError(true);
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.workflow} className="text-sm font-medium text-text">
          {COMFY_COPY.workflow}
        </label>
        <Textarea
          id={ids.workflow}
          aria-describedby={`${ids.workflow}-hint`}
          rows={6}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={COMFY_COPY.workflowPlaceholder}
          value={draft.text}
          invalid={workflowError !== undefined}
          onChange={(e) => {
            onChange(withWorkflowText(draft, e.target.value, task));
          }}
        />
        <p
          id={`${ids.workflow}-hint`}
          className={`m-0 text-xs ${workflowError !== undefined ? "text-danger" : "text-text-muted"}`}
        >
          {workflowError ??
            (parsed.ok
              ? `${COMFY_COPY.nodes(Object.keys(parsed.workflow).length)}.`
              : COMFY_COPY.workflowHint)}
        </p>
        <div className="flex items-center gap-2">
          <label
            htmlFor={ids.file}
            className="cursor-pointer text-xs font-medium text-accent underline"
          >
            {reading ? "…" : COMFY_COPY.loadFile}
          </label>
          <input
            id={ids.file}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {fileError && (
            <span className="text-xs text-danger" role="alert">
              {COMFY_COPY.fileError}
            </span>
          )}
        </div>
      </div>

      {parsed.ok && (
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-1 text-sm font-medium text-text">
            {COMFY_COPY.bindingsTitle}
          </legend>
          {draft.detected && (
            <p className="m-0 text-xs text-text-muted" role="status">
              {COMFY_COPY.detected}
            </p>
          )}
          {bindings.map((b) => {
            const options = inputs.filter((o) => o.valueType === BINDING_TYPE[b]);
            const hint = hintFor(b);
            const invalid =
              (b === "prompt" && errors.prompt !== undefined) ||
              ((b === "width" || b === "height") && errors.size !== undefined);
            return (
              <div key={b} className="flex flex-col gap-1">
                <label htmlFor={ids[b]} className="text-xs font-medium text-text">
                  {COMFY_COPY.bindings[b]}
                </label>
                <Select
                  id={ids[b]}
                  aria-describedby={hint === undefined ? undefined : `${ids[b]}-hint`}
                  value={draft.refs[b]}
                  invalid={invalid}
                  options={[
                    { value: "", label: COMFY_COPY.notSet },
                    ...options.map((o) => ({
                      value: o.key,
                      label: `#${o.nodeId} ${o.title ?? o.classType} · ${o.input}`,
                    })),
                  ]}
                  onChange={(e) => {
                    onChange(withRef(draft, b, e.target.value));
                  }}
                />
                {hint !== undefined && (
                  <p
                    id={`${ids[b]}-hint`}
                    className={`m-0 text-xs ${invalid ? "text-danger" : "text-text-muted"}`}
                  >
                    {options.length === 0 ? COMFY_COPY.noInputs : hint}
                  </p>
                )}
              </div>
            );
          })}
        </fieldset>
      )}

      {task === "video" && (
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.duration} className="text-sm font-medium text-text">
            {COMFY_COPY.duration}
          </label>
          <Input
            id={ids.duration}
            aria-describedby={`${ids.duration}-hint`}
            inputMode="numeric"
            autoComplete="off"
            value={draft.duration}
            invalid={errors.duration !== undefined && draft.duration !== ""}
            onChange={(e) => {
              onChange({ ...draft, duration: e.target.value });
            }}
          />
          <p id={`${ids.duration}-hint`} className="m-0 text-xs text-text-muted">
            {COMFY_COPY.durationHint}
          </p>
        </div>
      )}
    </div>
  );
}
