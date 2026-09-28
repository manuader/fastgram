"use client";

import {
  LIBRARY_ASSET_KINDS,
  LIBRARY_IMPORT_BATCH_MAX,
  setLibrarySourceKeyRequestSchema,
  type LibraryAssetKind,
  type LibrarySearchResult,
  type LibrarySourceId,
  type LibrarySourceImportOutcome,
  type LibrarySourceStatus,
} from "@fastgram/contracts";
import { Badge, Button, EmptyState, Input, Select, Skeleton, cn } from "@fastgram/ui";
import { useId, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { SearchIcon } from "@/icons";
import { presentError } from "@/lib/api/error-presentation";
import { tw } from "@/lib/i18n/t";
import {
  useDeleteSourceKey,
  useImportFromSource,
  useLibrarySearch,
  useLibrarySources,
  useSetSourceKey,
} from "./api";
import { KIND_COPY, UNIMPORTABLE_COPY } from "./copy";
import { formatDuration } from "./parts";

function errorTitle(error: unknown): string {
  const p = presentError(error);
  return tw(p.titleKey, p.titleVars);
}

/**
 * Pegar la key de una fuente que la necesita (Pexels, Pixabay). Es un
 * `password`: la key no se muestra ni vuelve del servidor, y al guardarla el
 * campo se vacía — lo único que queda en pantalla es «está configurada».
 */
function SourceKeyForm({ source }: { readonly source: LibrarySourceStatus }) {
  const id = useId();
  const [apiKey, setApiKey] = useState("");
  const [invalid, setInvalid] = useState(false);
  const save = useSetSourceKey();
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = setLibrarySourceKeyRequestSchema.safeParse({ apiKey });
        setInvalid(!parsed.success);
        if (!parsed.success) return;
        save.mutate(
          { source: source.id, apiKey: parsed.data.apiKey },
          {
            onSuccess: () => {
              setApiKey("");
            },
          },
        );
      }}
    >
      <label htmlFor={id} className="text-xs font-medium text-text">
        {tw("globalLibrary.sources.key.label", { source: source.label })}
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={apiKey}
          invalid={invalid}
          onChange={(e) => {
            setApiKey(e.target.value);
          }}
          wrapperClassName="flex-1"
        />
        <Button type="submit" size="sm" loading={save.isPending}>
          {tw("globalLibrary.sources.key.save")}
        </Button>
      </div>
      {invalid && (
        <span role="alert" className="text-xs text-danger">
          {tw("globalLibrary.sources.key.invalid")}
        </span>
      )}
      {save.isError && (
        <span role="alert" className="text-xs text-danger">
          {errorTitle(save.error)}
        </span>
      )}
    </form>
  );
}

