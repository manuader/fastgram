"use client";

import { Button, EmptyState, Input, Select, cn } from "@fastgram/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiErrorState } from "./ApiErrorState";
import { MediaCard } from "./MediaCard";
import { DeleteMediaDialog, EditCategoriesDialog } from "./MediaAssetDialogs";
import {
  MediaDropTarget,
  MediaDropzone,
  UploadGlyph,
  type MediaDropTargetHandle,
} from "./MediaDropzone";
import { MediaGridSkeleton } from "./MediaGridSkeleton";
import { UploadQueue } from "./UploadQueue";
import { BrandKitButton } from "./BrandKitButton";
import { ImportFromLinkButton } from "./ImportFromLinkButton";
import { CreateSetBar } from "./CreateSetBar";
import { MediaSetsRow } from "./MediaSetsRow";
import { OwnPostsImportButton } from "./OwnPostsImportButton";
import { tw } from "@/lib/i18n/t";
import {
  MEDIA_CATEGORY_COPY,
  MEDIA_TYPES,
  MEDIA_TYPE_COPY,
  flattenMediaPages,
  useMediaList,
} from "@/lib/media/media";
import { useMediaTags } from "@/lib/media/tags";
import { useMediaUploadQueue } from "@/lib/media/upload/queue";
import { useMediaMeta } from "@/lib/media/import";
import {
  imageMediaCategorySchema,
  videoMediaCategorySchema,
  type Media,
  type MediaCategory,
  type MediaStatus,
  type MediaType,
} from "@fastgram/contracts";

const ALL_CATEGORIES: readonly MediaCategory[] = [
  ...imageMediaCategorySchema.options,
  ...videoMediaCategorySchema.options,
];

/** `""` es "sin filtro": un `<select>` no puede tener valor `undefined`. */
const ANY = "";

