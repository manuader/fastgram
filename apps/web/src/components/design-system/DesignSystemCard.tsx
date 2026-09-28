"use client";

/**
 * Design system de la marca · sprint 9 (M), `PU-S9-001…004`, en `/brand`.
 *
 * Estados: cargando (skeleton), error de la API (reintentar), vacío (subir un
 * zip de Claude Design o derivar uno del análisis), importando (sondeo cada
 * 3 s), import fallido (el motivo con su código estable y volver a subir), y
 * listo: paleta, tipografías con specimen en la fuente real y licencia, assets,
 * resumen de estilo editable y generados pendientes de aprobación.
 */
import type { DesignSystemResource } from "@fastgram/contracts";
import { Button, Skeleton } from "@fastgram/ui";
import { useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";

import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw, type CopyKey } from "@/lib/i18n/t";

import {
  isImporting,
  useDeleteDesignSystem,
  useDeriveDesignSystem,
  useDesignSystem,
  useImportDesignSystem,
  zipRejection,
  type ZipRejection,
} from "./api";
import { AssetsPanel } from "./AssetsPanel";
import { PalettePanel } from "./PalettePanel";
import { StylePanel } from "./StylePanel";
import { TypographyPanel } from "./TypographyPanel";

const FAILURE_COPY: Readonly<Record<string, CopyKey>> = {
  zip_too_large: "designSystem.failure.zip_too_large",
  too_many_entries: "designSystem.failure.too_many_entries",
  unsafe_path: "designSystem.failure.unsafe_path",
  zip_bomb: "designSystem.failure.zip_bomb",
  not_a_zip: "designSystem.failure.not_a_zip",
  empty_design_system: "designSystem.failure.empty_design_system",
  storage_failed: "designSystem.failure.storage_failed",
};

const REJECTION_COPY: Readonly<Record<ZipRejection, CopyKey>> = {
  not_zip: "designSystem.import.notZip",
  too_large: "designSystem.import.tooLarge",
  empty: "designSystem.import.empty",
};

export function DesignSystemCard() {
  const baseId = useId();
  const state = useDesignSystem();
  const importing = useImportDesignSystem();
  const derive = useDeriveDesignSystem();
  const remove = useDeleteDesignSystem();
  const input = useRef<HTMLInputElement>(null);
  const [rejection, setRejection] = useState<ZipRejection | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  function start(file: File | undefined) {
    if (file === undefined) return;
    const why = zipRejection(file);
    setRejection(why);
    if (why !== null) return;
    setProgress(0);
    importing.mutate(
      { file, onProgress: setProgress },
      {
        onSettled: () => {
          setProgress(null);
        },
      },
    );
  }

  const active = state.data?.active ?? null;
  const latest = state.data?.latest ?? null;
  const busy = importing.isPending || isImporting(state.data);

  const dropzone = (
    <div
      className={`flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center ${dragging ? "border-accent bg-accent-subtle" : "border-border"}`}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => {
        setDragging(false);
      }}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        start(e.dataTransfer.files[0]);
      }}
      data-testid="ds-dropzone"
    >
      <p className="m-0">{tw("designSystem.import.drop")}</p>
      <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
        {tw("designSystem.import.choose")}
      </Button>
      {progress !== null && (
        <p className="fgw-brand__note m-0" role="status">
          {tw("designSystem.import.uploading", { percent: String(Math.round(progress)) })}
        </p>
      )}
    </div>
  );

  return (
    <section className="fgw-brand-section" aria-labelledby={`${baseId}-title`}>
      <header className="fgw-brand-section__header">
        <h2 id={`${baseId}-title`} className="fgw-brand-section__title">
          {tw("designSystem.title")}
        </h2>
        {active !== null && (
          <span className="fgw-brand__note">
            {tw(
              active.source === "zip"
                ? "designSystem.source.zip"
                : "designSystem.source.derived",
              {
                name: active.name,
                version: String(active.version),
              },
            )}
          </span>
        )}
      </header>
      <p className="fgw-brand__note">{tw("designSystem.subtitle")}</p>

      <input
        ref={input}
        id={`${baseId}-file`}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="fg-visually-hidden"
        aria-label={tw("designSystem.import.choose")}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          start(file);
        }}
      />

      {state.isPending ? (
        <div className="flex flex-col gap-2" data-testid="ds-loading">
          <Skeleton height={32} />
          <Skeleton height={96} />
        </div>
      ) : state.isError ? (
        <ApiErrorState
          error={state.error}
          onRetry={() => {
            void state.refetch();
          }}
        />
      ) : (
        <>
          {isImporting(state.data) && (
            <p
              className="rounded-md border border-border bg-surface-sunken p-3 text-sm"
              role="status"
            >
              {tw("designSystem.import.processing")}
            </p>
          )}
          {latest?.status === "failed" && (
            <div
              className="rounded-md border border-danger bg-surface-sunken p-3 text-sm text-danger"
              role="alert"
            >
              <p className="m-0">
                {tw(
                  FAILURE_COPY[latest.failureCode ?? ""] ??
                    "designSystem.failure.generic",
                )}
              </p>
            </div>
          )}
          {rejection !== null && (
            <p className="fgw-brand-field__error" role="alert">
              {tw(REJECTION_COPY[rejection])}
            </p>
          )}
          {importing.isError && (
            <ApiErrorState
              error={importing.error}
              onRetry={() => {
                importing.reset();
                input.current?.click();
              }}
            />
          )}
          {derive.isError && (
            <ApiErrorState
              error={derive.error}
              onRetry={() => {
                derive.reset();
                derive.mutate(undefined);
              }}
            />
          )}

          {active === null ? (
            <div className="flex flex-col gap-3" data-testid="ds-empty">
              <p className="m-0">{tw("designSystem.empty.body")}</p>
              {dropzone}
              <div className="fgw-brand-section__actions">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={derive.isPending}
                  disabled={busy || derive.isPending}
                  onClick={() => {
                    derive.mutate(undefined);
                  }}
                >
                  {tw("designSystem.derive")}
                </Button>
              </div>
            </div>
          ) : (
            <ActiveDesignSystem ds={active} />
          )}

          {active !== null && (
            <div className="fgw-brand-section__actions">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                {tw("designSystem.import.replace")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || remove.isPending}
                onClick={() => {
                  if (window.confirm(tw("designSystem.delete.confirm")))
                    remove.mutate(active.id);
                }}
              >
                {tw("designSystem.delete")}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ActiveDesignSystem({ ds }: { readonly ds: DesignSystemResource }) {
  return (
    <div className="flex flex-col gap-6" data-testid="ds-active">
      <PalettePanel ds={ds} />
      <TypographyPanel ds={ds} />
      <StylePanel ds={ds} />
      <AssetsPanel ds={ds} />
      {ds.warnings.length > 0 && (
        <details className="text-sm text-text-muted">
          <summary>
            {tw("designSystem.warnings", { count: String(ds.warnings.length) })}
          </summary>
          <ul>
            {ds.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
