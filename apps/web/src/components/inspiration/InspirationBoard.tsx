"use client";

import { Button, EmptyState, ErrorState, Input, Skeleton, cn } from "@fastgram/ui";
import type { InspirationFormat, InspirationItem } from "@fastgram/contracts";
import { useEffect, useId, useState, type ReactNode } from "react";
import { PlusIcon, SearchIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import {
  EMPTY_FILTERS,
  FORMAT_COPY,
  INSPIRATION_FORMATS,
  hasActiveFilters,
  useDeleteInspiration,
  useInspirationList,
  useInspirationTags,
  type InspirationFilters,
} from "@/lib/inspiration/inspiration";
import { InspirationCard } from "./InspirationCard";
import { RemixDialog } from "./RemixDialog";
import { SaveInspirationDialog } from "./SaveInspirationDialog";

/** El ancla con la que `⌘K › Save inspiration from link…` abre el diálogo. */
export const SAVE_INSPIRATION_HASH = "#save";

/**
 * `/inspiration` — el tablero de referencias propio (FR-040 adaptado, OQ-13).
 *
 * Buscador (`Search inspiration`), filtro por formato y por etiqueta
 * (combinables y reseteables: FR-040 criterio 1), grilla de tarjetas 9:16 y
 * paginación `Previous` / `Next`. Estados: cargando (esqueletos), vacío sin
 * nada guardado, `No results` con filtros (ERR-E02, literal), y error con el
 * copy de FR-040. `Inspiration is being set up` (ERR-E03) **no aplica**: no
 * hay catálogo que preparar, el tablero es del dueño.
 */
export function InspirationBoard() {
  const [filters, setFilters] = useState<InspirationFilters>(EMPTY_FILTERS);
  const [search, setSearch] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [remixing, setRemixing] = useState<InspirationItem | null>(null);
  const list = useInspirationList(filters);
  const tags = useInspirationTags();
  const del = useDeleteInspiration();
  const searchId = useId();

  // ⌘K navega a `/inspiration#save`: abrir el diálogo y limpiar el ancla.
  useEffect(() => {
    const openFromHash = (): void => {
      if (window.location.hash === SAVE_INSPIRATION_HASH) {
        setSaveOpen(true);
        window.history.replaceState(null, "", window.location.pathname);
      }
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => {
      window.removeEventListener("hashchange", openFromHash);
    };
  }, []);

  // La búsqueda se aplica con una pausa corta: no una petición por tecla.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setFilters((f) => (f.q === search ? f : { ...f, q: search, page: 1 }));
    }, 300);
    return () => {
      window.clearTimeout(t);
    };
  }, [search]);

  const setFormat = (format: InspirationFormat | null): void => {
    setFilters((f) => ({ ...f, format, page: 1 }));
  };
  const setTag = (tag: string | null): void => {
    setFilters((f) => ({ ...f, tag, page: 1 }));
  };
  const clearAll = (): void => {
    setSearch("");
    setFilters(EMPTY_FILTERS);
  };

  const filtering = hasActiveFilters(filters);
  const items = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor={searchId}
          className="relative flex min-w-[220px] flex-1 items-center"
        >
          <span className="sr-only">{tw("inspiration.searchLabel")}</span>
          <span className="pointer-events-none absolute left-3 text-text-muted">
            <SearchIcon size={16} />
          </span>
          <Input
            id={searchId}
            type="search"
            className="pl-9"
            placeholder={tw("inspiration.searchLabel")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </label>
        {search !== "" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearch("");
            }}
          >
            {tw("inspiration.clearSearch")}
          </Button>
        )}
        <Button
          onClick={() => {
            setSaveOpen(true);
          }}
        >
          <PlusIcon size={16} />
          {tw("inspiration.save")}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <ChipRow label={tw("inspiration.filter.format")}>
          <Chip active={filters.format === null} onClick={() => setFormat(null)}>
            {tw("inspiration.filter.all")}
          </Chip>
          {INSPIRATION_FORMATS.map((f) => (
            <Chip key={f} active={filters.format === f} onClick={() => setFormat(f)}>
              {tw(FORMAT_COPY[f])}
            </Chip>
          ))}
        </ChipRow>
        {(tags.data?.length ?? 0) > 0 && (
          <ChipRow label={tw("inspiration.filter.tag")}>
            <Chip active={filters.tag === null} onClick={() => setTag(null)}>
              {tw("inspiration.filter.all")}
            </Chip>
            {(tags.data ?? []).map((t) => (
              <Chip key={t} active={filters.tag === t} onClick={() => setTag(t)}>
                {t}
              </Chip>
            ))}
          </ChipRow>
        )}
        {filtering && (
          <div>
            <Button size="sm" variant="link" onClick={clearAll}>
              {tw("inspiration.clearAll")}
            </Button>
          </div>
        )}
      </div>

      {list.isPending ? (
        <div
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          aria-busy="true"
          aria-label={tw("common.loading")}
        >
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-[9/16] w-full rounded-xl" />
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState
          title={tw("inspiration.error")}
          onRetry={() => {
            void list.refetch();
          }}
        />
      ) : items.length === 0 ? (
        filtering ? (
          <EmptyState
            title={tw("empty.inspiration.title")}
            description={tw("empty.inspiration.description")}
            action={
              <Button variant="secondary" onClick={clearAll}>
                {tw("inspiration.clearAll")}
              </Button>
            }
          />
        ) : (
          <EmptyState
            title={tw("inspiration.emptyBoard.title")}
            description={tw("inspiration.emptyBoard.description")}
            action={
              <Button
                onClick={() => {
                  setSaveOpen(true);
                }}
              >
                {tw("inspiration.save")}
              </Button>
            }
          />
        )
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {items.map((item) => (
              <li key={item.id}>
                <InspirationCard
                  item={item}
                  onRemix={setRemixing}
                  onDelete={(i) => {
                    del.mutate(i.id);
                  }}
                  deleting={del.isPending && del.variables === item.id}
                />
              </li>
            ))}
          </ul>
          {del.isError && (
            <p role="alert" className="text-sm text-danger">
              {tw("inspiration.card.deleteFailed")}
            </p>
          )}
          {(filters.page > 1 || list.data.hasMore) && (
            <nav
              aria-label={tw("pagination.label")}
              className="flex items-center justify-center gap-3"
            >
              <Button
                size="sm"
                variant="secondary"
                disabled={filters.page <= 1}
                onClick={() => {
                  setFilters((f) => ({ ...f, page: Math.max(1, f.page - 1) }));
                }}
              >
                {tw("pagination.previous")}
              </Button>
              <span className="text-sm text-text-muted">
                {tw("inspiration.page", { page: filters.page })}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={!list.data.hasMore}
                onClick={() => {
                  setFilters((f) => ({ ...f, page: f.page + 1 }));
                }}
              >
                {tw("pagination.next")}
              </Button>
            </nav>
          )}
        </>
      )}

      <SaveInspirationDialog
        open={saveOpen}
        onClose={() => {
          setSaveOpen(false);
        }}
      />
      <RemixDialog
        item={remixing}
        onClose={() => {
          setRemixing(null);
        }}
      />
    </div>
  );
}

function ChipRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-text-muted">{label}</span>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "fg-focusable rounded-full border px-3 py-1 text-xs font-medium",
        active
          ? "border-accent bg-accent text-accent-contrast"
          : "border-border bg-surface text-text hover:bg-surface-sunken",
      )}
    >
      {children}
    </button>
  );
}
