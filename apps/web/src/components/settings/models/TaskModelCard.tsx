"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Select,
} from "@fastgram/ui";
import { useEffect, useId, useState, type ReactNode } from "react";
import type {
  ListedModel,
  ModelConnectionTest,
  ModelProviderPreset,
  ModelTaskConfig,
} from "@fastgram/contracts";
import { isApiRequestError } from "@/lib/api/errors";
import {
  useProviderModels,
  useSaveModelTask,
  useTestModelConnection,
} from "@/lib/models/api";
import { COMFY_COPY, MODELS_COPY, TASK_COPY } from "@/lib/models/copy";
import {
  comfyDirty,
  comfyDraftFrom,
  comfyErrors,
  toComfyWorkflow,
  type ComfyDraft,
} from "@/lib/models/comfy";
import {
  draftErrors,
  draftFrom,
  isDirty,
  keyWillBeDropped,
  presetOf,
  toTestRequest,
  toUpdateRequest,
  withModel,
  withProvider,
  type DraftField,
  type TaskDraft,
} from "@/lib/models/draft";
import { ComfyWorkflowFields } from "./ComfyWorkflowFields";
import { ConnectionResult } from "./ConnectionResult";

const OTHER_MODEL = "__other__";

const STATUS_TONE = {
  ready: "success",
  incomplete: "warning",
  unset: "neutral",
} as const;

export interface TaskModelCardProps {
  readonly config: ModelTaskConfig;
  readonly presets: readonly ModelProviderPreset[];
}

/** El id que describe a un control: su error si hay, si no su ayuda. */
function describedBy(id: string, error: string | undefined, hint: string | undefined) {
  if (error !== undefined) return `${id}-error`;
  if (hint !== undefined) return `${id}-hint`;
  return undefined;
}

