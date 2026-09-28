"use client";

import {
  LIBRARY_ASPECT_RATIOS,
  LIBRARY_ASSET_KINDS,
  LIBRARY_EMOTIONS,
  LIBRARY_LICENSE_TYPES,
  LIBRARY_MEME_TYPES,
  type LibraryAsset,
} from "@fastgram/contracts";
import { Button, Checkbox, EmptyState, Input, Select } from "@fastgram/ui";
import { useEffect, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { MediaGridSkeleton } from "@/components/library/MediaGridSkeleton";
import { PageHeader } from "@/components/shell/PageHeader";
import { LayersIcon, PlusIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import {
  ALL_LIBRARY_STATUSES,
  EMPTY_LIBRARY_FILTERS,
  flattenLibraryPages,
  useLibraryAssets,
  type LibraryFilters,
} from "./api";
import { AssetDetailDialog } from "./AssetDetailDialog";
import {
  ASPECT_COPY,
  EMOTION_COPY,
  KIND_COPY,
  LICENSE_COPY,
  MEME_TYPE_COPY,
} from "./copy";
import { ImportDialog } from "./ImportDialog";
import {
  AssetPreview,
  AssetStatusBadges,
  FailureNote,
  KindBadge,
  LicenseLine,
  formatDuration,
} from "./parts";
import { useUseInBrandFlow } from "./use-in-brand";

/** `""` es «sin filtro»: un `<select>` no puede tener valor `undefined`. */
const ANY = "";
/** Topes de duración que tienen sentido para un meme (segundos). */
const MAX_DURATIONS = [3, 5, 10, 30, 60] as const;

function pick<T extends string>(values: readonly T[], raw: string): T | null {
  return values.find((v) => v === raw) ?? null;
}

export function GlobalAssetCard({
  asset,
  onOpen,
  onUseInBrand,
  usingInBrand,
  added,
  brand,
}: {
  readonly asset: LibraryAsset;
  readonly onOpen: () => void;
  readonly onUseInBrand: () => void;
  readonly usingInBrand: boolean;
  readonly added: boolean;
  readonly brand: string;
}) {
  const duration = formatDuration(asset.durationSec);
  return (
    <li
      className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
      data-testid="global-asset-card"
    >
      <AssetPreview asset={asset} />
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 truncate font-semibold text-text" title={asset.title}>
            {asset.title}
          </span>
          {duration !== null && (
            <span className="shrink-0 text-xs text-text-muted">{duration}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <KindBadge asset={asset} />
          <AssetStatusBadges asset={asset} />
        </div>
        <LicenseLine asset={asset} />
        <FailureNote asset={asset} />
        {added && (
          <span role="status" className="text-xs text-success">
            {tw("globalLibrary.useInBrand.added", { brand })}
          </span>
        )}
        <div className="mt-auto flex gap-2 pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={onOpen}
            aria-label={tw("globalLibrary.card.openFor", { title: asset.title })}
          >
            {tw("globalLibrary.card.open")}
          </Button>
          <Button
            size="sm"
            disabled={asset.status !== "ready"}
            loading={usingInBrand}
            onClick={onUseInBrand}
            aria-label={tw("globalLibrary.useInBrand.actionFor", { title: asset.title })}
          >
            {tw("globalLibrary.useInBrand.action")}
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * `/library/assets` — la biblioteca **global** de assets (sprint 9, N, D-19).
 *
 * Es del dueño, no de la marca: se ve igual desde cualquier marca. Lo único
 * que toca la marca activa es «Use in brand», que copia el asset a su Media
 * Bank (o a su audio).
 *
 * Mismos cuatro estados y mismo orden que el Media Bank (ver la cabecera de
 * `MyMediaBankTab`): el error de la primera carga reemplaza la grilla —una
 * biblioteca vacía y una que no cargó no pueden verse igual—, después el
 * skeleton, después el vacío (distinto si hay filtros: la salida es quitarlos)
 * y por último la grilla con «Load more».
 */
export function GlobalLibraryScreen() {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_LIBRARY_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const useInBrand = useUseInBrandFlow();

  // Debounce de la búsqueda: una petición por palabra, no por tecla.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim() }));
    }, 300);
    return () => {
      window.clearTimeout(id);
    };
  }, [search]);

  const query = useLibraryAssets(filters);
  const items = flattenLibraryPages(query.data);
  const filtered =
    filters.q !== "" ||
    filters.kinds.length > 0 ||
    filters.memeType !== null ||
    filters.emotion !== null ||
    filters.aspect !== null ||
    filters.license !== null ||
    filters.maxDuration !== null ||
    filters.statuses !== null;
  const clearFilters = () => {
    setSearch("");
    setFilters(EMPTY_LIBRARY_FILTERS);
  };
  const set = <K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const filterBar = (
    <div className="fgw-library-filters">
      <Input
        type="search"
        value={search}
        placeholder={tw("globalLibrary.filter.search")}
        aria-label={tw("globalLibrary.filter.search")}
        onChange={(e) => {
          setSearch(e.target.value);
        }}
        wrapperClassName="min-w-[12rem]"
      />
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">
          {tw("globalLibrary.filter.kind")}
        </span>
        <Select
          value={filters.kinds[0] ?? ANY}
          onChange={(e) => {
            const k = pick(LIBRARY_ASSET_KINDS, e.target.value);
            set("kinds", k === null ? [] : [k]);
          }}
          options={[
            { value: ANY, label: tw("globalLibrary.filter.any") },
            ...LIBRARY_ASSET_KINDS.map((v) => ({ value: v, label: tw(KIND_COPY[v]) })),
          ]}
        />
      </label>
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">
          {tw("globalLibrary.filter.memeType")}
        </span>
        <Select
          value={filters.memeType ?? ANY}
          onChange={(e) => {
            set("memeType", pick(LIBRARY_MEME_TYPES, e.target.value));
          }}
          options={[
            { value: ANY, label: tw("globalLibrary.filter.any") },
            ...LIBRARY_MEME_TYPES.map((v) => ({
              value: v,
              label: tw(MEME_TYPE_COPY[v]),
            })),
          ]}
        />
      </label>
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">
          {tw("globalLibrary.filter.emotion")}
        </span>
        <Select
          value={filters.emotion ?? ANY}
          onChange={(e) => {
            set("emotion", pick(LIBRARY_EMOTIONS, e.target.value));
          }}
          options={[
            { value: ANY, label: tw("globalLibrary.filter.any") },
            ...LIBRARY_EMOTIONS.map((v) => ({ value: v, label: tw(EMOTION_COPY[v]) })),
          ]}
        />
      </label>
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">
          {tw("globalLibrary.filter.aspect")}
        </span>
        <Select
          value={filters.aspect ?? ANY}
          onChange={(e) => {
            set("aspect", pick(LIBRARY_ASPECT_RATIOS, e.target.value));
          }}
          options={[
            { value: ANY, label: tw("globalLibrary.filter.any") },
            ...LIBRARY_ASPECT_RATIOS.map((v) => ({
              value: v,
              label: tw(ASPECT_COPY[v]),
            })),
          ]}
        />
      </label>
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">
          {tw("globalLibrary.filter.license")}
        </span>
        <Select
          value={filters.license ?? ANY}
          onChange={(e) => {
            set("license", pick(LIBRARY_LICENSE_TYPES, e.target.value));
          }}
          options={[
            { value: ANY, label: tw("globalLibrary.filter.any") },
            ...LIBRARY_LICENSE_TYPES.map((v) => ({
              value: v,
              label: tw(LICENSE_COPY[v]),
            })),
          ]}
        />
      </label>
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">
          {tw("globalLibrary.filter.maxDuration")}
        </span>
        <Select
          value={filters.maxDuration === null ? ANY : String(filters.maxDuration)}
          onChange={(e) => {
            const n = Number(e.target.value);
            set("maxDuration", e.target.value === ANY || !Number.isFinite(n) ? null : n);
          }}
          options={[
            { value: ANY, label: tw("globalLibrary.filter.any") },
            ...MAX_DURATIONS.map((s) => ({
              value: String(s),
              label: tw("globalLibrary.filter.upTo", { seconds: s }),
            })),
          ]}
        />
      </label>
      <Checkbox
        label={tw("globalLibrary.filter.showAll")}
        checked={filters.statuses !== null}
        onChange={(e) => {
          set("statuses", e.target.checked ? ALL_LIBRARY_STATUSES : null);
        }}
      />
    </div>
  );

  const openAsset = openId === null ? null : (items.find((a) => a.id === openId) ?? null);

  return (
    <>
      <PageHeader
        title={tw("globalLibrary.title")}
        description={tw("globalLibrary.subtitle")}
        actions={
          <Button
            leadingIcon={<PlusIcon size={16} />}
            onClick={() => {
              setImportOpen(true);
            }}
          >
            {tw("globalLibrary.import.open")}
          </Button>
        }
      />
      <div className="fgw-library-panel" aria-busy={query.isPending ? "true" : undefined}>
        {filterBar}
        {renderBody()}
      </div>
      <AssetDetailDialog
        assetId={openId}
        fallback={openAsset}
        onClose={() => {
          setOpenId(null);
        }}
      />
      <ImportDialog
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
        }}
      />
    </>
  );

  function renderBody() {
    if (query.isError && items.length === 0) {
      return (
        <ApiErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      );
    }
    if (query.isPending) return <MediaGridSkeleton />;
    if (items.length === 0) {
      return (
        <EmptyState
          bordered
          icon={<LayersIcon size={24} />}
          title={tw(
            filtered ? "globalLibrary.empty.filteredTitle" : "globalLibrary.empty.title",
          )}
          description={tw(
            filtered ? "globalLibrary.empty.filteredBody" : "globalLibrary.empty.body",
          )}
          action={
            filtered ? (
              <Button variant="secondary" onClick={clearFilters}>
                {tw("globalLibrary.empty.clearFilters")}
              </Button>
            ) : (
              <Button
                leadingIcon={<PlusIcon size={16} />}
                onClick={() => {
                  setImportOpen(true);
                }}
              >
                {tw("globalLibrary.import.open")}
              </Button>
            )
          }
        />
      );
    }
    return (
      <>
        <ul className="m-0 grid list-none grid-cols-2 gap-4 p-0 sm:grid-cols-3 xl:grid-cols-5">
          {items.map((asset) => (
            <GlobalAssetCard
              key={asset.id}
              asset={asset}
              brand={useInBrand.brand}
              added={useInBrand.addedIds.includes(asset.id)}
              usingInBrand={useInBrand.pendingId === asset.id}
              onOpen={() => {
                setOpenId(asset.id);
              }}
              onUseInBrand={() => {
                useInBrand.run(asset.id);
              }}
            />
          ))}
        </ul>
        {/* El error de «Load more» no borra lo que ya está en pantalla. */}
        {query.isError && (
          <ApiErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        )}
        {query.hasNextPage && (
          <div className="fgw-library-more">
            <Button
              variant="secondary"
              loading={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {tw("globalLibrary.loadMore")}
            </Button>
          </div>
        )}
      </>
    );
  }
}