function SourceCard({
  source,
  selected,
  onSelect,
}: {
  readonly source: LibrarySourceStatus;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const removeKey = useDeleteSourceKey();
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-3",
        selected ? "border-accent" : "border-border",
      )}
      data-testid={`source-${source.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-pressed={selected}
          disabled={!source.enabled}
          className="fg-focusable text-left text-sm font-semibold text-text disabled:text-text-subtle"
          onClick={onSelect}
        >
          {source.label}
        </button>
        <Badge tone={source.enabled ? "success" : "neutral"} size="sm">
          {tw(
            source.enabled
              ? "globalLibrary.sources.ready"
              : "globalLibrary.sources.disabled",
          )}
        </Badge>
      </div>
      {source.disabledReason === "missing_key" && (
        <p className="m-0 text-xs text-text-muted">
          {tw("globalLibrary.sources.missingKey", { source: source.label })}
        </p>
      )}
      {source.needsKey && source.disabledReason === "missing_key" && (
        <SourceKeyForm source={source} />
      )}
      {source.needsKey && source.keyFrom === "env" && (
        <p className="m-0 text-xs text-text-muted">
          {tw("globalLibrary.sources.keyFromEnv")}
        </p>
      )}
      {source.needsKey && source.keyFrom === "file" && (
        <Button
          variant="ghost"
          size="sm"
          loading={removeKey.isPending}
          onClick={() => {
            removeKey.mutate(source.id);
          }}
        >
          {tw("globalLibrary.sources.key.remove")}
        </Button>
      )}
      <a
        href={source.licenseUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="text-xs text-accent underline"
      >
        {tw("globalLibrary.sources.license")}
      </a>
    </li>
  );
}

function ResultCard({
  result,
  selected,
  selectable,
  onToggle,
}: {
  readonly result: LibrarySearchResult;
  readonly selected: boolean;
  readonly selectable: boolean;
  readonly onToggle: () => void;
}) {
  const duration = formatDuration(result.durationSec);
  const already = result.existingAssetId !== null;
  const canPick = result.importable && !already;
  return (
    <li
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border",
        selected ? "border-accent" : "border-border",
        !canPick && "opacity-70",
      )}
      data-testid="search-result"
    >
      <div className="relative aspect-video w-full bg-surface-sunken">
        {result.previewUrl !== null && (
          <img
            src={result.previewUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        )}
        {duration !== null && (
          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-xs text-white">
            {duration}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 p-2 text-xs">
        <span className="truncate font-medium text-text" title={result.title}>
          {result.title}
        </span>
        <span className="text-text-muted">
          {result.licenseLabel}
          {result.width !== null && result.height !== null
            ? ` · ${String(result.width)}×${String(result.height)}`
            : ""}
          {result.sizeMb === null ? "" : ` · ${result.sizeMb.toFixed(1)} MB`}
        </span>
        {result.license?.attribution !== undefined && (
          <span className="truncate text-text-muted" title={result.license.attribution}>
            {tw("globalLibrary.attribution", { text: result.license.attribution })}
          </span>
        )}
        {result.license?.attribution === undefined &&
          result.license?.author !== undefined && (
            <span className="truncate text-text-muted">
              {tw("globalLibrary.author", { name: result.license.author })}
            </span>
          )}
        {already ? (
          <Badge tone="info" size="sm">
            {tw("globalLibrary.sources.alreadyInLibrary")}
          </Badge>
        ) : !result.importable ? (
          <span className="text-danger">
            {tw(
              result.unimportableReason === null
                ? "globalLibrary.unimportable.unknown"
                : UNIMPORTABLE_COPY[result.unimportableReason],
            )}
          </span>
        ) : (
          <label className="flex items-center gap-1.5 text-text">
            <input
              type="checkbox"
              checked={selected}
              disabled={!selected && !selectable}
              onChange={onToggle}
            />
            {tw("globalLibrary.sources.select")}
          </label>
        )}
        <a
          href={result.pageUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline"
        >
          {tw("globalLibrary.sources.viewOnSource")}
        </a>
      </div>
    </li>
  );
}

function OutcomeList({
  outcomes,
}: {
  readonly outcomes: readonly LibrarySourceImportOutcome[];
}) {
  return (
    <ul
      className="m-0 flex list-none flex-col gap-1 p-0 text-sm"
      aria-label={tw("globalLibrary.sources.outcomes")}
    >
      {outcomes.map((o) => (
        <li key={o.externalId} className="flex flex-wrap gap-2">
          <Badge
            tone={
              o.outcome === "queued"
                ? "success"
                : o.outcome === "duplicate"
                  ? "info"
                  : "danger"
            }
            size="sm"
          >
            {tw(
              o.outcome === "queued"
                ? "globalLibrary.sources.outcome.queued"
                : o.outcome === "duplicate"
                  ? "globalLibrary.sources.outcome.duplicate"
                  : "globalLibrary.sources.outcome.rejected",
            )}
          </Badge>
          <span className="text-text-muted">{o.externalId}</span>
          {o.reason !== null && (
            <span className="text-danger">{tw(UNIMPORTABLE_COPY[o.reason])}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Buscar en Wikimedia / Pexels / Pixabay e importar lo elegido. Lo que no se
 * puede importar **se ve igual**, con el motivo: esconderlo haría pensar que
 * la fuente no tiene nada, cuando lo tiene con una licencia que no entra.
 * El crédito de la fuente va siempre debajo de los resultados (Pexels y
 * Pixabay lo exigen en sus términos de API).
 */
export function SourcesPanel({ onImported }: { readonly onImported?: () => void }) {
  const searchId = useId();
  const kindId = useId();
  const sources = useLibrarySources();
  const [picked, setPicked] = useState<LibrarySourceId | null>(null);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [kind, setKind] = useState<LibraryAssetKind | "">("");
  const importer = useImportFromSource();

  const list = sources.data ?? [];
  // Sin elección explícita, la primera fuente lista.
  const active = picked ?? list.find((s) => s.enabled)?.id ?? null;
  const activeStatus = list.find((s) => s.id === active) ?? null;
  const search = useLibrarySearch(
    activeStatus?.enabled === true ? active : null,
    q,
    page,
  );

  const choose = (id: LibrarySourceId) => {
    setPicked(id);
    setPage(1);
    setSelection([]);
    importer.reset();
  };
  const toggle = (externalId: string) => {
    setSelection((s) =>
      s.includes(externalId) ? s.filter((x) => x !== externalId) : [...s, externalId],
    );
  };

  if (sources.isError) {
    return (
      <ApiErrorState
        error={sources.error}
        onRetry={() => {
          void sources.refetch();
        }}
      />
    );
  }
  if (sources.isPending) {
    return (
      <div className="grid gap-3 sm:grid-cols-3" aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul
        className="m-0 grid list-none gap-3 p-0 sm:grid-cols-3"
        aria-label={tw("globalLibrary.sources.title")}
      >
        {list.map((s) => (
          <SourceCard
            key={s.id}
            source={s}
            selected={s.id === active}
            onSelect={() => {
              choose(s.id);
            }}
          />
        ))}
      </ul>

      {activeStatus?.enabled === true && (
        <>
          <form
            className="flex gap-2"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              setQ(draft.trim());
              setPage(1);
              setSelection([]);
              importer.reset();
            }}
          >
            <Input
              id={searchId}
              type="search"
              value={draft}
              maxLength={100}
              placeholder={tw("globalLibrary.sources.searchPlaceholder", {
                source: activeStatus.label,
              })}
              aria-label={tw("globalLibrary.sources.searchPlaceholder", {
                source: activeStatus.label,
              })}
              leadingIcon={<SearchIcon size={16} />}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              wrapperClassName="flex-1"
            />
            <Button type="submit" variant="secondary" disabled={draft.trim() === ""}>
              {tw("globalLibrary.sources.search")}
            </Button>
          </form>

          {q === "" ? null : search.isError ? (
            <ApiErrorState
              error={search.error}
              onRetry={() => {
                void search.refetch();
              }}
            />
          ) : search.isPending ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="aspect-video rounded-xl" />
              ))}
            </div>
          ) : (
            <>
              {search.data.results.length === 0 ? (
                <EmptyState
                  title={tw("globalLibrary.sources.noResults")}
                  description={tw("globalLibrary.sources.noResultsBody")}
                />
              ) : (
                <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4">
                  {search.data.results.map((r) => (
                    <ResultCard
                      key={r.externalId}
                      result={r}
                      selected={selection.includes(r.externalId)}
                      selectable={selection.length < LIBRARY_IMPORT_BATCH_MAX}
                      onToggle={() => {
                        toggle(r.externalId);
                      }}
                    />
                  ))}
                </ul>
              )}
              <p className="m-0 text-xs text-text-muted" data-testid="source-credit">
                <a
                  href={search.data.credit.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline"
                >
                  {search.data.credit.text}
                </a>
              </p>
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => {
                    setPage((p) => Math.max(1, p - 1));
                  }}
                >
                  {tw("globalLibrary.sources.prev")}
                </Button>
                <span className="text-xs text-text-muted">
                  {tw("globalLibrary.sources.page", { page })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={search.data.nextPage === null}
                  onClick={() => {
                    setPage((p) => search.data?.nextPage ?? p);
                  }}
                >
                  {tw("globalLibrary.sources.next")}
                </Button>
              </div>
            </>
          )}

          {q !== "" && (
            <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor={kindId} className="text-xs font-medium text-text">
                  {tw("globalLibrary.sources.importAs")}
                </label>
                <Select
                  id={kindId}
                  value={kind}
                  onChange={(e) => {
                    setKind(LIBRARY_ASSET_KINDS.find((k) => k === e.target.value) ?? "");
                  }}
                  options={[
                    { value: "", label: tw("globalLibrary.upload.kindAuto") },
                    ...LIBRARY_ASSET_KINDS.map((k) => ({
                      value: k,
                      label: tw(KIND_COPY[k]),
                    })),
                  ]}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-muted">
                  {tw("globalLibrary.sources.selected", {
                    count: selection.length,
                    max: LIBRARY_IMPORT_BATCH_MAX,
                  })}
                </span>
                <Button
                  disabled={selection.length === 0 || active === null}
                  loading={importer.isPending}
                  onClick={() => {
                    if (active === null || selection.length === 0) return;
                    importer.mutate(
                      {
                        source: active,
                        body: {
                          externalIds: [...selection],
                          ...(kind === "" ? {} : { kind }),
                        },
                      },
                      {
                        onSuccess: () => {
                          setSelection([]);
                          onImported?.();
                        },
                      },
                    );
                  }}
                >
                  {tw("globalLibrary.sources.import")}
                </Button>
              </div>
            </div>
          )}
          {importer.isError && (
            <p role="alert" className="m-0 text-sm text-danger">
              {errorTitle(importer.error)}
            </p>
          )}
          {importer.data !== undefined && <OutcomeList outcomes={importer.data} />}
        </>
      )}
    </div>
  );
}
