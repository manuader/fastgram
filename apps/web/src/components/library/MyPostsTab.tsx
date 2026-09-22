"use client";

import { Button, EmptyState, Select, buttonVariants } from "@fastgram/ui";
import Link from "next/link";
import { useState } from "react";
import { ApiErrorState } from "./ApiErrorState";
import { PostCard } from "./PostCard";
import { PostGridSkeleton } from "./PostGridSkeleton";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import {
  flattenPostPages,
  hasBuildingPost,
  POST_STATUS_COPY,
  POST_STATUS_FILTERS,
  usePostsList,
} from "@/lib/library/posts";
import type { PostStatusFilter } from "@fastgram/contracts";

/** `""` es "sin filtro": un `<select>` no puede tener valor `undefined`. */
const ANY = "";

function isPostStatusFilter(value: string): value is PostStatusFilter {
  return (POST_STATUS_FILTERS as readonly string[]).includes(value);
}

/**
 * `Library → My Posts` · F-120 (PRD:592), FR-100 (PRD:1603-1611).
 *
 * Los cuatro estados de §19, con el **mismo orden de ramas** que `MyContentTab`
 * y `MyMediaBankTab`, y por la misma razón:
 *
 * · **error de la primera carga** va primero y **reemplaza** la grid. Es el
 *   caso que importa: una lista vacía por fallo de red y un workspace sin posts
 *   se dibujan igual —una grid sin tarjetas— y significan lo contrario. Quien
 *   vea `No posts` después de un timeout cree que se perdió lo que tenía
 *   programado, y en esta tab eso incluye publicaciones futuras.
 * · **loading** — skeleton con la forma de la grid.
 * · **empty** — `No posts` (literal §12, PRD:2729), con su salida. Y el vacío
 *   **con el filtro puesto** no es el mismo vacío: ahí la salida es quitarlo.
 * · **datos** — la grid, con `Load more` contra el cursor.
 *
 * El error de un `Load more` **no** reemplaza la grid: ahí ya hay posts en
 * pantalla y borrarlos por un fallo de la página siguiente castiga al usuario
 * por algo que no hizo.
 *
 * ## Lo que esta tab no hace, y por qué no se inventa
 *
 * - **No hay `Refresh Metrics`** (PRD:1605). Es `P2-LIB-004`, tiene su propio
 *   endpoint (`POST /analytics/posts`) y es una escritura: el puente del
 *   navegador hacia la API es hoy de sólo lectura.
 * - **No hay `Select` ni acciones en lote** (PRD:1605, 1611). `POST /posts/cancel`
 *   y `POST /posts/delete` son mutaciones, mismo motivo.
 * - **No hay filtro por plataforma.** `listPostsQuerySchema` es `.strict()` y
 *   sólo contrata `status`: mandar `platform=` sería un `400`.
 * - **No se puede filtrar por `CANCELLED`.** El contrato copia la lista de §12,
 *   que lo omite aunque sea un estado válido. Los posts cancelados sí aparecen
 *   en la lista sin filtrar.
 */
export function MyPostsTab() {
  const [status, setStatus] = useState<PostStatusFilter | "">(ANY);

  const query = usePostsList(status === ANY ? {} : { status });

  const items = flattenPostPages(query.data);
  const filtered = status !== ANY;
  const building = hasBuildingPost(items);

  const filters = (
    <div className="fgw-library-filters">
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">
          {tw("posts.filter.statusLabel")}
        </span>
        <Select
          value={status}
          onChange={(event) => {
            const next = event.target.value;
            setStatus(isPostStatusFilter(next) ? next : ANY);
          }}
          options={[
            { value: ANY, label: tw("posts.filter.allStatuses") },
            ...POST_STATUS_FILTERS.map((value) => ({
              value,
              label: tw(POST_STATUS_COPY[value]),
            })),
          ]}
        />
      </label>
      <span className="fgw-library-filters__count">
        {query.isSuccess
          ? items.length === 1 && !query.hasNextPage
            ? tw("posts.countOne")
            : tw(query.hasNextPage ? "posts.countPartial" : "posts.count", {
                count: items.length,
              })
          : null}
      </span>
    </div>
  );

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
        <PostGridSkeleton />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="fgw-library-panel">
        {filters}
        <EmptyState
          bordered
          title={tw("posts.empty.title")}
          description={
            filtered
              ? tw("posts.empty.filteredDescription")
              : tw("posts.empty.description")
          }
          action={
            filtered ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setStatus(ANY);
                }}
              >
                {tw("posts.empty.clearFilter")}
              </Button>
            ) : (
              // Un post nace al programar una pieza de contenido (FR-060,
              // PRD:1377), así que la salida de un workspace sin posts es ir a
              // crear contenido, no a una pantalla de "nuevo post" que no
              // existe.
              <Link href={ROUTES.content} className={buttonVariants()}>
                {tw("posts.empty.action")}
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
      <p className="fgw-library-note">{tw("posts.noContentFields")}</p>
      <ul
        className="fgw-post-grid"
        // Mientras algo se construye, la lista cambia sola cada 10 s. Sin esto,
        // ese cambio no existe para quien usa un lector de pantalla.
        aria-live={building ? "polite" : "off"}
      >
        {items.map((item) => (
          <PostCard key={item._id} item={item} />
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
            {tw(query.isFetchingNextPage ? "posts.loadingMore" : "posts.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
