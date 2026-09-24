"use client";

import { Button, EmptyState, Select } from "@fastgram/ui";
import { useMemo, useRef, useState } from "react";
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
import { tw } from "@/lib/i18n/t";
import {
  MEDIA_TYPES,
  MEDIA_TYPE_COPY,
  flattenMediaPages,
  useMediaList,
} from "@/lib/media/media";
import { useMediaUploadQueue } from "@/lib/media/upload/queue";
import type { Media, MediaStatus, MediaType } from "@fastgram/contracts";

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
 * ## Lo que esta tab no hace, y por qué no se inventa
 *
 * - **No están los filtros ricos de `P2-MEDIA-007`** (categoría, influencer,
 *   búsqueda). El contrato no tiene parámetro para ninguno y `listMediaQuery`
 *   es `.strict()`: mandarlos sería un `400`.
 * - **No están los Media Sets ni el modo `CREATING SET`.** Son `P2-MEDIA-005` y
 *   `P2-MEDIA-006`, con su propio recurso.
 */
export function MyMediaBankTab() {
  const [type, setType] = useState<MediaType | "">(ANY);
  const [editing, setEditing] = useState<Media | null>(null);
  const [deleting, setDeleting] = useState<Media | null>(null);
  const dropRef = useRef<MediaDropTargetHandle>(null);

  const query = useMediaList(type === ANY ? {} : { type });
  const upload = useMediaUploadQueue();

  const items = flattenMediaPages(query.data);
  const filtered = type !== ANY;

  const liveStatus = useMemo(
    () => new Map<string, MediaStatus>(items.map((item) => [item.mediaId, item.status])),
    [items],
  );

  const openPicker = (): void => {
    dropRef.current?.openPicker();
  };

  const filters = (
    <div className="fgw-library-filters">
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
      <span className="fgw-library-filters__count">
        {query.isSuccess
          ? items.length === 1 && !query.hasNextPage
            ? tw("media.itemCountOne")
            : tw(query.hasNextPage ? "media.itemCountPartial" : "media.itemCount", {
                count: items.length,
              })
          : null}
      </span>
      <Button
        size="sm"
        className="ml-auto"
        leadingIcon={<UploadGlyph className="h-4 w-4" />}
        onClick={openPicker}
      >
        {tw("mediaUpload.upload")}
      </Button>
    </div>
  );

  return (
    <MediaDropTarget ref={dropRef} onFiles={upload.add}>
      <div className="fgw-library-panel" aria-busy={query.isPending ? "true" : undefined}>
        {filters}
        <UploadQueue queue={upload} liveStatus={liveStatus} />
        {renderBody()}
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
              <Button
                variant="secondary"
                onClick={() => {
                  setType(ANY);
                }}
              >
                {tw("media.empty.clearFilters")}
              </Button>
            ) : (
              <Button
                size="lg"
                leadingIcon={<UploadGlyph className="h-5 w-5" />}
                onClick={openPicker}
              >
                {tw("mediaUpload.empty.action")}
              </Button>
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
