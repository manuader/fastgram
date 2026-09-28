"use client";

/**
 * `GlobalLibraryPicker` — modal reutilizable para elegir un asset **listo** de
 * la biblioteca global. Lo monta el editor (otro agente); esta pantalla no
 * sabe nada del editor.
 *
 * ## Props
 *
 * - `open: boolean` — controlado desde afuera.
 * - `onOpenChange(open: boolean): void` — se llama con `false` al cerrar (×,
 *   Escape, click fuera) y después de elegir.
 * - `kinds?: readonly LibraryAssetKind[]` — sólo estos tipos (p. ej.
 *   `["green_screen_video"]` para el hueco de un meme). Sin `kinds`, todos.
 *   Si hay más de uno, aparece un selector para acotar.
 * - `onPick(asset: LibraryAsset): void` — el asset elegido, entero (tiene
 *   `url`, `durationSec`, `metadata`…). Elegir **no** lo copia a la marca: si
 *   el editor necesita una fila del Media Bank, que llame a
 *   `POST /library/assets/{id}/use-in-brand` (`useUseInBrand` de `./api`).
 * - `title?: string` — el título del modal; por defecto «Global library».
 *
 * Sólo muestra `status: ready`: se pide `status=ready` al servidor y además se
 * filtra en el cliente, porque un asset que procesa no tiene `url` y el
 * editor no tendría qué poner. Por lo mismo se filtran los `kinds` también en
 * el cliente: si el servidor devolviera de más, el editor igual recibe sólo
 * lo que pidió.
 *
 * Usa el `Dialog` de `@fastgram/ui`, que no apila modales: no montarlo dentro
 * de otro `Dialog` abierto.
 */
import {
  LIBRARY_ASSET_KINDS,
  type LibraryAsset,
  type LibraryAssetKind,
} from "@fastgram/contracts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Select,
  Skeleton,
} from "@fastgram/ui";
import { useEffect, useMemo, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { LayersIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { EMPTY_LIBRARY_FILTERS, flattenLibraryPages, useLibraryAssets } from "./api";
import { KIND_COPY } from "./copy";
import { AssetPreview, KindBadge, LicenseLine, formatDuration } from "./parts";

export interface GlobalLibraryPickerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly kinds?: readonly LibraryAssetKind[];
  readonly onPick: (asset: LibraryAsset) => void;
  readonly title?: string;
}

const READY = ["ready"] as const;

export function GlobalLibraryPicker({
  open,
  onOpenChange,
  kinds,
  onPick,
  title,
}: GlobalLibraryPickerProps) {
  const close = () => {
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onClose={close} size="xl">
      <DialogHeader>
        <DialogTitle>{title ?? tw("globalLibrary.picker.title")}</DialogTitle>
        <DialogClose label={tw("globalLibrary.close")} />
      </DialogHeader>
      <DialogBody>
        {/* El cuerpo sólo existe abierto: cerrado no pide nada a la API. */}
        {open && (
          <PickerBody
            kinds={kinds}
            onPick={(asset) => {
              onPick(asset);
              close();
            }}
          />
        )}
      </DialogBody>
    </Dialog>
  );
}

function PickerBody({
  kinds,
  onPick,
}: {
  readonly kinds: readonly LibraryAssetKind[] | undefined;
  readonly onPick: (asset: LibraryAsset) => void;
}) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<LibraryAssetKind | "">("");
  useEffect(() => {
    const id = window.setTimeout(() => {
      setQ(search.trim());
    }, 300);
    return () => {
      window.clearTimeout(id);
    };
  }, [search]);

  const allowed = useMemo(() => kinds ?? [], [kinds]);
  const choices: readonly LibraryAssetKind[] =
    allowed.length === 0 ? LIBRARY_ASSET_KINDS : allowed;
  const effectiveKinds: readonly LibraryAssetKind[] = only === "" ? allowed : [only];
  const query = useLibraryAssets({
    ...EMPTY_LIBRARY_FILTERS,
    q,
    kinds: effectiveKinds,
    statuses: READY,
  });
  const items = flattenLibraryPages(query.data).filter(
    (a) =>
      a.status === "ready" &&
      a.url !== null &&
      (effectiveKinds.length === 0 || effectiveKinds.includes(a.kind)),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Input
          type="search"
          value={search}
          placeholder={tw("globalLibrary.filter.search")}
          aria-label={tw("globalLibrary.filter.search")}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
          wrapperClassName="min-w-[12rem] flex-1"
        />
        {allowed.length !== 1 && (
          <Select
            value={only}
            aria-label={tw("globalLibrary.filter.kind")}
            onChange={(e) => {
              setOnly(choices.find((k) => k === e.target.value) ?? "");
            }}
            options={[
              { value: "", label: tw("globalLibrary.filter.any") },
              ...choices.map((k) => ({ value: k, label: tw(KIND_COPY[k]) })),
            ]}
          />
        )}
      </div>

      {query.isError && items.length === 0 ? (
        <ApiErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<LayersIcon size={20} />}
          title={tw("globalLibrary.picker.emptyTitle")}
          description={tw("globalLibrary.picker.emptyBody")}
        />
      ) : (
        <>
          <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4">
            {items.map((asset) => {
              const duration = formatDuration(asset.durationSec);
              return (
                <li
                  key={asset.id}
                  className="flex flex-col overflow-hidden rounded-xl border border-border"
                  data-testid="picker-item"
                >
                  <AssetPreview asset={asset} compact />
                  <div className="flex flex-1 flex-col gap-1 p-2">
                    <span
                      className="truncate text-sm font-medium text-text"
                      title={asset.title}
                    >
                      {asset.title}
                    </span>
                    <span className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
                      <KindBadge asset={asset} />
                      {duration}
                    </span>
                    <LicenseLine asset={asset} />
                    <Button
                      size="sm"
                      className="mt-auto"
                      aria-label={tw("globalLibrary.picker.pickFor", {
                        title: asset.title,
                      })}
                      onClick={() => {
                        onPick(asset);
                      }}
                    >
                      {tw("globalLibrary.picker.pick")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
          {query.hasNextPage && (
            <div className="flex justify-center">
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
      )}
    </div>
  );
}