/**
 * Un campo con su label, su ayuda y su error. El control los enlaza con
 * `aria-describedby={describedBy(...)}`: los ids salen de acá.
 */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {children}
      {error !== undefined ? (
        <p id={`${id}-error`} className="m-0 text-xs text-danger">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={`${id}-hint`} className="m-0 text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * La tarjeta de una tarea en Settings → Models — `PU-MODEL-002`.
 *
 * Proveedor (preset o `custom`) → base URL → key → modelo (de la lista del
 * proveedor, o a mano) → ventana. «Test connection» prueba lo que está
 * **escrito**, sin guardar: con la key tipeada si hay, o con la guardada si
 * el host es el mismo. «Save» manda sólo lo que cambió respecto de la key: un
 * campo de key vacío deja la guardada.
 *
 * La key nunca se vuelve a mostrar: el servidor no la devuelve, así que acá
 * no hay nada que mostrar. Lo único que se ve son sus últimos cuatro.
 */
export function TaskModelCard({ config, presets }: TaskModelCardProps) {
  const copy = TASK_COPY[config.task];
  const ids = {
    provider: useId(),
    baseUrl: useId(),
    apiKey: useId(),
    model: useId(),
    window: useId(),
  };

  const [draft, setDraft] = useState<TaskDraft>(() => draftFrom(config));
  // `PU-LATER-003`: el workflow de ComfyUI va aparte del borrador común.
  const [comfy, setComfy] = useState<ComfyDraft>(() =>
    comfyDraftFrom(config.comfyWorkflow),
  );
  const [listed, setListed] = useState<readonly ListedModel[] | null>(null);
  const [typingModel, setTypingModel] = useState(false);
  const [result, setResult] = useState<ModelConnectionTest | null>(null);
  const [touched, setTouched] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const save = useSaveModelTask(config.task);
  const test = useTestModelConnection();
  const serverList = useProviderModels({
    provider: draft.provider,
    baseUrl: draft.baseUrl,
    task: config.task,
    // A demanda: sólo el botón «Load models» la pide (`refetch`).
    enabled: false,
  });

  // Lo guardado cambió (este guardado u otra pestaña): se vuelve a sembrar.
  // Por la firma y no por la referencia: un refetch con los mismos datos no
  // puede borrar lo que el usuario está escribiendo.
  const signature = JSON.stringify(config);
  useEffect(() => {
    const saved = JSON.parse(signature) as ModelTaskConfig;
    setDraft(draftFrom(saved));
    setComfy(comfyDraftFrom(saved.comfyWorkflow));
    setTouched(false);
  }, [signature]);

  // La lista pedida con la key guardada.
  useEffect(() => {
    if (serverList.data === undefined) return;
    const outcome = serverList.data.result;
    setResult({
      ok: outcome.ok,
      keySource: serverList.data.keySource,
      models: outcome,
      completion: null,
    });
    if (outcome.ok) setListed(outcome.models);
  }, [serverList.data]);

  const preset = presetOf(presets, draft.provider);
  const isLlm = config.kind === "llm";
  // `PU-MODEL-003`/`004`: imagen y video también listan (catálogo verificado) y
  // prueban (una llamada autenticada que no genera). Sólo las reservadas no.
  const canProbe = config.kind !== "reserved";
  const errors = draftErrors(draft, config.kind);
  const serverField =
    save.error !== null && isApiRequestError(save.error)
      ? (save.error.details?.["field"] as string | undefined)
      : undefined;
  const serverMessage =
    save.error !== null && isApiRequestError(save.error)
      ? save.error.serverMessage
      : undefined;
  const errorFor = (field: DraftField): string | undefined =>
    (touched ? errors[field] : undefined) ??
    (serverField === field ? serverMessage : undefined);

  const isComfy = draft.provider === "comfyui";
  const comfyErrs = isComfy ? comfyErrors(comfy, config.task) : {};
  const comfyServerError = serverField === "comfyWorkflow" ? serverMessage : undefined;
  const dirty =
    isDirty(draft, config) || (isComfy && comfyDirty(comfy, config.comfyWorkflow));
  const baseRequest = toUpdateRequest(draft, config);
  const comfyWorkflow = isComfy ? toComfyWorkflow(comfy, config.task) : null;
  const request =
    baseRequest === null
      ? null
      : isComfy
        ? comfyWorkflow === null
          ? null
          : { ...baseRequest, comfyWorkflow }
        : baseRequest;
  const canSave =
    dirty &&
    request !== null &&
    Object.keys(errors).length === 0 &&
    Object.keys(comfyErrs).length === 0;
  const dropsKey = keyWillBeDropped(draft, config);

  const update = (next: TaskDraft): void => {
    setDraft(next);
    setJustSaved(false);
  };

  const runTest = (withModelCall: boolean): void => {
    const body = toTestRequest(
      config.task,
      withModelCall ? draft : { ...draft, model: "" },
    );
    if (body === null) return;
    setResult(null);
    test.mutate(body, {
      onSuccess: (r) => {
        setResult(r);
        if (r.models.ok) setListed(r.models.models);
      },
    });
  };

  const loadModels = (): void => {
    // Con una key tipeada, la lista tiene que salir con **esa** key, y una key
    // no viaja en la query de un GET: va por el cuerpo del POST de prueba.
    if (draft.apiKey.trim() !== "") runTest(false);
    else {
      setResult(null);
      void serverList.refetch();
    }
  };

  const onSave = (): void => {
    setTouched(true);
    if (!canSave || request === null) return;
    save.mutate(request, {
      onSuccess: () => {
        setJustSaved(true);
      },
    });
  };

  const modelIds = listed?.map((m) => m.id) ?? [];
  const showSelect =
    !typingModel &&
    listed !== null &&
    listed.length > 0 &&
    (draft.model === "" || modelIds.includes(draft.model));
  const loading = test.isPending || serverList.isFetching;
  const modelHint =
    listed !== null && listed.length > 0
      ? MODELS_COPY.modelsLoaded(listed.length)
      : undefined;

  let keyHint: string | undefined;
  if (config.apiKey.hasKey && config.apiKey.source === "file" && !draft.clearKey) {
    keyHint = MODELS_COPY.apiKeySaved(config.apiKey.last4);
  } else if (config.apiKey.hasKey && config.apiKey.source === "env") {
    keyHint = MODELS_COPY.apiKeyFromEnv(config.apiKey.envVar);
  } else if (preset !== undefined && !preset.requiresKey && !isComfy) {
    keyHint = MODELS_COPY.apiKeyOptional;
  }

  let sourceNote: string | null = null;
  if (config.inheritsFrom !== null) sourceNote = MODELS_COPY.inherits;
  else if (config.source === "env" && config.status === "ready")
    sourceNote = MODELS_COPY.usingEnv;
  else if (config.source === "env") sourceNote = MODELS_COPY.usingEnvIncomplete;

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle as="h3" id={`${ids.provider}-title`}>
            {copy.title}
          </CardTitle>
          <CardDescription>{copy.description}</CardDescription>
        </div>
        <Badge tone={STATUS_TONE[config.status]} size="sm">
          {MODELS_COPY.status[config.status]}
        </Badge>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {sourceNote !== null && (
          <p className="m-0 text-xs text-text-muted">
            {sourceNote}
            {config.source === "env" && config.model !== null && (
              <>
                {" "}
                <code>{config.model}</code>
              </>
            )}
          </p>
        )}
        {config.status === "incomplete" && config.missing.length > 0 && (
          <p className="m-0 text-xs text-warning">
            {MODELS_COPY.missingPrefix}
            {config.missing.map((m) => MODELS_COPY.missing[m]).join(", ")}
          </p>
        )}

        <Field
          id={ids.provider}
          label={MODELS_COPY.provider}
          error={errorFor("provider")}
        >
          <Select
            id={ids.provider}
            aria-describedby={describedBy(ids.provider, errorFor("provider"), undefined)}
            value={draft.provider}
            placeholder={MODELS_COPY.providerPlaceholder}
            invalid={errorFor("provider") !== undefined}
            options={config.providers.map((id) => ({
              value: id,
              label:
                (presetOf(presets, id)?.label ?? id) +
                (presetOf(presets, id)?.local === true ? " · local" : ""),
            }))}
            onChange={(e) => {
              const next = config.providers.find((p) => p === e.target.value);
              if (next === undefined) return;
              update(withProvider(draft, next, presets));
              setListed(null);
              setTypingModel(false);
              setResult(null);
            }}
          />
        </Field>
        {preset?.note !== null && preset?.note !== undefined && (
          <p className="-mt-2 m-0 text-xs text-text-muted">{preset.note}</p>
        )}

        <Field id={ids.baseUrl} label={MODELS_COPY.baseUrl} error={errorFor("baseUrl")}>
          <Input
            id={ids.baseUrl}
            aria-describedby={describedBy(ids.baseUrl, errorFor("baseUrl"), undefined)}
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            placeholder={preset?.baseUrl ?? MODELS_COPY.baseUrlPlaceholder}
            value={draft.baseUrl}
            invalid={errorFor("baseUrl") !== undefined}
            onChange={(e) => {
              update({ ...draft, baseUrl: e.target.value });
              setListed(null);
            }}
          />
        </Field>

        {!isComfy && (
          <Field id={ids.apiKey} label={MODELS_COPY.apiKey} hint={keyHint}>
            <div className="flex items-center gap-2">
              <Input
                id={ids.apiKey}
                aria-describedby={describedBy(ids.apiKey, undefined, keyHint)}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={MODELS_COPY.apiKeyPlaceholder}
                value={draft.apiKey}
                wrapperClassName="flex-1"
                className="flex-1"
                onChange={(e) => {
                  update({ ...draft, apiKey: e.target.value, clearKey: false });
                }}
              />
              {config.apiKey.hasKey && config.apiKey.source === "file" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    update({ ...draft, apiKey: "", clearKey: !draft.clearKey });
                  }}
                >
                  {draft.clearKey ? MODELS_COPY.keepKey : MODELS_COPY.removeKey}
                </Button>
              )}
            </div>
          </Field>
        )}
        {dropsKey && !isComfy && (
          <p className="-mt-2 m-0 text-xs text-warning">{MODELS_COPY.keyWillBeDropped}</p>
        )}

        <Field
          id={ids.model}
          label={isComfy ? COMFY_COPY.modelLabel : MODELS_COPY.model}
          error={errorFor("model")}
          hint={isComfy ? COMFY_COPY.modelHint : modelHint}
        >
          <div className="flex items-center gap-2">
            {showSelect ? (
              <Select
                id={ids.model}
                aria-describedby={describedBy(ids.model, errorFor("model"), modelHint)}
                wrapperClassName="flex-1"
                value={draft.model}
                placeholder={MODELS_COPY.modelPick}
                invalid={errorFor("model") !== undefined}
                options={[
                  ...modelIds.map((id) => ({ value: id, label: id })),
                  { value: OTHER_MODEL, label: MODELS_COPY.modelOther },
                ]}
                onChange={(e) => {
                  if (e.target.value === OTHER_MODEL) {
                    setTypingModel(true);
                    update({ ...draft, model: "" });
                    return;
                  }
                  update(withModel(draft, e.target.value, listed));
                }}
              />
            ) : (
              <Input
                id={ids.model}
                aria-describedby={describedBy(ids.model, errorFor("model"), modelHint)}
                wrapperClassName="flex-1"
                className="flex-1"
                spellCheck={false}
                autoComplete="off"
                placeholder={
                  isComfy ? COMFY_COPY.modelPlaceholder : MODELS_COPY.modelPlaceholder
                }
                value={draft.model}
                invalid={errorFor("model") !== undefined}
                onChange={(e) => {
                  update(withModel(draft, e.target.value, listed));
                }}
              />
            )}
            {canProbe && !isComfy && (
              <Button
                variant="secondary"
                size="sm"
                loading={loading && draft.model === ""}
                disabled={draft.provider === "" || loading}
                onClick={loadModels}
              >
                {MODELS_COPY.loadModels}
              </Button>
            )}
          </div>
        </Field>

        {isComfy && (
          <ComfyWorkflowFields
            task={config.task}
            draft={comfy}
            errors={{
              ...(touched || comfy.text.trim() !== "" ? comfyErrs : {}),
              ...(comfyServerError === undefined ? {} : { workflow: comfyServerError }),
            }}
            onChange={(next) => {
              setComfy(next);
              setJustSaved(false);
            }}
          />
        )}

        {isLlm && (
          <Field
            id={ids.window}
            label={MODELS_COPY.contextWindow}
            hint={MODELS_COPY.contextWindowHint}
            error={errorFor("contextWindow")}
          >
            <Input
              id={ids.window}
              aria-describedby={describedBy(
                ids.window,
                errorFor("contextWindow"),
                MODELS_COPY.contextWindowHint,
              )}
              inputMode="numeric"
              autoComplete="off"
              value={draft.contextWindow}
              invalid={errorFor("contextWindow") !== undefined}
              onChange={(e) => {
                update({
                  ...draft,
                  contextWindow: e.target.value,
                  contextWindowAuto: false,
                });
              }}
            />
          </Field>
        )}

        <div aria-live="polite" className="min-h-0">
          {result !== null && <ConnectionResult result={result} />}
          {test.error !== null && (
            <p className="m-0 text-sm text-danger">
              {test.error.serverMessage ?? test.error.code}
            </p>
          )}
          {serverList.error !== null && (
            <p className="m-0 text-sm text-danger">
              {serverList.error.serverMessage ?? serverList.error.code}
            </p>
          )}
          {save.isError &&
            (serverField === undefined || serverField === "comfyWorkflow") && (
              <p className="m-0 text-sm text-danger">
                {MODELS_COPY.saveFailed} {serverMessage ?? ""}
              </p>
            )}
        </div>
      </CardContent>

      <CardFooter className="mt-auto flex flex-wrap items-center justify-end gap-2">
        {justSaved && !dirty && (
          <span className="mr-auto text-sm text-success" role="status">
            ✓ {MODELS_COPY.saved}
          </span>
        )}
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(draftFrom(config));
              setComfy(comfyDraftFrom(config.comfyWorkflow));
              setTouched(false);
              setResult(null);
              save.reset();
            }}
          >
            {MODELS_COPY.reset}
          </Button>
        )}
        {canProbe && (
          <Button
            variant="secondary"
            size="sm"
            loading={test.isPending && draft.model !== ""}
            disabled={draft.provider === "" || draft.baseUrl.trim() === "" || loading}
            onClick={() => {
              runTest(true);
            }}
          >
            {test.isPending ? MODELS_COPY.testing : MODELS_COPY.test}
          </Button>
        )}
        <Button
          size="sm"
          loading={save.isPending}
          disabled={!dirty || save.isPending}
          onClick={onSave}
        >
          {save.isPending ? MODELS_COPY.saving : MODELS_COPY.save}
        </Button>
      </CardFooter>
    </Card>
  );
}