function isMediaType(value: string): value is MediaType {
  return (MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * `Library → My Media Bank` · FR-100 (PRD:1618-1626), §12 (PRD:2722).
 *
 * Los cuatro estados de §19, con la misma forma que `MyContentTab` — y la misma
 * razón para que el orden de las ramas sea ése:
 *
 * · **error de la primera carga** va primero y **reemplaza** la grid. Es el
 *   caso que importa en esta pantalla: una lista vacía por fallo de red y un
 *   workspace sin archivos se dibujan igual —una grid sin tarjetas— y
 *   significan lo contrario. Quien vea `No images uploaded yet` después de un
 *   timeout cree que perdió sus archivos, que en un Media Bank es lo más caro
 *   que se le puede decir a alguien.
 * · **loading** — skeleton con la forma de la grid.
 * · **empty** — ERR-E04, con su salida. Y el vacío **con el filtro puesto** no
 *   es el mismo vacío: ahí la salida es quitar el filtro.
 * · **datos** — la grid, con `Load more` contra el cursor.
 *
 * El error de un `Load more` **no** reemplaza la grid: ahí ya hay archivos en
 * pantalla y borrarlos por un fallo de la página siguiente castiga al usuario
 * por algo que no hizo.
 *
 * ## Subida (`PU-MEDIA-001`)
 *
 * Todo el panel es zona de soltar, y `Upload` abre el mismo selector múltiple.
 * La cola (`UploadQueue`) va **arriba de los cuatro estados** y no dentro de
 * ninguno: subir el primer archivo desde el vacío no puede hacer desaparecer
 * la fila que muestra su progreso cuando la grid pasa de vacía a llena.
 *
 * ## Sprint 7: búsqueda, filtros, sets y deep links
 *
 * - **Búsqueda y filtros** (`P2-MEDIA-007`): `q` (nombre o etiqueta, con
 *   debounce), tipo, categoría y chips de etiqueta —incluidas las automáticas
 *   de los clips—, todo del lado del servidor (`GET /media`).
 * - **Media Sets** (`P2-MEDIA-005/006`): fila `YOUR SETS`, y el modo
 *   `CREATING SET` con checkbox por asset y barra inferior con el contador.
 * - **`?focus=`** (`FR-100.1`, `P2-MEDIA-008`): resalta y lleva a la vista el
 *   asset pedido (lo lee `LibraryTabs`).
 * - **Import my posts** (`FR-011.5.1`, opt-in).
 *
 * El filtro por influencer sigue sin estar: `DATA-010` no relaciona un asset
 * con un personaje.
 */
export function MyMediaBankTab({ focusId = null }: { readonly focusId?: string | null }) {
  const [type, setType] = useState<MediaType | "">(ANY);
  const [category, setCategory] = useState<MediaCategory | "">(ANY);
  const [tag, setTag] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Media | null>(null);
  const [deleting, setDeleting] = useState<Media | null>(null);
  const [creatingSet, setCreatingSet] = useState(false);
  const [selection, setSelection] = useState<readonly string[]>([]);
  const dropRef = useRef<MediaDropTargetHandle>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setQ(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const query = useMediaList({
    ...(type === ANY ? {} : { type }),
    ...(category === ANY ? {} : { category }),
    ...(tag === null ? {} : { tag }),
    ...(q === "" ? {} : { q }),
  });
  const upload = useMediaUploadQueue();
  const tags = useMediaTags();

  const items = flattenMediaPages(query.data);
  const filtered = type !== ANY || category !== ANY || tag !== null || q !== "";
  const clearFilters = (): void => {
    setType(ANY);
    setCategory(ANY);
    setTag(null);
    setSearch("");
    setQ("");
  };
  const toggleSelect = (item: Media): void => {
    setSelection((current) =>
      current.includes(item.mediaId)
        ? current.filter((id) => id !== item.mediaId)
        : [...current, item.mediaId],
    );
  };
  const stopCreating = (): void => {
    setCreatingSet(false);
    setSelection([]);
  };
  // `PU-MEME-003`: etiquetas de los clips importados, para las tarjetas.
  const meta = useMediaMeta(
    items.filter((item) => item.mediaType === "video").map((item) => item.mediaId),
  );

  const liveStatus = useMemo(
    () => new Map<string, MediaStatus>(items.map((item) => [item.mediaId, item.status])),
    [items],
  );

  const openPicker = (): void => {
    dropRef.current?.openPicker();
  };

  const filters = (
    <div className="fgw-library-filters">
      <Input
        type="search"
        value={search}
        placeholder={tw("mediaBank.search.placeholder")}
        aria-label={tw("mediaBank.search.placeholder")}
        onChange={(event) => setSearch(event.target.value)}
        wrapperClassName="min-w-[12rem]"
      />
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">{tw("media.filter.typeLabel")}</span>
        <Select
          value={type}
          onChange={(event) => {
            const next = event.target.value;
            setType(isMediaType(next) ? next : ANY);
          }}
          options={[
            { value: ANY, label: tw("media.filter.allTypes") },
            ...MEDIA_TYPES.map((value) => ({
              value,
              label: tw(MEDIA_TYPE_COPY[value]),
            })),
          ]}
        />
      </label>
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">
          {tw("mediaBank.filter.categoryLabel")}
        </span>
        <Select
          value={category}
          onChange={(event) => {
            const next = ALL_CATEGORIES.find((c) => c === event.target.value);
            setCategory(next ?? ANY);
          }}
          options={[
            { value: ANY, label: tw("mediaBank.filter.allCategories") },
            ...ALL_CATEGORIES.map((value) => ({
              value,
              label: tw(MEDIA_CATEGORY_COPY[value]),
            })),
          ]}
        />
      </label>
      <span className="fgw-library-filters__count">
        {query.isSuccess
          ? items.length === 1 && !query.hasNextPage
            ? tw("media.itemCountOne")
            : tw(query.hasNextPage ? "media.itemCountPartial" : "media.itemCount", {
                count: items.length,
              })
          : null}
      </span>
      <span className="ml-auto flex items-start gap-2">
        <BrandKitButton />
        <ImportFromLinkButton />
        <OwnPostsImportButton />
        <Button
          size="sm"
          leadingIcon={<UploadGlyph className="h-4 w-4" />}
          onClick={openPicker}
        >
          {tw("mediaUpload.upload")}
        </Button>
      </span>
    </div>
  );

  const tagList = Array.isArray(tags.data) ? tags.data : [];
  const tagChips =
    tagList.length > 0 ? (
      <div
        className="mb-3 flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label={tw("mediaBank.tags.filterLabel")}
      >
        {tagList.map((t) => (
          <button
            key={t.tag}
            type="button"
            aria-pressed={tag === t.tag}
            className={cn(
              "fg-focusable rounded-full border px-2.5 py-0.5 text-xs",
              tag === t.tag
                ? "border-accent bg-accent-subtle text-text"
                : "border-border text-text-muted hover:border-border-strong",
            )}
            onClick={() => setTag((current) => (current === t.tag ? null : t.tag))}
          >
            {`#${t.tag}`}
            <span className="ml-1 opacity-60">{String(t.count)}</span>
          </button>
        ))}
      </div>
    ) : null;

  return (
    <MediaDropTarget ref={dropRef} onFiles={upload.add}>
      <div className="fgw-library-panel" aria-busy={query.isPending ? "true" : undefined}>
        <MediaSetsRow
          creating={creatingSet}
          onNewSet={() => {
            setSelection([]);
            setCreatingSet(true);
          }}
        />
        {filters}
        {tagChips}
        <UploadQueue queue={upload} liveStatus={liveStatus} />
        {renderBody()}
        {creatingSet && <div className="h-24" aria-hidden />}
      </div>
      <EditCategoriesDialog
        item={editing}
        onClose={() => {
          setEditing(null);
        }}
      />
      <DeleteMediaDialog
        item={deleting}
        onClose={() => {
          setDeleting(null);
        }}
      />
      {creatingSet && (
        <CreateSetBar
          selectedIds={selection}
          onCancel={stopCreating}
          onSaved={stopCreating}
        />
      )}
    </MediaDropTarget>
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
          icon={<UploadGlyph className="h-8 w-8" />}
          title={tw("media.empty.title")}
          description={
            filtered
              ? tw("media.empty.filteredDescription")
              : tw("mediaUpload.empty.description")
          }
          action={
            filtered ? (
              <Button variant="secondary" onClick={clearFilters}>
                {tw("media.empty.clearFilters")}
              </Button>
            ) : (
              <span className="flex flex-wrap items-start justify-center gap-3">
                <Button
                  size="lg"
                  leadingIcon={<UploadGlyph className="h-5 w-5" />}
                  onClick={openPicker}
                >
                  {tw("mediaUpload.empty.action")}
                </Button>
                <BrandKitButton size="lg" />
                <ImportFromLinkButton size="lg" />
                <OwnPostsImportButton size="lg" />
              </span>
            )
          }
        />
      );
    }

    return (
      <>
        <MediaDropzone onBrowse={openPicker} />
        <ul className="fgw-media-grid">
          {items.map((item) => (
            <MediaCard
              key={item.mediaId}
              item={item}
              onEditCategories={setEditing}
              onDelete={setDeleting}
              tags={meta.get(item.mediaId)?.tags?.tags}
              focused={focusId === item.mediaId}
              {...(creatingSet
                ? {
                    selected: selection.includes(item.mediaId),
                    onToggleSelect: toggleSelect,
                  }
                : {})}
            />
          ))}
        </ul>

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
              {tw(query.isFetchingNextPage ? "media.loadingMore" : "media.loadMore")}
            </Button>
          </div>
        )}
      </>
    );
  }
}
