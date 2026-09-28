"use client";

import {
  LIBRARY_ASSET_KINDS,
  LIBRARY_DESCRIPTION_MAX,
  LIBRARY_EMOTIONS,
  LIBRARY_ENERGY_LEVELS,
  LIBRARY_FRAMINGS,
  LIBRARY_MEME_TYPES,
  LIBRARY_TAG_MAX,
  type LibraryAsset,
  type LibraryEmotion,
} from "@fastgram/contracts";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  Skeleton,
  Textarea,
  cn,
} from "@fastgram/ui";
import { useId, useState, type ReactNode } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { presentError } from "@/lib/api/error-presentation";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import {
  detailFormFrom,
  detailPatch,
  useDeleteLibraryAsset,
  useLibraryAsset,
  useUpdateLibraryAsset,
  type AssetDetailForm,
} from "./api";
import { ChipListInput } from "./ChipListInput";
import {
  ASPECT_COPY,
  CHROMA_COPY,
  EMOTION_COPY,
  ENERGY_COPY,
  FRAMING_COPY,
  KIND_COPY,
  LICENSE_COPY,
  MEME_TYPE_COPY,
} from "./copy";
import { AssetPreview, AssetStatusBadges, FailureNote, formatDuration } from "./parts";
import { useUseInBrandFlow } from "./use-in-brand";

/** Los topes del contrato (`libraryMetadataFieldsSchema`), para los chips. */
const MAX_EMOTIONS = 6;
const MAX_USE_CASES = 8;
const MAX_CHARACTERS = 6;
const MAX_TAGS = 20;

export interface AssetDetailDialogProps {
  /** `null` = cerrado. */
  readonly assetId: string | null;
  /**
   * El asset tal como estaba en la grilla, para dibujar al instante mientras
   * llega el detalle. El detalle manda: puede haber cambiado (terminó de
   * procesar) o haber salido del listado (se ocultó).
   */
  readonly fallback?: LibraryAsset | null;
  readonly onClose: () => void;
}

/**
 * El detalle de un asset de la biblioteca global: el JSON de metadatos como
 * **formulario** (no un textarea de JSON: el dueño corrige lo que el modelo
 * etiquetó mal, no escribe JSON), lo medido y la licencia en sólo lectura, y
 * las acciones (guardar, ocultar, borrar, usar en la marca).
 *
 * Se lee el detalle por id (`GET /library/assets/{id}`) y no sólo la fila de
 * la grilla: ocultar un asset lo saca del listado por defecto, y el diálogo
 * no puede desaparecer bajo los pies de quien acaba de apretar «Hide».
 */
export function AssetDetailDialog({
  assetId,
  fallback,
  onClose,
}: AssetDetailDialogProps) {
  const detail = useLibraryAsset(assetId);
  const asset = detail.data ?? (fallback?.id === assetId ? fallback : null) ?? null;

  return (
    <Dialog open={assetId !== null} onClose={onClose} size="xl">
      <DialogHeader>
        <DialogTitle>{asset?.title ?? tw("globalLibrary.detail.title")}</DialogTitle>
        <DialogClose label={tw("globalLibrary.close")} />
      </DialogHeader>
      {asset !== null ? (
        // La `key` vuelve a sembrar el formulario cuando llegan los metadatos
        // (el worker terminó de etiquetar): sembrado sin ellos, el formulario
        // vacío se leería como «el dueño borró todo» y se mandaría en el PATCH.
        <DetailBody
          key={`${asset.id}:${asset.metadata === null ? "raw" : "tagged"}`}
          asset={asset}
          onClose={onClose}
        />
      ) : detail.isError ? (
        <DialogBody>
          <ApiErrorState
            error={detail.error}
            onRetry={() => {
              void detail.refetch();
            }}
          />
        </DialogBody>
      ) : (
        <DialogBody>
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="aspect-video w-full rounded-xl" />
            <Skeleton shape="text" width="60%" />
            <Skeleton shape="text" width="40%" />
          </div>
        </DialogBody>
      )}
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-text">
        {label}
      </label>
      {children}
      {hint !== undefined && <span className="text-xs text-text-subtle">{hint}</span>}
    </div>
  );
}

function ReadOnlyRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex justify-between gap-3 py-1 text-sm">
      <dt className="text-text-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-right text-text">{children}</dd>
    </div>
  );
}

/** Los campos que el servidor señaló en un `400` (`details.issues[].path`). */
function issuePaths(error: unknown): string[] {
  if (!isApiRequestError(error)) return [];
  const issues = error.details?.["issues"];
  if (!Array.isArray(issues)) return [];
  const paths = issues.flatMap((issue: unknown) => {
    if (typeof issue !== "object" || issue === null || !("path" in issue)) return [];
    const path = (issue as { path: unknown }).path;
    return Array.isArray(path) && path.length > 0 ? [path.map(String).join(".")] : [];
  });
  return [...new Set(paths)];
}

function ServerError({ error }: { readonly error: unknown }) {
  const p = presentError(error);
  const paths = issuePaths(error);
  return (
    <div role="alert" className="flex flex-col gap-0.5 text-sm text-danger">
      <span>{tw(p.titleKey, p.titleVars)}</span>
      {paths.length > 0 && (
        <span className="text-xs">
          {tw("globalLibrary.detail.invalidFields", { fields: paths.join(", ") })}
        </span>
      )}
    </div>
  );
}

function DetailBody({
  asset,
  onClose,
}: {
  readonly asset: LibraryAsset;
  readonly onClose: () => void;
}) {
  const ids = {
    title: useId(),
    kind: useId(),
    description: useId(),
    memeType: useId(),
    language: useId(),
    framing: useId(),
    energy: useId(),
  };
  const [form, setForm] = useState<AssetDetailForm>(() => detailFormFrom(asset));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = useUpdateLibraryAsset(asset.id);
  const visibility = useUpdateLibraryAsset(asset.id);
  const remove = useDeleteLibraryAsset(asset.id);
  const useInBrand = useUseInBrandFlow();

  const patch = detailPatch(asset, form);
  const dirty = Object.keys(patch).length > 0;
  const m = asset.metadata;
  const hidden = asset.status === "hidden";
  const set = <K extends keyof AssetDetailForm>(key: K, value: AssetDetailForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };
  const toggleEmotion = (emotion: LibraryEmotion) => {
    set(
      "emotions",
      form.emotions.includes(emotion)
        ? form.emotions.filter((e) => e !== emotion)
        : [...form.emotions, emotion],
    );
  };

  const { license } = asset;
  const duration = formatDuration(m?.durationSec ?? asset.durationSec);

  return (
    <>
      <DialogBody>
        <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          {/* Izquierda: lo que se ve y lo que no se edita. */}
          <div className="flex flex-col gap-4">
            <div className="overflow-hidden rounded-xl border border-border">
              <AssetPreview asset={asset} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <AssetStatusBadges asset={asset} />
              <Badge tone="neutral" size="sm" data-testid="metadata-source">
                {tw(
                  asset.metadataSource === "edited"
                    ? "globalLibrary.detail.source.edited"
                    : "globalLibrary.detail.source.auto",
                )}
              </Badge>
            </div>
            <FailureNote asset={asset} />

            <section aria-labelledby={`${ids.title}-measured`}>
              <h3
                id={`${ids.title}-measured`}
                className="m-0 mb-1 text-xs font-semibold uppercase tracking-wide text-text-subtle"
              >
                {tw("globalLibrary.detail.measured")}
              </h3>
              <dl className="m-0" data-testid="measured-block">
                <ReadOnlyRow label={tw("globalLibrary.detail.duration")}>
                  {duration ?? "—"}
                </ReadOnlyRow>
                <ReadOnlyRow label={tw("globalLibrary.detail.aspect")}>
                  {m === null
                    ? "—"
                    : `${tw(ASPECT_COPY[m.aspect.ratio])}${
                        m.aspect.width !== null && m.aspect.height !== null
                          ? ` · ${String(m.aspect.width)}×${String(m.aspect.height)}`
                          : ""
                      }`}
                </ReadOnlyRow>
                <ReadOnlyRow label={tw("globalLibrary.detail.chroma")}>
                  {m === null ? "—" : tw(CHROMA_COPY[m.chroma.type])}
                </ReadOnlyRow>
                <ReadOnlyRow label={tw("globalLibrary.detail.keyQuality")}>
                  {m?.chroma.keyQuality == null
                    ? "—"
                    : `${String(Math.round(m.chroma.keyQuality * 100))}%`}
                </ReadOnlyRow>
                <ReadOnlyRow label={tw("globalLibrary.detail.keyColor")}>
                  {m?.chroma.keyColor == null ? (
                    "—"
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="inline-block h-3.5 w-3.5 rounded border border-border"
                        style={{ backgroundColor: m.chroma.keyColor }}
                      />
                      <code className="text-xs">{m.chroma.keyColor}</code>
                    </span>
                  )}
                </ReadOnlyRow>
              </dl>
            </section>

            <section aria-labelledby={`${ids.title}-license`}>
              <h3
                id={`${ids.title}-license`}
                className="m-0 mb-1 text-xs font-semibold uppercase tracking-wide text-text-subtle"
              >
                {tw("globalLibrary.detail.license")}
              </h3>
              <dl className="m-0" data-testid="license-block">
                <ReadOnlyRow label={tw("globalLibrary.detail.licenseType")}>
                  {tw(LICENSE_COPY[license.type])}
                  {license.version === undefined ? "" : ` ${license.version}`}
                </ReadOnlyRow>
                {license.author !== undefined && (
                  <ReadOnlyRow label={tw("globalLibrary.upload.license.author")}>
                    {license.author}
                  </ReadOnlyRow>
                )}
                {license.attribution !== undefined && (
                  <ReadOnlyRow label={tw("globalLibrary.upload.license.attribution")}>
                    {license.attribution}
                  </ReadOnlyRow>
                )}
                {license.sourceUrl !== undefined && (
                  <ReadOnlyRow label={tw("globalLibrary.upload.license.sourceUrl")}>
                    <a
                      href={license.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-accent underline"
                    >
                      {tw("globalLibrary.detail.openSource")}
                    </a>
                  </ReadOnlyRow>
                )}
                {license.licenseUrl !== undefined && (
                  <ReadOnlyRow label={tw("globalLibrary.upload.license.licenseUrl")}>
                    <a
                      href={license.licenseUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-accent underline"
                    >
                      {tw("globalLibrary.detail.openLicense")}
                    </a>
                  </ReadOnlyRow>
                )}
                <ReadOnlyRow label={tw("globalLibrary.detail.verifiedAt")}>
                  {new Date(license.verifiedAt).toLocaleDateString()}
                </ReadOnlyRow>
              </dl>
            </section>
          </div>

          {/* Derecha: lo que el dueño corrige. */}
          <form
            className="flex flex-col gap-4"
            aria-label={tw("globalLibrary.detail.formLabel")}
            onSubmit={(e) => {
              e.preventDefault();
              if (!dirty) return;
              // Lo guardado vuelve a sembrar el formulario: lo que queda en
              // pantalla es lo que quedó en el servidor (que normaliza, p. ej.
              // recorta espacios), y «sin cambios» vuelve a ser cierto.
              update.mutate(patch, {
                onSuccess: (saved) => {
                  setForm(detailFormFrom(saved));
                },
              });
            }}
          >
            <Field label={tw("globalLibrary.detail.titleField")} htmlFor={ids.title}>
              <Input
                id={ids.title}
                value={form.title}
                maxLength={200}
                onChange={(e) => {
                  set("title", e.target.value);
                }}
              />
            </Field>
            <Field label={tw("globalLibrary.detail.kind")} htmlFor={ids.kind}>
              <Select
                id={ids.kind}
                value={form.kind}
                onChange={(e) => {
                  const next = LIBRARY_ASSET_KINDS.find((k) => k === e.target.value);
                  if (next !== undefined) set("kind", next);
                }}
                options={LIBRARY_ASSET_KINDS.map((k) => ({
                  value: k,
                  label: tw(KIND_COPY[k]),
                }))}
              />
            </Field>

            {m === null ? (
              <p className="m-0 text-sm text-text-muted">
                {tw("globalLibrary.detail.noMetadata")}
              </p>
            ) : (
              <>
                {m.needsReview && (
                  <p className="m-0 rounded-lg border border-warning px-3 py-2 text-sm text-text">
                    {tw("globalLibrary.detail.needsReviewHint")}
                  </p>
                )}
                <Field
                  label={tw("globalLibrary.detail.description")}
                  htmlFor={ids.description}
                  hint={tw("globalLibrary.detail.descriptionHint", {
                    count: form.description.length,
                    max: LIBRARY_DESCRIPTION_MAX,
                  })}
                >
                  <Textarea
                    id={ids.description}
                    value={form.description}
                    rows={3}
                    maxLength={LIBRARY_DESCRIPTION_MAX}
                    onChange={(e) => {
                      set("description", e.target.value);
                    }}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field
                    label={tw("globalLibrary.detail.memeType")}
                    htmlFor={ids.memeType}
                  >
                    <Select
                      id={ids.memeType}
                      value={form.memeType ?? ""}
                      onChange={(e) => {
                        const next = LIBRARY_MEME_TYPES.find((v) => v === e.target.value);
                        if (next !== undefined) set("memeType", next);
                      }}
                      options={LIBRARY_MEME_TYPES.map((v) => ({
                        value: v,
                        label: tw(MEME_TYPE_COPY[v]),
                      }))}
                    />
                  </Field>
                  <Field label={tw("globalLibrary.detail.framing")} htmlFor={ids.framing}>
                    <Select
                      id={ids.framing}
                      value={form.framing ?? ""}
                      onChange={(e) => {
                        const next = LIBRARY_FRAMINGS.find((v) => v === e.target.value);
                        if (next !== undefined) set("framing", next);
                      }}
                      options={LIBRARY_FRAMINGS.map((v) => ({
                        value: v,
                        label: tw(FRAMING_COPY[v]),
                      }))}
                    />
                  </Field>
                  <Field label={tw("globalLibrary.detail.energy")} htmlFor={ids.energy}>
                    <Select
                      id={ids.energy}
                      value={form.energy ?? ""}
                      onChange={(e) => {
                        const next = LIBRARY_ENERGY_LEVELS.find(
                          (v) => v === e.target.value,
                        );
                        if (next !== undefined) set("energy", next);
                      }}
                      options={LIBRARY_ENERGY_LEVELS.map((v) => ({
                        value: v,
                        label: tw(ENERGY_COPY[v]),
                      }))}
                    />
                  </Field>
                </div>

                <div
                  className="flex flex-col gap-1.5"
                  role="group"
                  aria-labelledby={`${ids.title}-emotions`}
                >
                  <span
                    id={`${ids.title}-emotions`}
                    className="text-sm font-medium text-text"
                  >
                    {tw("globalLibrary.detail.emotions")}
                    <span className="ml-1 text-xs font-normal text-text-subtle">
                      {tw("globalLibrary.detail.chips.count", {
                        count: form.emotions.length,
                        max: MAX_EMOTIONS,
                      })}
                    </span>
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {LIBRARY_EMOTIONS.map((emotion) => {
                      const on = form.emotions.includes(emotion);
                      return (
                        <button
                          key={emotion}
                          type="button"
                          aria-pressed={on}
                          disabled={!on && form.emotions.length >= MAX_EMOTIONS}
                          className={cn(
                            "fg-focusable rounded-full border px-2.5 py-0.5 text-xs disabled:opacity-40",
                            on
                              ? "border-accent bg-accent-subtle text-text"
                              : "border-border text-text-muted hover:border-border-strong",
                          )}
                          onClick={() => {
                            toggleEmotion(emotion);
                          }}
                        >
                          {tw(EMOTION_COPY[emotion])}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <ChipListInput
                  label={tw("globalLibrary.detail.useCases")}
                  placeholder={tw("globalLibrary.detail.useCasesPlaceholder")}
                  values={form.useCases}
                  max={MAX_USE_CASES}
                  maxLength={120}
                  onChange={(v) => {
                    set("useCases", v);
                  }}
                />
                <ChipListInput
                  label={tw("globalLibrary.detail.characters")}
                  values={form.characters}
                  max={MAX_CHARACTERS}
                  maxLength={60}
                  onChange={(v) => {
                    set("characters", v);
                  }}
                />
                <ChipListInput
                  label={tw("globalLibrary.detail.tags")}
                  values={form.tags}
                  max={MAX_TAGS}
                  maxLength={LIBRARY_TAG_MAX}
                  onChange={(v) => {
                    set("tags", v);
                  }}
                />

                <div className="flex flex-wrap items-end gap-4">
                  <Checkbox
                    label={tw("globalLibrary.detail.hasSpeech")}
                    checked={form.hasSpeech}
                    onChange={(e) => {
                      set("hasSpeech", e.target.checked);
                    }}
                  />
                  {form.hasSpeech && (
                    <Field
                      label={tw("globalLibrary.detail.language")}
                      htmlFor={ids.language}
                      hint={tw("globalLibrary.detail.languageHint")}
                    >
                      <Input
                        id={ids.language}
                        value={form.language}
                        maxLength={6}
                        placeholder="en"
                        onChange={(e) => {
                          set("language", e.target.value);
                        }}
                      />
                    </Field>
                  )}
                </div>
              </>
            )}

            {update.isError && <ServerError error={update.error} />}
            {update.isSuccess && !dirty && (
              <p role="status" className="m-0 text-sm text-success">
                {tw("globalLibrary.detail.saved")}
              </p>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={!dirty} loading={update.isPending}>
                {tw("globalLibrary.detail.save")}
              </Button>
            </div>
          </form>
        </div>
      </DialogBody>
      <DialogFooter>
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {confirmDelete ? (
              <>
                <span className="text-sm text-text">
                  {tw("globalLibrary.delete.confirmText")}
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  loading={remove.isPending}
                  onClick={() => {
                    remove.mutate(undefined, { onSuccess: onClose });
                  }}
                >
                  {tw("globalLibrary.delete.confirm")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setConfirmDelete(false);
                  }}
                >
                  {tw("globalLibrary.cancel")}
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConfirmDelete(true);
                }}
              >
                {tw("globalLibrary.delete.open")}
              </Button>
            )}
            {(asset.status === "ready" || hidden) && (
              <Button
                variant="secondary"
                size="sm"
                loading={visibility.isPending}
                onClick={() => {
                  visibility.mutate({ hidden: !hidden });
                }}
              >
                {tw(hidden ? "globalLibrary.detail.unhide" : "globalLibrary.detail.hide")}
              </Button>
            )}
            {remove.isError && <ServerError error={remove.error} />}
            {visibility.isError && <ServerError error={visibility.error} />}
          </div>
          <div className="flex items-center gap-2">
            {useInBrand.addedIds.includes(asset.id) && (
              <span role="status" className="text-sm text-success">
                {tw("globalLibrary.useInBrand.added", { brand: useInBrand.brand })}
              </span>
            )}
            <Button
              size="sm"
              disabled={asset.status !== "ready"}
              loading={useInBrand.pendingId === asset.id}
              onClick={() => {
                useInBrand.run(asset.id);
              }}
            >
              {tw("globalLibrary.useInBrand.action")}
            </Button>
          </div>
        </div>
      </DialogFooter>
    </>
  );
}
