"use client";

import { Button, EmptyState, Select, buttonVariants } from "@fastgram/ui";
import Link from "next/link";
import { useState } from "react";
import { ApiErrorState } from "./ApiErrorState";
import { ContentCard } from "./ContentCard";
import { ContentGridSkeleton } from "./ContentGridSkeleton";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import {
  CONTENT_STATUS_COPY,
  CONTENT_STATUSES,
  CONTENT_TYPE_COPY,
  CONTENT_TYPES,
  flattenPages,
  hasBuildingPiece,
  useContentList,
} from "@/lib/library/content";
import type { ContentStatus, ContentType } from "@fastgram/contracts";

/** `""` es "sin filtro": un `<select>` no puede tener valor `undefined`. */
const ANY = "";

function isContentType(value: string): value is ContentType {
  return (CONTENT_TYPES as readonly string[]).includes(value);
}

function isContentStatus(value: string): value is ContentStatus {
  return (CONTENT_STATUSES as readonly string[]).includes(value);
}

/**
 * `Library → My Content` · FR-100 (PRD:1611-1613), §12 (PRD:2730).
 *
 * Los cuatro estados de §19 están los cuatro, y ninguno es decorativo:
 *
 * · **loading** — skeleton con la forma de la grid (`ContentGridSkeleton`).
 * · **empty** — con su copy y su salida: un vacío sin acción es una pantalla
 *   muerta. Y el vacío **con filtros puestos** no es el mismo vacío: ahí la
 *   salida es quitar el filtro, no ir a crear contenido.
 * · **error** — `ApiErrorState`, que decide la salida por el código (§19.8).
 * · **datos** — la grid, con `Load more` de verdad contra el cursor.
 *
 * El polling vive en `useContentList` (ADR-014). Acá sólo se refleja: mientras
 * haya una pieza en `BUILDING`, la región se marca `aria-live="polite"` para
 * que un cambio de estado que ocurre **solo**, sin que nadie toque nada, no
 * pase desapercibido a quien no mira la pantalla.
 */
export function MyContentTab() {
  const [type, setType] = useState<ContentType | "">(ANY);
  const [status, setStatus] = useState<ContentStatus | "">(ANY);

  const query = useContentList({
    ...(type === ANY ? {} : { type }),
    ...(status === ANY ? {} : { status }),
  });

  const items = flattenPages(query.data);
  const filtered = type !== ANY || status !== ANY;
  const building = hasBuildingPiece(items);

  const filters = (
    <div className="fgw-library-filters">
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">
          {tw("library.filter.typeLabel")}
        </span>
        <Select
          value={type}
          onChange={(event) => {
            const next = event.target.value;
            setType(isContentType(next) ? next : ANY);
          }}
          options={[
            { value: ANY, label: tw("library.filter.allTypes") },
            ...CONTENT_TYPES.map((value) => ({
              value,
              label: tw(CONTENT_TYPE_COPY[value]),
            })),
          ]}
        />
      </label>
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">
          {tw("library.filter.statusLabel")}
        </span>
        <Select
          value={status}
          onChange={(event) => {
            const next = event.target.value;
            setStatus(isContentStatus(next) ? next : ANY);
          }}
          options={[
            { value: ANY, label: tw("library.filter.allStatuses") },
            ...CONTENT_STATUSES.map((value) => ({
              value,
              label: tw(CONTENT_STATUS_COPY[value]),
            })),
          ]}
        />
      </label>
      <span className="fgw-library-filters__count">
        {query.isSuccess
          ? items.length === 1 && !query.hasNextPage
            ? tw("library.itemCountOne")
            : tw(query.hasNextPage ? "library.itemCountPartial" : "library.itemCount", {
                count: items.length,
              })
          : null}
      </span>
    </div>
  );

  // El error de la **primera** carga reemplaza la grid. El de un `Load more`
  // no: ahí ya hay contenido en pantalla y borrarlo por un fallo de la página
  // siguiente castiga al usuario por algo que no hizo.
  if (query.isError && items.length === 0) {
    return (
      <div className="fgw-library-panel">
        {filters}
        <ApiErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </div>
    );
  }

  if (query.isPending) {
    return (
      <div className="fgw-library-panel" aria-busy="true">
        {filters}
        <ContentGridSkeleton />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="fgw-library-panel">
        {filters}
        <EmptyState
          bordered
          title={tw("library.empty.title")}
          description={
            filtered
              ? tw("library.empty.filteredDescription")
              : tw("library.empty.description")
          }
          action={
            filtered ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setType(ANY);
                  setStatus(ANY);
                }}
              >
                {tw("library.empty.clearFilters")}
              </Button>
            ) : (
              <Link href={ROUTES.content} className={buttonVariants()}>
                {tw("library.empty.action")}
              </Link>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="fgw-library-panel">
      {filters}
      <p className="fgw-library-note">{tw("library.noCreatedAt")}</p>
      <ul
        className="fgw-content-grid"
        // Mientras algo se construye, la lista cambia sola cada 10 s. Sin esto,
        // ese cambio no existe para quien usa un lector de pantalla.
        aria-live={building ? "polite" : "off"}
      >
        {items.map((item) => (
          <ContentCard key={item._id} item={item} />
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
            {tw(query.isFetchingNextPage ? "library.loadingMore" : "library.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
